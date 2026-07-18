"use client";
// 語料分類選擇器（純展示層）：資料操作透過 async callback 交由外層。
// valueName 與 categories 分離：外層可延遲載入清單（開啟選單才抓），
// 但按鈕上的目前分類名必須立即可顯示。「通用」= valueId null，非資料列。
import { useState } from "react";

export interface CategoryOption {
  id: string;
  name: string;
}

interface Props {
  categories: CategoryOption[];
  valueId: string | null; // null = 通用
  valueName: string;
  onOpen?: () => void;
  onSelect: (category: CategoryOption | null) => void;
  onCreate: (name: string) => Promise<CategoryOption | null>; // null = 失敗（錯誤由外層顯示）
  onRename: (id: string, name: string) => Promise<boolean>;
  /** 選單展開方向；聊天輸入列在畫面底部須向上展開 */
  direction?: "down" | "up";
  disabled?: boolean;
}

export default function CategoryPicker({
  categories,
  valueId,
  valueName,
  onOpen,
  onSelect,
  onCreate,
  onRename,
  direction = "down",
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  function resetEditing() {
    setCreating(false);
    setRenamingId(null);
    setInput("");
  }

  function toggleOpen() {
    if (disabled) return;
    if (!open) onOpen?.();
    setOpen(!open);
    resetEditing();
  }

  function choose(category: CategoryOption | null) {
    onSelect(category);
    setOpen(false);
    resetEditing();
  }

  async function submitCreate() {
    if (busy || !input.trim()) return;
    setBusy(true);
    const created = await onCreate(input);
    setBusy(false);
    if (created) choose(created);
  }

  async function submitRename(id: string) {
    if (busy || !input.trim()) return;
    setBusy(true);
    const ok = await onRename(id, input);
    setBusy(false);
    if (ok) resetEditing();
  }

  const menuPosition = direction === "up" ? "bottom-full mb-1" : "top-full mt-1";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggleOpen}
        disabled={disabled}
        aria-label="語料分類"
        className="rounded-full border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40"
      >
        🗂 {valueName}
      </button>

      {open && (
        <ul
          className={`absolute left-0 z-10 w-56 rounded-lg border border-gray-200 bg-white py-1 shadow-lg ${menuPosition}`}
        >
          <li>
            <button
              type="button"
              onClick={() => choose(null)}
              className={`w-full px-3 py-1.5 text-left text-sm hover:bg-gray-50 ${
                valueId === null ? "font-semibold text-blue-600" : ""
              }`}
            >
              通用
            </button>
          </li>

          {categories.map((c) => (
            <li key={c.id} className="flex items-center">
              {renamingId === c.id ? (
                <span className="flex flex-1 items-center gap-1 px-3 py-1">
                  <input
                    aria-label="分類新名稱"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    maxLength={20}
                    className="w-full rounded border border-gray-300 px-2 py-0.5 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => submitRename(c.id)}
                    disabled={busy || !input.trim()}
                    className="text-xs text-blue-600 disabled:opacity-40"
                  >
                    確定
                  </button>
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => choose(c)}
                    className={`flex-1 px-3 py-1.5 text-left text-sm hover:bg-gray-50 ${
                      valueId === c.id ? "font-semibold text-blue-600" : ""
                    }`}
                  >
                    {c.name}
                  </button>
                  <button
                    type="button"
                    aria-label={`重新命名 ${c.name}`}
                    onClick={() => {
                      setCreating(false);
                      setRenamingId(c.id);
                      setInput(c.name);
                    }}
                    className="px-2 text-xs text-gray-400 hover:text-gray-600"
                  >
                    ✏️
                  </button>
                </>
              )}
            </li>
          ))}

          <li className="border-t border-gray-100">
            {creating ? (
              <span className="flex items-center gap-1 px-3 py-1">
                <input
                  aria-label="新分類名稱"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  maxLength={20}
                  className="w-full rounded border border-gray-300 px-2 py-0.5 text-sm"
                />
                <button
                  type="button"
                  onClick={submitCreate}
                  disabled={busy || !input.trim()}
                  className="text-xs text-blue-600 disabled:opacity-40"
                >
                  建立
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setRenamingId(null);
                  setCreating(true);
                  setInput("");
                }}
                className="w-full px-3 py-1.5 text-left text-sm text-gray-500 hover:bg-gray-50"
              >
                ＋ 新增分類
              </button>
            )}
          </li>
        </ul>
      )}
    </div>
  );
}
