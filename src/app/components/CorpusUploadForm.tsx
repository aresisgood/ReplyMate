"use client";
// 共用語料上傳表單（設定頁 + onboarding）：選檔 + 分類（預設通用）→ 上傳。
// 分類清單延遲載入（展開選單才抓），建立/改名直接打 /api/categories。
import { useState } from "react";
import CategoryPicker, { type CategoryOption } from "./CategoryPicker";

interface Props {
  onUploaded?: () => void | Promise<void>;
  /** 分類改名成功後通知外層——外層若顯示分類名（如設定頁語料清單）須重抓以免 stale */
  onCategoryChanged?: () => void | Promise<void>;
}

export default function CorpusUploadForm({ onUploaded, onCategoryChanged }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState<CategoryOption | null>(null); // null = 通用
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [categoriesLoaded, setCategoriesLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      // 載入失敗維持通用；下次展開重試
    }
  }

  async function createCategory(name: string): Promise<CategoryOption | null> {
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

  async function renameCategory(id: string, name: string): Promise<boolean> {
    setError(null);
    try {
      const res = await fetch(`/api/categories/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = (await res.json().catch(() => null)) as
        | { id?: string; name?: string; error?: string }
        | null;
      if (!res.ok || !body?.name) {
        setError(body?.error ?? "分類改名失敗，請稍後再試");
        return false;
      }
      const renamed = { id, name: body.name };
      setCategories((list) => list.map((c) => (c.id === id ? renamed : c)));
      setCategory((current) => (current?.id === id ? renamed : current));
      await onCategoryChanged?.();
      return true;
    } catch {
      setError("無法連線到伺服器");
      return false;
    }
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const fileText = await file.text();
      const res = await fetch("/api/corpus/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          category ? { fileText, categoryId: category.id } : { fileText }
        ),
      });
      const body = (await res.json().catch(() => null)) as
        | { sourceName?: string; sampleCount?: number; replaced?: boolean; error?: string }
        | null;
      if (!res.ok || !body?.sourceName) {
        setError(body?.error ?? "上傳失敗，請稍後再試");
        return;
      }
      setNotice(
        `已從「${body.sourceName}」的對話建立 ${body.sampleCount} 句語氣樣本` +
          `（分類：${category?.name ?? "通用"}）` +
          (body.replaced ? "（取代舊語料）" : "")
      );
      await onUploaded?.();
    } catch {
      setError("上傳失敗，請稍後再試");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleUpload} className="flex flex-col gap-2">
      <input
        type="file"
        accept=".txt"
        aria-label="選擇 LINE 匯出檔"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="text-sm"
      />
      <div className="flex items-center gap-2">
        <CategoryPicker
          categories={categories}
          valueId={category?.id ?? null}
          valueName={category?.name ?? "通用"}
          onOpen={loadCategories}
          onSelect={setCategory}
          onCreate={createCategory}
          onRename={renameCategory}
        />
        <button
          type="submit"
          disabled={!file || busy}
          className="rounded bg-blue-600 px-4 py-1 text-sm text-white disabled:opacity-40"
        >
          {busy ? "上傳中…" : "上傳"}
        </button>
      </div>
      {notice && <p className="text-sm text-green-700">{notice}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
