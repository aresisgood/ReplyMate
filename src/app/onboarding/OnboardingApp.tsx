"use client";
// 首次登入引導：匯入 LINE 對話讓 AI 學習語氣；可略過，之後仍可在設定頁上傳。
import { useRouter } from "next/navigation";
import CorpusUploadForm from "../components/CorpusUploadForm";

export default function OnboardingApp() {
  const router = useRouter();

  function goChat() {
    router.push("/");
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-sm">
        <h1 className="text-xl font-bold">讓 AI 學習你的語氣</h1>
        <p className="mt-2 text-sm text-gray-600">
          上傳 LINE 匯出的 .txt 聊天記錄，AI 會只擷取你自己的發言作為語氣樣本，
          代筆時就能模仿你的用詞與標點習慣。對方的訊息與原始檔內容不會被保存。
        </p>

        <div className="mt-6">
          <CorpusUploadForm onUploaded={goChat} />
        </div>

        <button
          type="button"
          onClick={goChat}
          className="mt-6 w-full rounded-lg border border-gray-300 py-2 text-sm text-gray-600 hover:bg-gray-50"
        >
          先略過，直接開始
        </button>
        <p className="mt-2 text-center text-xs text-gray-400">
          之後可隨時在「設定」頁上傳語料。
        </p>
      </div>
    </main>
  );
}
