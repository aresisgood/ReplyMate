// @vitest-environment jsdom
// SettingsApp：清單渲染（分類 badge、來源、句數）、上傳前置條件，以及透過共用
// CorpusUploadForm 完成上傳後重抓 /api/corpus 更新清單的流程。
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import SettingsApp from "./SettingsApp";

afterEach(() => cleanup());

const CORPORA = [
  {
    id: "c1",
    sourceName: "王主管",
    categoryId: null,
    categoryName: null,
    sampleCount: 48,
    createdAtMs: 1_700_000_000_000,
  },
  {
    id: "c2",
    sourceName: "陳小美",
    categoryId: "k1",
    categoryName: "朋友",
    sampleCount: 12,
    createdAtMs: 1_700_000_000_000,
  },
];

describe("SettingsApp", () => {
  it("渲染語料清單（分類 badge、來源、句數）", () => {
    render(<SettingsApp initialCorpora={CORPORA} />);
    expect(screen.getByText("王主管")).toBeInTheDocument();
    expect(screen.getByText("陳小美")).toBeInTheDocument();
    // c1 categoryName null → 通用 badge；c2 → 朋友 badge
    expect(screen.getByText("通用")).toBeInTheDocument();
    expect(screen.getByText("朋友")).toBeInTheDocument();
    expect(screen.getByText("48 句")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("未選擇檔案時上傳按鈕 disabled", () => {
    render(<SettingsApp initialCorpora={[]} />);
    expect(screen.getByRole("button", { name: "上傳" })).toBeDisabled();
  });

  it("無語料時顯示空狀態", () => {
    render(<SettingsApp initialCorpora={[]} />);
    expect(screen.getByText(/尚未上傳/)).toBeInTheDocument();
  });
});

// --- 上傳流程 ---
// 上傳互動由共用 CorpusUploadForm 負責，成功後 onUploaded 重抓 /api/corpus。
// 測試只選檔（分類預設「通用」）即可送出。jsdom 29 的 File 原生支援 .text()。

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response;
}

const fetchMock = vi.fn();

/** 選一個 .txt 檔，讓上傳按鈕解除 disabled（分類維持預設「通用」）。 */
async function fillForm(user: ReturnType<typeof userEvent.setup>) {
  const file = new File(["2024/01/01\n10:00\t我\t收到，晚點回你"], "line.txt", {
    type: "text/plain",
  });
  await user.upload(screen.getByLabelText("選擇 LINE 匯出檔"), file);
  return file;
}

describe("SettingsApp — 上傳語料", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("上傳成功時顯示樣本數並以最新清單取代畫面", async () => {
    const user = userEvent.setup();
    // 依序：POST /api/corpus/upload → GET /api/corpus（onUploaded 重抓）
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ sourceName: "王主管", sampleCount: 48, replaced: false })
      )
      .mockResolvedValueOnce(jsonResponse({ corpora: CORPORA }));

    render(<SettingsApp initialCorpora={[]} />);
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: "上傳" }));

    expect(
      await screen.findByText("已從「王主管」的對話建立 48 句語氣樣本（分類：通用）")
    ).toBeInTheDocument();
    // 清單由 GET /api/corpus 的結果重新渲染（初始為空狀態）
    expect(screen.getByText("48 句")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByText(/尚未上傳/)).not.toBeInTheDocument();

    // 送出的 body 只帶檔案內容（分類為通用時不帶 categoryId）
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/corpus/upload");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      fileText: "2024/01/01\n10:00\t我\t收到，晚點回你",
    });
  });

  it("伺服器回錯誤時顯示該錯誤訊息", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "檔案格式無法解析" }, { ok: false, status: 400 })
    );

    render(<SettingsApp initialCorpora={[]} />);
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: "上傳" }));

    expect(await screen.findByText("檔案格式無法解析")).toBeInTheDocument();
    // 失敗不應觸發清單刷新
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetch 失敗時顯示通用錯誤訊息", async () => {
    const user = userEvent.setup();
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    render(<SettingsApp initialCorpora={[]} />);
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: "上傳" }));

    expect(await screen.findByText("上傳失敗，請稍後再試")).toBeInTheDocument();
  });

  it("透過選單改名分類後，語料清單的分類 badge 同步更新", async () => {
    const user = userEvent.setup();
    // 依 url+method 分派：展開選單載清單 → PUT 改名 → onCategoryChanged 重抓語料
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/categories" && method === "GET") {
        return jsonResponse({ categories: [{ id: "k1", name: "朋友" }] });
      }
      if (url === "/api/categories/k1" && method === "PUT") {
        return jsonResponse({ id: "k1", name: "麻吉" });
      }
      if (url === "/api/corpus" && method === "GET") {
        return jsonResponse({
          corpora: [CORPORA[0], { ...CORPORA[1], categoryName: "麻吉" }],
        });
      }
      return jsonResponse({});
    });

    render(<SettingsApp initialCorpora={CORPORA} />);
    await user.click(screen.getByRole("button", { name: "語料分類" }));
    await user.click(await screen.findByRole("button", { name: "重新命名 朋友" }));
    const input = screen.getByLabelText("分類新名稱");
    await user.clear(input);
    await user.type(input, "麻吉");
    await user.click(screen.getByRole("button", { name: "確定" }));

    // 語料清單（非選單）的 badge 必須反映新名稱——改名後重抓 /api/corpus
    const list = await screen.findByRole("list", { name: "語料清單" });
    await waitFor(() => expect(within(list).getByText("麻吉")).toBeInTheDocument());
  });

  it("上傳中按鈕顯示「上傳中…」且 disabled，完成後恢復", async () => {
    const user = userEvent.setup();
    let resolveUpload!: (res: Response) => void;
    fetchMock
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveUpload = resolve;
        })
      )
      .mockResolvedValueOnce(jsonResponse({ corpora: [] }));

    render(<SettingsApp initialCorpora={[]} />);
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: "上傳" }));

    const busyButton = await screen.findByRole("button", { name: "上傳中…" });
    expect(busyButton).toBeDisabled();

    resolveUpload(jsonResponse({ sourceName: "王主管", sampleCount: 3, replaced: false }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "上傳" })).toBeEnabled()
    );
  });
});
