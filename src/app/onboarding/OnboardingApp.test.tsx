// @vitest-environment jsdom
// OnboardingApp：上傳成功導回聊天、略過導回聊天、上傳失敗顯示錯誤不導頁。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import OnboardingApp from "./OnboardingApp";

const { push, refresh, router } = vi.hoisted(() => {
  const push = vi.fn();
  const refresh = vi.fn();
  return { push, refresh, router: { push, refresh } };
});
vi.mock("next/navigation", () => ({ useRouter: () => router }));

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return { ok: init.ok ?? true, status: init.status ?? 200, json: async () => body } as Response;
}

const fetchMock = vi.fn();

async function uploadFile(user: ReturnType<typeof userEvent.setup>) {
  const file = new File(["2024/01/01\n10:00\t我\t收到，晚點回你"], "line.txt", {
    type: "text/plain",
  });
  await user.upload(screen.getByLabelText("選擇 LINE 匯出檔"), file);
  await user.click(screen.getByRole("button", { name: "上傳" }));
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

describe("OnboardingApp", () => {
  it("顯示語氣學習說明與略過選項", () => {
    render(<OnboardingApp />);
    expect(screen.getByText(/學習你的語氣/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "先略過，直接開始" })).toBeInTheDocument();
  });

  it("上傳成功後導向聊天首頁", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ sourceName: "王主管", sampleCount: 3, replaced: false })
    );

    render(<OnboardingApp />);
    await uploadFile(user);

    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    expect(refresh).toHaveBeenCalled();
  });

  it("按「先略過」直接導向聊天首頁", async () => {
    const user = userEvent.setup();
    render(<OnboardingApp />);
    await user.click(screen.getByRole("button", { name: "先略過，直接開始" }));
    expect(push).toHaveBeenCalledWith("/");
  });

  it("上傳失敗顯示錯誤且不導頁", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "無法辨識的 LINE 匯出格式" }, { ok: false, status: 400 })
    );

    render(<OnboardingApp />);
    await uploadFile(user);

    expect(await screen.findByText("無法辨識的 LINE 匯出格式")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});
