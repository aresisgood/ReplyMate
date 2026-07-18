"use client";

// 聊天介面（client component）：對話列表 + 訊息視窗 + 2 秒輪詢（架構 §3 F3）
// + AI 協助草稿卡（F1）+ 自動回覆開關（F4）。
// 輪詢游標與訊息合併的純邏輯抽到 lib/chat/timeline.ts（見該檔說明游標語意）。
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { advanceCursor, mergeById, type TimelineMessage } from "@/lib/chat/timeline";
import CategoryPicker, { type CategoryOption } from "../components/CategoryPicker";

const POLL_INTERVAL_MS = 2000;

interface ConversationSummary {
  conversationId: string;
  counterpartId: string;
  counterpartName: string;
  lastMessageText: string | null;
  lastActivityMs: number;
  autoReply: boolean;
  styleCategoryId: string | null;
  styleCategoryName: string | null;
}

type ChatMessage = TimelineMessage;

// 進行中的一次 AI 協助
interface ActiveDraft {
  draftId: string;
  aiDraft: string; // 引擎的原始輸出（用於顯示「已編輯」提示）
  text: string; // 使用者編輯後的內容
}

interface Props {
  me: { id: string; displayName: string };
  initialConversations: ConversationSummary[];
}

export default function ChatApp({ me, initialConversations }: Props) {
  const router = useRouter();
  const [conversations, setConversations] = useState(initialConversations);
  const [activeId, setActiveId] = useState<string | null>(
    initialConversations[0]?.conversationId ?? null
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const [aiDraft, setAiDraft] = useState<ActiveDraft | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [categoriesLoaded, setCategoriesLoaded] = useState(false);
  // 單一錯誤列，承載送訊／草稿／設定三條路徑的失敗訊息。任何一條失敗都必須
  // 讓使用者看見——靜默失敗會讓人以為訊息已經送出（coding-style：絕不靜默吞噬錯誤）。
  const [error, setError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  // 輪詢游標：已從伺服器查詢到的最新訊息時間（用 ref 讓 interval 不必依賴 messages 重建）。
  // 刻意不等同「畫面上最後一則訊息」—— 自己送出的訊息不推進游標，理由見 timeline.ts。
  const cursorRef = useRef<number | undefined>(undefined);

  const active = conversations.find((c) => c.conversationId === activeId) ?? null;

  // 最後一則「對方」的訊息 —— AI 協助只對它有意義（不能對自己的訊息代筆）
  const lastIncoming = [...messages].reverse().find((m) => m.senderId !== me.id) ?? null;

  const fetchMessages = useCallback(
    async (conversationId: string, afterMs?: number) => {
      const qs = afterMs !== undefined ? `?after=${afterMs}` : "";
      const res = await fetch(`/api/conversations/${conversationId}/messages${qs}`);
      if (res.status === 401) {
        router.push("/login");
        return [];
      }
      if (!res.ok) return [];
      const body = (await res.json()) as { messages: ChatMessage[] };
      return body.messages;
    },
    [router]
  );

  // 切換對話：清空游標、訊息與草稿，全量載入
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    setMessages([]);
    setAiDraft(null);
    setError(null);
    cursorRef.current = undefined;
    fetchMessages(activeId).then((msgs) => {
      if (cancelled) return;
      setMessages(msgs);
      cursorRef.current = advanceCursor(undefined, msgs);
    });
    return () => {
      cancelled = true;
    };
  }, [activeId, fetchMessages]);

  // 2 秒輪詢增量。游標只在這裡（與初次載入）推進 —— 見 lib/chat/timeline.ts
  useEffect(() => {
    if (!activeId) return;
    // clearInterval 只能擋未來的 tick，無法中止已在 await 中的那一次回呼。
    // 切換對話後，飛行中的舊查詢 resolve 時 activeId 已變，若不丟棄會把舊對話
    // 的訊息併進新對話、並用舊時間覆寫共用游標（審查 H-1）。
    let cancelled = false;
    const timer = setInterval(async () => {
      const incoming = await fetchMessages(activeId, cursorRef.current);
      if (cancelled) return;
      if (incoming.length > 0) {
        cursorRef.current = advanceCursor(cursorRef.current, incoming);
        setMessages((latest) => mergeById(latest, incoming));
      }
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeId, fetchMessages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, aiDraft]);

  // 側欄預覽同步：新訊息（送出/輪詢/自動回覆）進來時，更新對應對話的最後一則
  // 預覽與活動時間，避免側欄停在初始快照（審查 M-3）。不重排以免使用者閱讀中
  // 的對話跳位。
  useEffect(() => {
    if (!activeId || messages.length === 0) return;
    const last = messages[messages.length - 1];
    setConversations((list) =>
      list.map((c) =>
        c.conversationId === activeId
          ? { ...c, lastMessageText: last.text, lastActivityMs: last.createdAtMs }
          : c
      )
    );
  }, [messages, activeId]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!activeId || !draft.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${activeId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: draft }),
      });
      if (!res.ok) {
        // 失敗時保留輸入框內容，讓使用者可以直接重送。
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "訊息送出失敗，請稍後再試");
        return;
      }
      const body = (await res.json()) as { message: ChatMessage };
      // 樂觀併入畫面，但不推進游標（見 timeline.ts）
      setMessages((latest) => mergeById(latest, [body.message]));
      setDraft("");
    } catch {
      setError("無法連線到伺服器");
    } finally {
      setSending(false);
    }
  }

  // 請 AI 依本人語氣草擬一則回覆
  async function handleAskAi() {
    if (!lastIncoming || aiLoading) return;
    setAiLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/drafts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: lastIncoming.id }),
      });
      const body = (await res.json().catch(() => null)) as
        | { draftId: string; aiDraft: string; error?: string }
        | null;

      if (!res.ok || !body?.draftId) {
        setError(body?.error ?? "草稿生成失敗，請稍後再試");
        return;
      }
      setAiDraft({ draftId: body.draftId, aiDraft: body.aiDraft, text: body.aiDraft });
    } catch {
      setError("無法連線到伺服器");
    } finally {
      setAiLoading(false);
    }
  }

  // 確認送出草稿（定稿）—— 後端據此判定是否採用（成功指標 2）
  async function handleAdoptDraft() {
    if (!aiDraft || !aiDraft.text.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/drafts/${aiDraft.draftId}/finalize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ finalText: aiDraft.text }),
      });
      if (!res.ok) {
        // 草稿卡保留在畫面上，使用者可修改後重試。
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "送出失敗，請稍後再試");
        return;
      }
      const body = (await res.json()) as { message: ChatMessage };
      setMessages((latest) => mergeById(latest, [body.message]));
      setAiDraft(null);
    } catch {
      setError("無法連線到伺服器");
    } finally {
      setSending(false);
    }
  }

  async function handleToggleAutoReply() {
    if (!active) return;
    const next = !active.autoReply;
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${active.conversationId}/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoReply: next }),
      });
      if (res.ok) {
        setConversations((list) =>
          list.map((c) =>
            c.conversationId === active.conversationId ? { ...c, autoReply: next } : c
          )
        );
      } else {
        setError("自動回覆設定變更失敗，請稍後再試");
      }
    } catch {
      setError("無法連線到伺服器");
    }
  }

  async function loadCategories() {
    if (categoriesLoaded) return;
    try {
      const res = await fetch("/api/categories");
      if (res.ok) {
        const body = (await res.json()) as { categories: CategoryOption[] };
        setCategories(body.categories);
        setCategoriesLoaded(true);
      }
    } catch {
      // 展開時載入失敗維持現狀；下次展開重試
    }
  }

  async function handleCreateCategory(name: string): Promise<CategoryOption | null> {
    setError(null);
    try {
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = (await res.json().catch(() => null)) as
        | { id?: string; name?: string; error?: string }
        | null;
      if (!res.ok || !body?.id || !body.name) {
        setError(body?.error ?? "分類建立失敗，請稍後再試");
        return null;
      }
      const created = { id: body.id, name: body.name };
      setCategories((list) => [...list, created]);
      return created;
    } catch {
      setError("無法連線到伺服器");
      return null;
    }
  }

  async function handleRenameCategory(id: string, name: string): Promise<boolean> {
    setError(null);
    try {
      const res = await fetch(`/api/categories/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = (await res.json().catch(() => null)) as
        | { name?: string; error?: string }
        | null;
      if (!res.ok || !body?.name) {
        setError(body?.error ?? "分類改名失敗，請稍後再試");
        return false;
      }
      const newName = body.name;
      setCategories((list) => list.map((c) => (c.id === id ? { id, name: newName } : c)));
      // 已套用此分類的對話按鈕名稱同步更新
      setConversations((list) =>
        list.map((c) =>
          c.styleCategoryId === id ? { ...c, styleCategoryName: newName } : c
        )
      );
      return true;
    } catch {
      setError("無法連線到伺服器");
      return false;
    }
  }

  async function handleSelectCategory(category: CategoryOption | null) {
    if (!active) return;
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${active.conversationId}/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ styleCategoryId: category?.id ?? null }),
      });
      if (res.ok) {
        setConversations((list) =>
          list.map((c) =>
            c.conversationId === active.conversationId
              ? {
                  ...c,
                  styleCategoryId: category?.id ?? null,
                  styleCategoryName: category?.name ?? null,
                }
              : c
          )
        );
      } else {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "語料分類設定失敗，請稍後再試");
      }
    } catch {
      setError("無法連線到伺服器");
    }
  }

  async function handleLogout() {
    // 登出失敗（例如離線）不該把使用者卡在聊天畫面：cookie 清除是伺服器端的
    // 事，但導回登入頁至少讓他能重試登入。
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // 忽略網路錯誤，仍然導頁
    }
    router.push("/login");
  }

  const edited = aiDraft !== null && aiDraft.text.trim() !== aiDraft.aiDraft.trim();

  return (
    <main className="flex h-screen bg-gray-100">
      {/* 對話列表 */}
      <aside className="flex w-64 flex-col border-r border-gray-200 bg-white">
        <div className="flex items-center justify-between border-b border-gray-200 p-4">
          <div>
            <p className="text-sm font-semibold">{me.displayName}</p>
            <p className="text-xs text-gray-400">ReplyMate</p>
          </div>
          <div className="flex items-center gap-1">
            <Link
              href="/settings"
              className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
            >
              設定
            </Link>
            <button
              onClick={handleLogout}
              className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
            >
              登出
            </button>
          </div>
        </div>
        <ul className="flex-1 overflow-y-auto">
          {conversations.map((c) => (
            <li key={c.conversationId}>
              <button
                onClick={() => setActiveId(c.conversationId)}
                className={`w-full px-4 py-3 text-left hover:bg-gray-50 ${
                  c.conversationId === activeId ? "bg-blue-50" : ""
                }`}
              >
                <p className="flex items-center gap-1 text-sm font-medium">
                  {c.counterpartName}
                  {c.autoReply && <span title="自動回覆已開啟">🤖</span>}
                </p>
                <p className="truncate text-xs text-gray-500">
                  {c.lastMessageText ?? "（尚無訊息）"}
                </p>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* 訊息視窗 */}
      <section className="flex flex-1 flex-col">
        {active ? (
          <>
            <header className="flex items-center justify-between border-b border-gray-200 bg-white p-4">
              <p className="text-sm font-semibold">{active.counterpartName}</p>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-gray-600">
                <input
                  type="checkbox"
                  checked={active.autoReply}
                  onChange={handleToggleAutoReply}
                  className="h-4 w-4"
                />
                自動回覆
              </label>
            </header>

            {/* 自動模式風險必須可見（架構 §8） */}
            {active.autoReply && (
              <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
                ⚠️ 自動回覆已開啟：{active.counterpartName} 傳來訊息時，AI 會以你的語氣直接回覆，不再等你確認。
              </div>
            )}

            <div className="flex-1 space-y-2 overflow-y-auto p-4">
              {messages.map((m) => {
                const mine = m.senderId === me.id;
                return (
                  <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[70%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm ${
                        mine ? "bg-blue-600 text-white" : "bg-white text-gray-900"
                      }`}
                    >
                      {m.text}
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>

            {error && (
              <div
                role="alert"
                className="border-t border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700"
              >
                {error}
              </div>
            )}

            {/* AI 草稿卡：可編輯後再送出，人保有最終決定權 */}
            {aiDraft && (
              <div className="border-t border-blue-200 bg-blue-50 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-medium text-blue-800">
                    AI 草稿（以你的語氣）{edited && <span className="text-blue-500">・已編輯</span>}
                  </p>
                  <button
                    onClick={() => setAiDraft(null)}
                    className="text-xs text-gray-500 hover:text-gray-700"
                  >
                    捨棄
                  </button>
                </div>
                <textarea
                  value={aiDraft.text}
                  onChange={(e) => setAiDraft({ ...aiDraft, text: e.target.value })}
                  rows={3}
                  className="w-full resize-none rounded-lg border border-blue-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
                <button
                  onClick={handleAdoptDraft}
                  disabled={!aiDraft.text.trim() || sending}
                  className="mt-2 rounded-full bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {sending ? "送出中…" : "確認送出"}
                </button>
              </div>
            )}

            <form onSubmit={handleSend} className="flex gap-2 border-t border-gray-200 bg-white p-4">
              <CategoryPicker
                categories={categories}
                valueId={active.styleCategoryId}
                valueName={active.styleCategoryName ?? "通用"}
                onOpen={loadCategories}
                onSelect={handleSelectCategory}
                onCreate={handleCreateCategory}
                onRename={handleRenameCategory}
                direction="up"
              />
              <button
                type="button"
                onClick={handleAskAi}
                disabled={!lastIncoming || aiLoading || aiDraft !== null}
                title={lastIncoming ? "請 AI 依你的語氣草擬回覆" : "還沒有可回覆的來訊"}
                className="rounded-full border border-blue-600 px-4 py-2 text-sm font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-40"
              >
                {aiLoading ? "生成中…" : "AI 協助"}
              </button>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="輸入訊息…"
                className="flex-1 rounded-full border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={!draft.trim() || sending}
                className="rounded-full bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                送出
              </button>
            </form>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
            尚無對話
          </div>
        )}
      </section>
    </main>
  );
}
