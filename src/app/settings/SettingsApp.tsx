"use client";
// 設定頁互動層：風格語料上傳與清單（架構 §3 F2）。
// 上傳互動交給共用 CorpusUploadForm；成功後重抓 /api/corpus 更新清單。
// 個人 API key 區塊由 feat/byok-settings 分支加入本頁。
import { useState } from "react";
import Link from "next/link";
import type { CorpusSummary } from "@/lib/corpus/corpus";
import CorpusUploadForm from "../components/CorpusUploadForm";

interface Props {
  initialCorpora: CorpusSummary[];
}

export default function SettingsApp({ initialCorpora }: Props) {
  const [corpora, setCorpora] = useState(initialCorpora);

  async function refreshCorpora() {
    const listRes = await fetch("/api/corpus");
    if (listRes.ok) {
      const listBody = (await listRes.json()) as { corpora: CorpusSummary[] };
      setCorpora(listBody.corpora);
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
          原始檔內容與對方訊息不會被保存。重複上傳同一份對話會整組取代舊語料。
        </p>

        <div className="mb-4">
          {/* 改名分類會影響清單 badge 顯示，故 onCategoryChanged 也重抓清單 */}
          <CorpusUploadForm onUploaded={refreshCorpora} onCategoryChanged={refreshCorpora} />
        </div>

        {corpora.length === 0 ? (
          <p className="text-sm text-gray-400">尚未上傳任何語料。</p>
        ) : (
          <ul aria-label="語料清單" className="divide-y divide-gray-100">
            {corpora.map((c) => (
              <li key={c.id} className="flex items-center justify-between py-2">
                <p className="text-sm">
                  <span className="mr-2 rounded bg-gray-100 px-2 py-0.5 text-xs">
                    {c.categoryName ?? "通用"}
                  </span>
                  {c.sourceName}
                </p>
                <span className="text-xs text-gray-500">{c.sampleCount} 句</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
