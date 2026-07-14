"use client";
// 設定頁互動層：風格語料上傳與清單（架構 §3 F2）。
// 個人 API key 區塊由 feat/byok-settings 分支加入本頁。
import { useState } from "react";
import Link from "next/link";
import type { CorpusSummary } from "@/lib/corpus/corpus";

const LABEL_SUGGESTIONS = ["主管", "同事", "朋友", "家人"];

interface Props {
  initialCorpora: CorpusSummary[];
  counterpartNames: string[];
}

export default function SettingsApp({ initialCorpora, counterpartNames }: Props) {
  const [corpora, setCorpora] = useState(initialCorpora);
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        body: JSON.stringify({ fileText, contactLabel: label }),
      });
      const body = (await res.json().catch(() => null)) as
        | {
            sourceName?: string;
            sampleCount?: number;
            replaced?: boolean;
            error?: string;
          }
        | null;
      if (!res.ok || !body?.sourceName) {
        setError(body?.error ?? "上傳失敗，請稍後再試");
        return;
      }
      setNotice(
        `已為「${body.sourceName}」建立 ${body.sampleCount} 句樣本` +
          (body.replaced ? "（取代舊語料）" : "")
      );
      const listRes = await fetch("/api/corpus");
      if (listRes.ok) {
        const listBody = (await listRes.json()) as { corpora: CorpusSummary[] };
        setCorpora(listBody.corpora);
      }
    } catch {
      setError("上傳失敗，請稍後再試");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold">設定</h1>
        <Link href="/" className="text-sm text-blue-600 hover:underline">
          ← 回聊天室
        </Link>
      </div>

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-1 text-sm font-semibold">風格語料</h2>
        <p className="mb-4 text-xs text-gray-500">
          上傳 LINE 匯出的 .txt 聊天記錄，只保留你自己的發言作為 AI 模仿語氣的樣本；
          原始檔內容與對方訊息不會被保存。重複上傳同一位對象會整組取代舊語料。
        </p>

        <form onSubmit={handleUpload} className="mb-4 flex flex-col gap-2">
          <input
            type="file"
            accept=".txt"
            aria-label="選擇 LINE 匯出檔"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-sm"
          />
          <div className="flex gap-2">
            <input
              type="text"
              list="label-suggestions"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="對象類型（如：主管）"
              maxLength={20}
              className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
            />
            <datalist id="label-suggestions">
              {LABEL_SUGGESTIONS.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            <button
              type="submit"
              disabled={!file || label.trim().length === 0 || busy}
              className="rounded bg-blue-600 px-4 py-1 text-sm text-white disabled:opacity-40"
            >
              {busy ? "上傳中…" : "上傳"}
            </button>
          </div>
        </form>

        {notice && <p className="mb-3 text-sm text-green-700">{notice}</p>}
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

        {corpora.length === 0 ? (
          <p className="text-sm text-gray-400">尚未上傳任何語料。</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {corpora.map((c) => (
              <li key={c.id} className="flex items-center justify-between py-2">
                <div>
                  <p className="text-sm">
                    <span className="mr-2 rounded bg-gray-100 px-2 py-0.5 text-xs">
                      {c.contactLabel}
                    </span>
                    {c.sourceName}
                  </p>
                  {!counterpartNames.includes(c.sourceName) && (
                    <p className="mt-1 text-xs text-amber-600">
                      ⚠ 沒有名為「{c.sourceName}」的對話對象，引擎不會使用這組語料
                    </p>
                  )}
                </div>
                <span className="text-xs text-gray-500">{c.sampleCount} 句</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
