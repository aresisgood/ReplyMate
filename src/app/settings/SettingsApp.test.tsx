// @vitest-environment jsdom
// SettingsApp：清單渲染、sourceName 不匹配警示、上傳前置條件，以及 handleUpload
// 的四條路徑（成功、取代舊語料、伺服器回錯、fetch 失敗）與上傳中的按鈕狀態。
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import SettingsApp from "./SettingsApp";

afterEach(() => cleanup());

const CORPORA = [
  {
    id: "c1",
    contactLabel: "主管",
    sourceName: "王主管",
    sampleCount: 48,
    createdAtMs: 1_700_000_000_000,
  },
  {
    id: "c2",
    contactLabel: "朋友",
    sourceName: "陳小美",
    sampleCount: 12,
    createdAtMs: 1_700_000_000_000,
  },
];

describe("SettingsApp", () => {
  it("渲染語料清單（標籤、來源、句數）", () => {
    render(<SettingsApp initialCorpora={CORPORA} counterpartNames={["王主管"]} />);
    expect(screen.getByText("主管")).toBeInTheDocument();
    expect(screen.getByText(/王主管/)).toBeInTheDocument();
    expect(screen.getByText(/48 句/)).toBeInTheDocument();
  });

  it("sourceName 與既有對話對象不符時顯示警示", () => {
    render(<SettingsApp initialCorpora={CORPORA} counterpartNames={["王主管"]} />);
    // 陳小美不在對話對象中 → 警示；王主管有 → 無警示
    expect(screen.getAllByText(/沒有名為/)).toHaveLength(1);
  });

  it("未選擇檔案時上傳按鈕 disabled", () => {
    render(<SettingsApp initialCorpora={[]} counterpartNames={[]} />);
    expect(screen.getByRole("button", { name: "上傳" })).toBeDisabled();
  });

  it("無語料時顯示空狀態", () => {
    render(<SettingsApp initialCorpora={[]} counterpartNames={[]} />);
    expect(screen.getByText(/尚未上傳/)).toBeInTheDocument();
  });
});

// --- 上傳流程 ---
// 表單只有在「已選檔 + 已填標籤」時才可送出，故每個案例都先跑 fillForm。
// jsdom 29 的 File 原生支援 .text()（元件用它讀檔），無需 polyfill。

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response;
}

const fetchMock = vi.fn();

/** 選一個 .txt 檔並填入對象類型，讓上傳按鈕解除 disabled。 */
async function fillForm(user: ReturnType<typeof userEvent.setup>, label = "主管") {
  const file = new File(["2024/01/01\n10:00\t我\t收到，晚點回你"], "line.txt", {
    type: "text/plain",
  });
  await user.upload(screen.getByLabelText("選擇 LINE 匯出檔"), file);
  await user.type(screen.getByPlaceholderText(/對象類型/), label);
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
    // 依序：POST /api/corpus/upload → GET /api/corpus
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ sourceName: "王主管", sampleCount: 48, replaced: false })
      )
      .mockResolvedValueOnce(jsonResponse({ corpora: CORPORA }));

    render(<SettingsApp initialCorpora={[]} counterpartNames={["王主管"]} />);
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: "上傳" }));

    expect(await screen.findByText("已為「王主管」建立 48 句樣本")).toBeInTheDocument();
    // 清單由 GET /api/corpus 的結果重新渲染（初始為空狀態）
    // 用 exact 字串避免同時匹配到成功訊息裡的「48 句樣本」
    expect(screen.getByText("48 句")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByText(/尚未上傳/)).not.toBeInTheDocument();

    // 送出的 body 帶檔案內容與標籤
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/corpus/upload");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      fileText: "2024/01/01\n10:00\t我\t收到，晚點回你",
      contactLabel: "主管",
    });
  });

  it("replaced=true 時訊息附註取代舊語料", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ sourceName: "王主管", sampleCount: 12, replaced: true })
      )
      .mockResolvedValueOnce(jsonResponse({ corpora: [] }));

    render(<SettingsApp initialCorpora={[]} counterpartNames={[]} />);
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: "上傳" }));

    expect(
      await screen.findByText("已為「王主管」建立 12 句樣本（取代舊語料）")
    ).toBeInTheDocument();
  });

  it("伺服器回錯誤時顯示該錯誤訊息", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "檔案格式無法解析" }, { ok: false, status: 400 })
    );

    render(<SettingsApp initialCorpora={[]} counterpartNames={[]} />);
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: "上傳" }));

    expect(await screen.findByText("檔案格式無法解析")).toBeInTheDocument();
    // 失敗不應觸發清單刷新
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetch 失敗時顯示通用錯誤訊息", async () => {
    const user = userEvent.setup();
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    render(<SettingsApp initialCorpora={[]} counterpartNames={[]} />);
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: "上傳" }));

    expect(await screen.findByText("上傳失敗，請稍後再試")).toBeInTheDocument();
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

    render(<SettingsApp initialCorpora={[]} counterpartNames={[]} />);
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
