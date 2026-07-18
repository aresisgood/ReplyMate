// @vitest-environment jsdom
// CategoryPicker：純展示層選擇器。驗證展開/onOpen、選取（通用/自訂）、
// inline 新增（onCreate resolve 後自動選取並關閉）、inline 改名（預填 + onRename）。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CategoryPicker, { type CategoryOption } from "./CategoryPicker";

const CATEGORIES: CategoryOption[] = [{ id: "k1", name: "主管" }];

let onOpen: ReturnType<typeof vi.fn>;
let onSelect: ReturnType<typeof vi.fn>;
let onCreate: ReturnType<typeof vi.fn>;
let onRename: ReturnType<typeof vi.fn>;

/** 以預設 callback 渲染，valueId 預設 null（通用）。 */
function renderPicker(overrides: Partial<React.ComponentProps<typeof CategoryPicker>> = {}) {
  return render(
    <CategoryPicker
      categories={CATEGORIES}
      valueId={null}
      valueName="通用"
      onOpen={onOpen}
      onSelect={onSelect}
      onCreate={onCreate}
      onRename={onRename}
      {...overrides}
    />
  );
}

beforeEach(() => {
  onOpen = vi.fn();
  onSelect = vi.fn();
  onCreate = vi.fn();
  onRename = vi.fn();
});

afterEach(() => cleanup());

describe("CategoryPicker", () => {
  it("按鈕顯示 valueName；點擊展開選單並呼叫 onOpen", async () => {
    const user = userEvent.setup();
    renderPicker({ valueName: "主管", valueId: "k1" });

    const trigger = screen.getByRole("button", { name: "語料分類" });
    expect(trigger).toHaveTextContent("主管");
    // 展開前選單項目不存在
    expect(screen.queryByRole("button", { name: "通用" })).not.toBeInTheDocument();

    await user.click(trigger);

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "通用" })).toBeInTheDocument();
  });

  it("點「通用」→ onSelect(null)；點「主管」→ onSelect 該分類", async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("button", { name: "語料分類" }));
    await user.click(screen.getByRole("button", { name: "通用" }));
    expect(onSelect).toHaveBeenCalledWith(null);

    // 選取後選單關閉，重新展開再選自訂分類
    await user.click(screen.getByRole("button", { name: "語料分類" }));
    await user.click(screen.getByRole("button", { name: "主管" }));
    expect(onSelect).toHaveBeenCalledWith({ id: "k1", name: "主管" });
  });

  it("新增分類：輸入 → 建立 → onCreate 被呼叫，resolve 後關閉並選取新分類", async () => {
    const user = userEvent.setup();
    const created: CategoryOption = { id: "k2", name: "朋友" };
    onCreate.mockResolvedValueOnce(created);
    renderPicker();

    await user.click(screen.getByRole("button", { name: "語料分類" }));
    await user.click(screen.getByRole("button", { name: "＋ 新增分類" }));

    await user.type(screen.getByLabelText("新分類名稱"), "朋友");
    await user.click(screen.getByRole("button", { name: "建立" }));

    expect(onCreate).toHaveBeenCalledWith("朋友");
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(created));
    // 選取後選單關閉
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "通用" })).not.toBeInTheDocument()
    );
  });

  it("重新命名：輸入框預填舊名 → 改字送出 → onRename(id, 新名)", async () => {
    const user = userEvent.setup();
    onRename.mockResolvedValueOnce(true);
    renderPicker();

    await user.click(screen.getByRole("button", { name: "語料分類" }));
    await user.click(screen.getByRole("button", { name: "重新命名 主管" }));

    const input = screen.getByLabelText("分類新名稱") as HTMLInputElement;
    expect(input.value).toBe("主管");

    await user.clear(input);
    await user.type(input, "直屬主管");
    await user.click(screen.getByRole("button", { name: "確定" }));

    expect(onRename).toHaveBeenCalledWith("k1", "直屬主管");
  });
});
