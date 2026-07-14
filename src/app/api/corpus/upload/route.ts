// POST /api/corpus/upload — { fileText, contactLabel } → 建立/取代風格語料（架構 §3 F2）
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, mapChatError, readJsonWithLimit, PayloadTooLargeError } from "@/lib/http";
import { importLineCorpus } from "@/lib/corpus/corpus";
import { corpusUploadRateLimiter } from "@/lib/rateLimit";

// 以字元計的檔案上限；解析為 CPU 密集操作，須擋濫用。
const MAX_FILE_CHARS = 2_097_152;
const MAX_LABEL_CHARS = 20;

// 位元組計的 body 上限，比 MAX_FILE_CHARS 更早生效。兩者單位不同不是疏漏：
// 前者限制「要解析多少文字」，後者限制「要讀進多少記憶體」。上限取 8 MiB——
// 2,097,152 個中文字在 UTF-8 約 6.3 MB，加上 JSON 轉義與其他欄位仍有餘裕。
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;
  const userId = auth;

  if (!corpusUploadRateLimiter.check(userId)) {
    return NextResponse.json({ error: "上傳過於頻繁，請稍後再試" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await readJsonWithLimit(request, MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof PayloadTooLargeError) {
      return NextResponse.json({ error: "檔案過大" }, { status: 413 });
    }
    return NextResponse.json({ error: "請求格式錯誤" }, { status: 400 });
  }

  const { fileText, contactLabel } = (body ?? {}) as {
    fileText?: unknown;
    contactLabel?: unknown;
  };
  if (typeof fileText !== "string" || fileText.length === 0) {
    return NextResponse.json({ error: "缺少 fileText" }, { status: 400 });
  }
  if (fileText.length > MAX_FILE_CHARS) {
    return NextResponse.json({ error: "檔案過大（上限約 2 MB）" }, { status: 413 });
  }
  const label = typeof contactLabel === "string" ? contactLabel.trim() : "";
  if (label.length === 0 || label.length > MAX_LABEL_CHARS) {
    return NextResponse.json({ error: "contactLabel 須為 1–20 字" }, { status: 400 });
  }

  try {
    const result = importLineCorpus(db, { ownerId: userId, fileText, contactLabel: label });
    return NextResponse.json(result);
  } catch (e) {
    return mapChatError(e, "POST corpus/upload");
  }
}
