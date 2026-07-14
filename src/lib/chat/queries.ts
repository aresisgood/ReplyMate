// 聊天查詢層（Week 4 API routes 的邏輯核心）
//
// 設計決策：
// - 所有函式接受注入的 db（AppDatabase），route 傳入單例、測試傳 in-memory。
// - 增量游標用 createdAt 毫秒數、嚴格大於——輪詢端以最後一則的 createdAtMs
//   作為下一次 after 參數（架構 §3 F3）。
// - Demo 規模（個位數對話）用逐對話子查詢換可讀性，不做 window function。

import { and, asc, desc, eq, gte, or } from "drizzle-orm";
import { conversations, messages, users } from "../db/schema";
import type { AppDatabase } from "../db/types";

// 型別化錯誤：route 層據此映射 HTTP status（404 / 403 / 400），
// 不必解析錯誤訊息字串。ValidationError 專指「使用者可修正」的輸入問題——
// 讓 route 只把這類錯誤的訊息回給客戶端，內部錯誤一律走泛用 500，避免
// SQLite 之類的內部細節外洩（安全稽核 M-3）。
export class NotFoundError extends Error {}
export class ForbiddenError extends Error {}
export class ValidationError extends Error {}

// 單則訊息長度上限（安全稽核 M-4）：避免超長輸入灌爆 DB，
// 並在之後被當成 incomingText 送進付費 LLM。
export const MAX_MESSAGE_LENGTH = 2000;

export interface ConversationSummary {
  conversationId: string;
  counterpartId: string;
  counterpartName: string;
  lastMessageText: string | null;
  lastActivityMs: number; // 最後訊息時間；無訊息時為對話建立時間
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  text: string;
  createdAtMs: number;
}

function toChatMessage(row: typeof messages.$inferSelect): ChatMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    text: row.text,
    createdAtMs: row.createdAt!.getTime(),
  };
}

export function listConversations(db: AppDatabase, userId: string): ConversationSummary[] {
  const convs = db
    .select()
    .from(conversations)
    .where(or(eq(conversations.userAId, userId), eq(conversations.userBId, userId)))
    .all();

  const summaries = convs.map((conv) => {
    const counterpartId = conv.userAId === userId ? conv.userBId : conv.userAId;
    const counterpart = db.select().from(users).where(eq(users.id, counterpartId)).get();
    const last = db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id))
      .orderBy(desc(messages.createdAt))
      .limit(1)
      .get();

    return {
      conversationId: conv.id,
      counterpartId,
      counterpartName: counterpart?.displayName ?? "(未知使用者)",
      lastMessageText: last?.text ?? null,
      lastActivityMs: (last?.createdAt ?? conv.createdAt!).getTime(),
    };
  });

  return [...summaries].sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}

export function getMessagesAfter(
  db: AppDatabase,
  conversationId: string,
  afterMs?: number
): ChatMessage[] {
  // at-or-after（gte）而非嚴格大於：同毫秒的多則訊息不會因游標推進而漏掉。
  // 邊界那則會被重複回傳，前端 mergeById 依 id 去重（審查 M-1）。
  const condition =
    afterMs === undefined
      ? eq(messages.conversationId, conversationId)
      : and(eq(messages.conversationId, conversationId), gte(messages.createdAt, new Date(afterMs)));

  return db
    .select()
    .from(messages)
    .where(condition)
    .orderBy(asc(messages.createdAt))
    .all()
    .map(toChatMessage);
}

export function postMessage(
  db: AppDatabase,
  conversationId: string,
  senderId: string,
  text: string
): ChatMessage {
  const trimmed = text.trim();
  if (!trimmed) throw new ValidationError("訊息不可為空");
  if ([...trimmed].length > MAX_MESSAGE_LENGTH) {
    throw new ValidationError(`訊息長度不可超過 ${MAX_MESSAGE_LENGTH} 字`);
  }

  const row = db
    .insert(messages)
    .values({ conversationId, senderId, text: trimmed })
    .returning()
    .get();

  return toChatMessage(row);
}

// 授權守衛：呼叫者必須是對話參與者，否則丟錯（route 轉為 403/404）。
// 回傳對話列，讓呼叫端不必再查一次（例如取對方 id）。
export function assertParticipant(
  db: AppDatabase,
  conversationId: string,
  userId: string
): typeof conversations.$inferSelect {
  const conv = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();

  if (!conv) throw new NotFoundError("對話不存在");
  if (conv.userAId !== userId && conv.userBId !== userId) {
    throw new ForbiddenError("非此對話的參與者");
  }
  return conv;
}
