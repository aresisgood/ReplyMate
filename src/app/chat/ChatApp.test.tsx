// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
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
    },
    {
      conversationId: "c2",
      counterpartId: "u-friend",
      counterpartName: "小美",
      lastMessageText: "爬山",
      lastActivityMs: 2000,
      autoReply: false,
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
});
