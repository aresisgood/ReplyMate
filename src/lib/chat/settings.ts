// 每使用者 × 每對話的設定（autoReply 與 styleCategoryId，架構 §4.2b）。
//
// autoReply 預設 false = 人工確認（架構 ADR #7：自動回覆須為明確 opt-in，
// 保留 brief「人保有最終送出權」的精神）。
// styleCategoryId 預設 null = 通用（代筆使用本人全部語料）。

import { and, eq } from "drizzle-orm";
import { conversationSettings, styleCategories } from "../db/schema";
import type { AppDatabase } from "../db/types";
import { assertOwnedCategory } from "../corpus/categories";

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

export interface ConversationStyleCategory {
  id: string;
  name: string;
}

// 此對話代筆用的分類；null = 通用。join 取名稱，改名自動反映。
export function getStyleCategory(
  db: AppDatabase,
  userId: string,
  conversationId: string
): ConversationStyleCategory | null {
  const row = db
    .select({ id: styleCategories.id, name: styleCategories.name })
    .from(conversationSettings)
    .innerJoin(styleCategories, eq(conversationSettings.styleCategoryId, styleCategories.id))
    .where(whereUserAndConversation(userId, conversationId))
    .get();
  return row ?? null;
}

export function setStyleCategoryId(
  db: AppDatabase,
  userId: string,
  conversationId: string,
  categoryId: string | null
): void {
  if (categoryId !== null) assertOwnedCategory(db, userId, categoryId);
  const existing = db
    .select()
    .from(conversationSettings)
    .where(whereUserAndConversation(userId, conversationId))
    .get();

  if (existing) {
    db.update(conversationSettings)
      .set({ styleCategoryId: categoryId })
      .where(eq(conversationSettings.id, existing.id))
      .run();
  } else {
    db.insert(conversationSettings)
      .values({ userId, conversationId, styleCategoryId: categoryId })
      .run();
  }
}
