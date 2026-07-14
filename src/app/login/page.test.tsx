// @vitest-environment jsdom
// LoginPage：送出前置條件、登入成功導頁，以及三條失敗路徑
//（伺服器回錯、回應無 body、fetch 失敗）。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LoginPage from "./page";

// router 以 vi.hoisted 固定一份，避免每次 render 產生新物件（與 ChatApp.test.tsx 一致）
const { push, refresh, router } = vi.hoisted(() => {
  const push = vi.fn();
  const refresh = vi.fn();
  return { push, refresh, router: { push, refresh } };
});
vi.mock("next/navigation", () => ({ useRouter: () => router }));

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response;
}

const fetchMock = vi.fn();

/** 填入帳密，讓登入按鈕解除 disabled。 */
async function fillCredentials(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("帳號"), "tingyu");
  await user.type(screen.getByLabelText("密碼"), "demo1234");
}

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LoginPage — 表單狀態", () => {
  it("帳密未填時登入按鈕 disabled", () => {
    render(<LoginPage />);
    expect(screen.getByRole("button", { name: "登入" })).toBeDisabled();
  });

  it("填妥帳密後按鈕可送出", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);
    await fillCredentials(user);
    expect(screen.getByRole("button", { name: "登入" })).toBeEnabled();
  });
});

describe("LoginPage — 送出", () => {
  it("登入成功時以帳密呼叫 API 並導向聊天首頁", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    render(<LoginPage />);
    await fillCredentials(user);
    await user.click(screen.getByRole("button", { name: "登入" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    // refresh 讓 server component 重新以新 session cookie 取資料
    expect(refresh).toHaveBeenCalled();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/auth/login");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      username: "tingyu",
      password: "demo1234",
    });
  });

  it("伺服器回錯誤時顯示該錯誤訊息且不導頁", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "帳號或密碼錯誤" }, { ok: false, status: 401 })
    );

    render(<LoginPage />);
    await fillCredentials(user);
    await user.click(screen.getByRole("button", { name: "登入" }));

    expect(await screen.findByText("帳號或密碼錯誤")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("錯誤回應無法解析 JSON 時退回通用訊息", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);

    render(<LoginPage />);
    await fillCredentials(user);
    await user.click(screen.getByRole("button", { name: "登入" }));

    expect(await screen.findByText("登入失敗，請稍後再試")).toBeInTheDocument();
  });

  it("fetch 失敗時顯示連線錯誤", async () => {
    const user = userEvent.setup();
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    render(<LoginPage />);
    await fillCredentials(user);
    await user.click(screen.getByRole("button", { name: "登入" }));

    expect(await screen.findByText("無法連線到伺服器")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("送出中按鈕顯示「登入中…」且 disabled", async () => {
    const user = userEvent.setup();
    let resolveLogin!: (res: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveLogin = resolve;
      })
    );

    render(<LoginPage />);
    await fillCredentials(user);
    await user.click(screen.getByRole("button", { name: "登入" }));

    expect(await screen.findByRole("button", { name: "登入中…" })).toBeDisabled();

    resolveLogin(jsonResponse({ ok: true }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
  });
});
