// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ChatApp from "./ChatApp";

// --- next/navigation mock ---
// router 物件必須「跨 render 穩定」：ChatApp 的 fetchMessages 是 useCallback([router])，
// 若每次 render 都回傳新物件，fetchMessages identity 會變 → 依賴它的 effect 反覆重跑
// → setMessages → re-render → 無限迴圈（同步卡死，連 test timeout 都不會觸發）。
// 真實的 next/navigation useRouter 回傳穩定物件，故此處以 vi.hoisted 固定一份。
const { push, refresh, router } = vi.hoisted(() => {
  const push = vi.fn();
  const refresh = vi.fn();
  return { push, refresh, router: { push, refresh } };
});
vi.mock("next/navigation", () => ({ useRouter: () => router }));

// --- 型別 ---
interface Msg {
  id: string;
  conversationId: string;
  senderId: string;
  text: string;
  createdAtMs: number;
}

const ME = { id: "u-me", displayName: "賴庭右" };

function conversations() {
  return [
    {
      conversationId: "c1",
      counterpartId: "u-boss",
      counterpartName: "王主管",
      lastMessageText: "急件",
      lastActivityMs: 1000,
      autoReply: false,
      styleCategoryId: null as string | null,
      styleCategoryName: null as string | null,
    },
    {
      conversationId: "c2",
      counterpartId: "u-friend",
      counterpartName: "小美",
      lastMessageText: "爬山",
      lastActivityMs: 2000,
      autoReply: false,
      styleCategoryId: null as string | null,
      styleCategoryName: null as string | null,
    },
  ];
}

// 每個對話的訊息（測試可改）
let store: Record<string, Msg[]>;

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response;
}

// 依 url + method 分派的 fetch 假實作；預設處理 GET messages，其餘回空。
const fetchMock = vi.fn();

function parseAfter(url: string): number | undefined {
  const m = url.match(/[?&]after=(\d+)/);
  return m ? Number(m[1]) : undefined;
}
function convIdFromUrl(url: string): string {
  return url.match(/\/conversations\/([^/]+)\/messages/)?.[1] ?? "";
}

beforeEach(() => {
  store = {
    c1: [{ id: "m1", conversationId: "c1", senderId: "u-boss", text: "報告進度如何？", createdAtMs: 500 }],
    c2: [{ id: "m9", conversationId: "c2", senderId: "u-friend", text: "週末爬山嗎", createdAtMs: 900 }],
  };
  push.mockReset();
  refresh.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/api/categories") && method === "GET") {
      return jsonResponse({ categories: [{ id: "k1", name: "朋友" }] });
    }
    if (url.includes("/messages") && method === "GET") {
      const after = parseAfter(url);
      const all = store[convIdFromUrl(url)] ?? [];
      const msgs = after === undefined ? all : all.filter((m) => m.createdAtMs >= after);
      return jsonResponse({ messages: msgs });
    }
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);
  // jsdom 沒有 scrollIntoView
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ChatApp — 初次載入", () => {
  it("渲染對話列表與使用者名稱", () => {
    render(<ChatApp me={ME} initialConversations={conversations()} />);
    // 王主管是首個（預設啟用）對話：側欄一次、訊息視窗標頭一次
    expect(screen.getAllByText("王主管")).toHaveLength(2);
    expect(screen.getByText("小美")).toBeInTheDocument();
    // 側欄顯示本人名稱
    expect(screen.getByText("賴庭右")).toBeInTheDocument();
  });

  it("載入首個對話的訊息", async () => {
    render(<ChatApp me={ME} initialConversations={conversations()} />);
    expect(await screen.findByText("報告進度如何？")).toBeInTheDocument();
  });

  it("header 有通往 /settings 的設定連結", () => {
    render(<ChatApp me={ME} initialConversations={conversations()} />);
    const link = screen.getByRole("link", { name: "設定" });
    expect(link).toHaveAttribute("href", "/settings");
  });

  it("點選側欄另一個對話時載入該對話的訊息", async () => {
    const user = userEvent.setup();
    render(<ChatApp me={ME} initialConversations={conversations()} />);
    await screen.findByText("報告進度如何？");

    await user.click(screen.getByRole("button", { name: /小美/ }));

    expect(await within(messageWindow()).findByText("週末爬山嗎")).toBeInTheDocument();
    expect(within(messageWindow()).queryByText("報告進度如何？")).not.toBeInTheDocument();
  });

  it("訊息查詢回 401 時導向登入頁", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { ok: false, status: 401 }));
    render(<ChatApp me={ME} initialConversations={conversations()} />);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
  });
});

// --- 以下：有副作用的互動路徑 ---
// 每個測試自行接管 fetch。GET /messages 沿用預設行為（由 messagesResponse 提供），
// 其餘端點由各測試指定，避免預設 mock 回空物件導致 handler 讀到 undefined。

function messagesResponse(url: string): Response {
  const after = parseAfter(url);
  const all = store[convIdFromUrl(url)] ?? [];
  const msgs = after === undefined ? all : all.filter((m) => m.createdAtMs >= after);
  return jsonResponse({ messages: msgs });
}

// 訊息文字會同時出現在氣泡與側欄預覽（側欄同步 effect），全域查詢必然撞名——
// 斷言訊息時一律 scope 在訊息視窗內。
function messageWindow(): HTMLElement {
  return document.querySelector("section") as HTMLElement;
}

// 輸入框與草稿 textarea 都是「無名 textbox」，用 role 查會撞名；以標籤名區分。
function draftTextarea(): HTMLTextAreaElement {
  const el = screen.getAllByRole("textbox").find((e) => e.tagName === "TEXTAREA");
  if (!el) throw new Error("草稿 textarea 不在畫面上");
  return el as HTMLTextAreaElement;
}

type RouteHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** 保留預設的 GET /messages，其餘端點交給 handler。 */
function routeFetch(handler: RouteHandler) {
  fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/messages") && (init?.method ?? "GET") === "GET") {
      return messagesResponse(url);
    }
    return handler(url, init);
  });
}

const NEW_MESSAGE: Msg = {
  id: "m2",
  conversationId: "c1",
  senderId: "u-me",
  text: "馬上給你",
  createdAtMs: 1500,
};

describe("ChatApp — 送出訊息", () => {
  it("送出成功時訊息進入畫面並清空輸入框", async () => {
    const user = userEvent.setup();
    routeFetch(() => jsonResponse({ message: NEW_MESSAGE }));

    render(<ChatApp me={ME} initialConversations={conversations()} />);
    await screen.findByText("報告進度如何？");

    const input = screen.getByPlaceholderText("輸入訊息…");
    await user.type(input, "馬上給你");
    await user.click(screen.getByRole("button", { name: "送出" }));

    expect(await within(messageWindow()).findByText("馬上給你")).toBeInTheDocument();
    await waitFor(() => expect(input).toHaveValue(""));

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post?.[0]).toBe("/api/conversations/c1/messages");
    expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({ text: "馬上給你" });
  });

  it("伺服器回錯誤時顯示訊息並保留輸入內容（可直接重送）", async () => {
    const user = userEvent.setup();
    routeFetch(() => jsonResponse({ error: "訊息長度不可超過 2000 字" }, { ok: false, status: 400 }));

    render(<ChatApp me={ME} initialConversations={conversations()} />);
    await screen.findByText("報告進度如何？");

    await user.type(screen.getByPlaceholderText("輸入訊息…"), "太長了");
    await user.click(screen.getByRole("button", { name: "送出" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("訊息長度不可超過 2000 字");
    expect(screen.getByPlaceholderText("輸入訊息…")).toHaveValue("太長了");
  });

  it("fetch 失敗時顯示連線錯誤", async () => {
    const user = userEvent.setup();
    routeFetch(() => Promise.reject(new Error("network down")));

    render(<ChatApp me={ME} initialConversations={conversations()} />);
    await screen.findByText("報告進度如何？");

    await user.type(screen.getByPlaceholderText("輸入訊息…"), "嗨");
    await user.click(screen.getByRole("button", { name: "送出" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("無法連線到伺服器");
  });
});

describe("ChatApp — AI 協助草稿", () => {
  const DRAFT = { draftId: "d1", aiDraft: "好的，我今天下班前給您。" };

  it("按 AI 協助後草稿卡出現，並以最後一則來訊為對象", async () => {
    const user = userEvent.setup();
    routeFetch(() => jsonResponse(DRAFT));

    render(<ChatApp me={ME} initialConversations={conversations()} />);
    await screen.findByText("報告進度如何？");
    await user.click(screen.getByRole("button", { name: "AI 協助" }));

    await screen.findByRole("button", { name: "確認送出" });
    expect(draftTextarea()).toHaveValue(DRAFT.aiDraft);

    const post = fetchMock.mock.calls.find(([url]) => String(url) === "/api/drafts");
    expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({ messageId: "m1" });
  });

  it("草稿生成失敗時顯示後端錯誤訊息，不出現草稿卡", async () => {
    const user = userEvent.setup();
    routeFetch(() => jsonResponse({ error: "草稿超出長度上限而被截斷" }, { ok: false, status: 502 }));

    render(<ChatApp me={ME} initialConversations={conversations()} />);
    await screen.findByText("報告進度如何？");
    await user.click(screen.getByRole("button", { name: "AI 協助" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("草稿超出長度上限而被截斷");
    expect(screen.queryByRole("button", { name: "確認送出" })).not.toBeInTheDocument();
  });

  it("編輯草稿內容時標示「已編輯」", async () => {
    const user = userEvent.setup();
    routeFetch(() => jsonResponse(DRAFT));

    render(<ChatApp me={ME} initialConversations={conversations()} />);
    await screen.findByText("報告進度如何？");
    await user.click(screen.getByRole("button", { name: "AI 協助" }));

    await screen.findByRole("button", { name: "確認送出" });
    expect(screen.queryByText(/已編輯/)).not.toBeInTheDocument();

    await user.type(draftTextarea(), "！");
    expect(await screen.findByText(/已編輯/)).toBeInTheDocument();
  });

  it("捨棄草稿時草稿卡消失", async () => {
    const user = userEvent.setup();
    routeFetch(() => jsonResponse(DRAFT));

    render(<ChatApp me={ME} initialConversations={conversations()} />);
    await screen.findByText("報告進度如何？");
    await user.click(screen.getByRole("button", { name: "AI 協助" }));
    await screen.findByRole("button", { name: "確認送出" });

    await user.click(screen.getByRole("button", { name: "捨棄" }));
    expect(screen.queryByRole("button", { name: "確認送出" })).not.toBeInTheDocument();
  });

  it("確認送出：定稿內容成為訊息、草稿卡收起", async () => {
    const user = userEvent.setup();
    routeFetch((url) =>
      url === "/api/drafts"
        ? jsonResponse(DRAFT)
        : jsonResponse({ message: { ...NEW_MESSAGE, text: DRAFT.aiDraft } })
    );

    render(<ChatApp me={ME} initialConversations={conversations()} />);
    await screen.findByText("報告進度如何？");
    await user.click(screen.getByRole("button", { name: "AI 協助" }));
    await user.click(await screen.findByRole("button", { name: "確認送出" }));

    expect(await within(messageWindow()).findByText(DRAFT.aiDraft)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "確認送出" })).not.toBeInTheDocument()
    );

    const finalize = fetchMock.mock.calls.find(([url]) => String(url).includes("/finalize"));
    expect(finalize?.[0]).toBe("/api/drafts/d1/finalize");
    expect(JSON.parse((finalize?.[1] as RequestInit).body as string)).toEqual({
      finalText: DRAFT.aiDraft,
    });
  });

  it("定稿失敗時保留草稿卡供修改重試", async () => {
    const user = userEvent.setup();
    routeFetch((url) =>
      url === "/api/drafts"
        ? jsonResponse(DRAFT)
        : jsonResponse({ error: "此草稿已定稿，不可重複送出" }, { ok: false, status: 400 })
    );

    render(<ChatApp me={ME} initialConversations={conversations()} />);
    await screen.findByText("報告進度如何？");
    await user.click(screen.getByRole("button", { name: "AI 協助" }));
    await user.click(await screen.findByRole("button", { name: "確認送出" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("此草稿已定稿，不可重複送出");
    expect(screen.getByRole("button", { name: "確認送出" })).toBeInTheDocument();
  });
});

describe("ChatApp — 自動回覆開關", () => {
  it("開啟成功時勾選狀態與風險警語同步出現", async () => {
    const user = userEvent.setup();
    routeFetch(() => jsonResponse({ autoReply: true }));

    render(<ChatApp me={ME} initialConversations={conversations()} />);
    const toggle = screen.getByRole("checkbox", { name: "自動回覆" });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);

    await waitFor(() => expect(toggle).toBeChecked());
    // 架構 §8：自動模式的風險必須可見
    expect(screen.getByText(/自動回覆已開啟/)).toBeInTheDocument();

    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(put?.[0]).toBe("/api/conversations/c1/settings");
    expect(JSON.parse((put?.[1] as RequestInit).body as string)).toEqual({ autoReply: true });
  });

  it("設定失敗時不改變勾選狀態並顯示錯誤", async () => {
    const user = userEvent.setup();
    routeFetch(() => jsonResponse({ error: "boom" }, { ok: false, status: 500 }));

    render(<ChatApp me={ME} initialConversations={conversations()} />);
    const toggle = screen.getByRole("checkbox", { name: "自動回覆" });
    await user.click(toggle);

    expect(await screen.findByRole("alert")).toHaveTextContent("自動回覆設定變更失敗");
    expect(toggle).not.toBeChecked();
  });
});

describe("ChatApp — 登出", () => {
  it("呼叫登出 API 後導向登入頁", async () => {
    const user = userEvent.setup();
    routeFetch(() => jsonResponse({}));

    render(<ChatApp me={ME} initialConversations={conversations()} />);
    await user.click(screen.getByRole("button", { name: "登出" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/auth/logout")).toBe(true);
  });

  it("登出 API 失敗仍然導向登入頁（不把使用者卡在聊天畫面）", async () => {
    const user = userEvent.setup();
    routeFetch(() => Promise.reject(new Error("offline")));

    render(<ChatApp me={ME} initialConversations={conversations()} />);
    await user.click(screen.getByRole("button", { name: "登出" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
  });
});

describe("ChatApp — 語料分類選擇", () => {
  it("AI 協助旁顯示目前分類（預設通用）", async () => {
    render(<ChatApp me={ME} initialConversations={conversations()} />);
    expect(await screen.findByRole("button", { name: "語料分類" })).toHaveTextContent("通用");
  });

  it("展開選單選擇分類 → PUT 對話設定並更新按鈕", async () => {
    const user = userEvent.setup();
    render(<ChatApp me={ME} initialConversations={conversations()} />);
    await user.click(screen.getByRole("button", { name: "語料分類" }));
    await user.click(await screen.findByRole("button", { name: "朋友" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "語料分類" })).toHaveTextContent("朋友")
    );
    const putCall = fetchMock.mock.calls.find(
      ([u, i]) => String(u).includes("/conversations/c1/settings") && i?.method === "PUT"
    );
    expect(putCall).toBeTruthy();
    expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual({
      styleCategoryId: "k1",
    });
  });

  it("PUT 失敗時顯示錯誤且按鈕維持原分類", async () => {
    const user = userEvent.setup();
    // 覆寫：settings PUT 回 400
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/settings") && init?.method === "PUT") {
        return jsonResponse({ error: "x" }, { ok: false, status: 400 });
      }
      return base(input, init);
    });

    render(<ChatApp me={ME} initialConversations={conversations()} />);
    await user.click(screen.getByRole("button", { name: "語料分類" }));
    await user.click(await screen.findByRole("button", { name: "朋友" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "語料分類" })).toHaveTextContent("通用");
  });

  it("切換對話時選擇器顯示該對話自己的分類", async () => {
    const user = userEvent.setup();
    const convs = conversations();
    convs[1] = { ...convs[1], styleCategoryId: "k1", styleCategoryName: "朋友" };
    render(<ChatApp me={ME} initialConversations={convs} />);
    expect(screen.getByRole("button", { name: "語料分類" })).toHaveTextContent("通用");
    await user.click(screen.getByText("小美"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "語料分類" })).toHaveTextContent("朋友")
    );
  });
});
