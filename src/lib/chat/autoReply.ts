// 自動回覆（架構 §3 F4，ADR #7）
//
// 觸發點內建於送訊 API handler，無背景 worker：對方送訊 → 若「收訊方」對此
// 對話開啟了 autoReply，就以收訊方的身分與 key 生成回覆並直接送出。
//
// 關鍵取捨：
// - 每對話 opt-in、預設關閉——保留 brief「人保有最終送出權」的精神。
// - 記為 mode='auto' 且不計入採用率（成功指標 2 只看人工確認的協助）。
// - 生成失敗一律吞掉並回 null：來訊「已經送出」是既成事實，不能因為自動
//   回覆失敗而讓送訊者收到錯誤。失敗只記錄伺服器端日誌。
//
// 錯誤處理鐵律：本函式**永不 reject**。呼叫端（送訊 route）在回應送出後才
// 執行它，沒有人能 catch 它的錯誤——一旦漏出去就是 unhandled rejection，
// Node 15+ 預設直接終止程序。因此連 DB 讀取（getAutoReply）都必須在 try 內。

import { eq } from "drizzle-orm";
import { users } from "../db/schema";
import type { AppDatabase } from "../db/types";
import { generateDraft, type GenerateDraftParams, type GeneratedDraft } from "../engine";
import { buildDraftContext } from "./draftContext";
import { createDraftSession } from "./drafts";
import { isSafeAutoReply } from "./outputGuard";
import { postMessage, type ChatMessage } from "./queries";
import { getAutoReply } from "./settings";
import { autoReplyRateLimiter } from "../rateLimit";

export interface AutoReplyParams {
  conversationId: string;
  incomingMessageId: string;
  /** 收訊方（可能被代筆的那個人） */
  recipientId: string;
  envFallback?: string | null;
}

export interface AutoReplyDeps {
  /** 測試注入用；預設呼叫真實引擎。 */
  generate?: (params: GenerateDraftParams) => Promise<GeneratedDraft>;
}

export async function maybeAutoReply(
  db: AppDatabase,
  { conversationId, incomingMessageId, recipientId, envFallback }: AutoReplyParams,
  deps: AutoReplyDeps = {}
): Promise<ChatMessage | null> {
  const cooldownKey = `${recipientId}:${conversationId}`;
  let cooldownTaken = false;

  try {
    if (!getAutoReply(db, recipientId, conversationId)) return null;

    // 冷卻：對方連續灌訊息時，避免每則都觸發一次付費 LLM 呼叫（安全稽核 H-2）。
    // 每收訊方 × 每對話 10 秒內最多自動回覆一次。
    if (!autoReplyRateLimiter.check(cooldownKey)) return null;
    cooldownTaken = true;

    const generate = deps.generate ?? generateDraft;

    const prompt = buildDraftContext(db, {
      messageId: incomingMessageId,
      userId: recipientId,
    });

    const recipient = db.select().from(users).where(eq(users.id, recipientId)).get();

    const { aiDraft } = await generate({
      prompt,
      encryptedUserKey: recipient?.anthropicApiKeyEnc, // 費用歸收訊方（BYOK）
      envFallback,
    });

    // 輸出側防護（C-1）：自動送出未經人工審核，若草稿疑似洩露語料或異常長，
    // 靜默丟棄不送出。這道防線不依賴模型是否被說服。
    if (!isSafeAutoReply(aiDraft, prompt.styleSamples)) {
      console.warn("[autoReply] 草稿未通過輸出防護，略過自動回覆");
      return null;
    }

    const message = postMessage(db, conversationId, recipientId, aiDraft);

    createDraftSession(db, {
      messageId: incomingMessageId,
      userId: recipientId,
      aiDraft,
      mode: "auto",
      finalText: aiDraft, // 原文直接送出即定稿
    });

    return message;
  } catch (error) {
    // 冷卻額度是為了「限制實際發出的 LLM 呼叫」而扣的。這一輪既然失敗（多半是
    // 上游暫時性錯誤），就把額度還回去——否則對方在冷卻期內後續傳來的訊息會被
    // 靜默略過，使用者只會看到自動回覆莫名其妙不動作。
    if (cooldownTaken) autoReplyRateLimiter.release(cooldownKey);

    // 來訊已送出，自動回覆失敗不得往上冒泡影響送訊者。
    // 只記錄型別與訊息，避免完整 error 物件落日誌（安全稽核 L-4）。
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error("[autoReply] 自動回覆失敗，略過：", detail);
    return null;
  }
}
