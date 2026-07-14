// 每使用者 × 每對話的設定（目前只有 autoReply，架構 §4.2b）。
//
// 預設 false = 人工確認（架構 ADR #7：自動回覆須為明確 opt-in，
// 保留 brief「人保有最終送出權」的精神）。

import { and, eq } from "drizzle-orm";
import { conversationSettings } from "../db/schema";
import type { AppDatabase } from "../db/types";

function whereUserAndConversation(userId: string, conversationId: string) {
  return and(
    eq(conversationSettings.userId, userId),
    eq(conversationSettings.conversationId, conversationId)
  );
}

export function getAutoReply(db: AppDatabase, userId: string, conversationId: string): boolean {
  const row = db
    .select()
    .from(conversationSettings)
    .where(whereUserAndConversation(userId, conversationId))
    .get();

  return row?.autoReply ?? false;
}

// upsert：(userId, conversationId) 有唯一索引，重複設定只更新既有記錄。
export function setAutoReply(
  db: AppDatabase,
  userId: string,
  conversationId: string,
  autoReply: boolean
): boolean {
  const existing = db
    .select()
    .from(conversationSettings)
    .where(whereUserAndConversation(userId, conversationId))
    .get();

  if (existing) {
    db.update(conversationSettings)
      .set({ autoReply })
      .where(eq(conversationSettings.id, existing.id))
      .run();
  } else {
    db.insert(conversationSettings).values({ userId, conversationId, autoReply }).run();
  }

  return autoReply;
}
