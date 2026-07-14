// POST /api/drafts — { messageId } → 產生 AI 回覆草稿（架構 §3 F1）
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db, tables } from "@/lib/db";
import { requireUser, mapChatError } from "@/lib/http";
import { generateDraft } from "@/lib/engine";
import { buildDraftContext } from "@/lib/chat/draftContext";
import { createDraftSession } from "@/lib/chat/drafts";
import { draftRateLimiter } from "@/lib/rateLimit";

export async function POST(request: NextRequest) {
  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;
  const userId = auth;

  // 付費 LLM 端點：每使用者限流，避免燒光 API 金鑰（安全稽核 H-2）
  if (!draftRateLimiter.check(userId)) {
    return NextResponse.json({ error: "請求過於頻繁，請稍後再試" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "請求格式錯誤" }, { status: 400 });
  }

  const { messageId } = (body ?? {}) as { messageId?: unknown };
  if (typeof messageId !== "string" || !messageId) {
    return NextResponse.json({ error: "缺少 messageId" }, { status: 400 });
  }

  // 情境組裝（含授權：須為參與者、且不可對自己的訊息代筆）
  let prompt;
  try {
    prompt = buildDraftContext(db, { messageId, userId });
  } catch (e) {
    return mapChatError(e, "POST drafts");
  }

  const me = db.select().from(tables.users).where(eq(tables.users.id, userId)).get();

  try {
    const { aiDraft } = await generateDraft({
      prompt,
      encryptedUserKey: me?.anthropicApiKeyEnc, // BYOK：費用歸使用者
      envFallback: process.env.ANTHROPIC_API_KEY,
    });

    const draft = createDraftSession(db, { messageId, userId, aiDraft, mode: "manual" });
    return NextResponse.json({ draftId: draft.id, aiDraft });
  } catch (error) {
    // 上游（Anthropic）失敗——只記錄型別與訊息，避免完整 error 物件把敏感
    // 內容（含可能的憑證）落進日誌（安全稽核 L-4）；回使用者友善訊息。
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error("[POST /api/drafts] 草稿生成失敗：", detail);
    return NextResponse.json({ error: "草稿生成失敗，請稍後再試" }, { status: 502 });
  }
}
