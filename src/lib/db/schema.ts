// ReplyMate — Drizzle schema (v2 資料結構)
// 設計原則：只做 1 對 1 對話（無群組 = 無特殊情況）；
// 風格語料（styleCorpora）與聊天系統（conversations/messages）解耦。

import { randomUUID } from "node:crypto";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID());

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date());

export const users = sqliteTable("users", {
  id: id(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  // BYOK：使用者自己的 Anthropic API key，以 AES-256-GCM 加密存放（見 lib/crypto.ts）。
  // null = 未設定，AI 呼叫時 fallback 到 .env 的開發用 key。
  anthropicApiKeyEnc: text("anthropic_api_key_enc"),
  createdAt: createdAt(),
});

export const conversations = sqliteTable(
  "conversations",
  {
    id: id(),
    userAId: text("user_a_id")
      .notNull()
      .references(() => users.id),
    userBId: text("user_b_id")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("conversations_pair_unique").on(t.userAId, t.userBId)]
);

// 每位使用者對「單一對話」的個人設定。
// autoReply = true：收到來訊時由引擎直接生成並送出（draft_sessions.mode = 'auto'）。
// 預設 false（人工確認），維持 brief 期望成果 4 的精神；自動模式為明確 opt-in。
export const conversationSettings = sqliteTable(
  "conversation_settings",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    autoReply: integer("auto_reply", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [uniqueIndex("conversation_settings_unique").on(t.userId, t.conversationId)]
);

export const messages = sqliteTable(
  "messages",
  {
    id: id(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    senderId: text("sender_id")
      .notNull()
      .references(() => users.id),
    text: text("text").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("messages_conversation_time_idx").on(t.conversationId, t.createdAt)]
);

// 使用者上傳 LINE 匯出檔後建立的風格語料。
// contactLabel 標記語料來源的對話對象類型（主管/同事/朋友…），
// Week 2 引擎依對象類型挑選 few-shot 範例。
export const styleCorpora = sqliteTable(
  "style_corpora",
  {
    id: id(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    contactLabel: text("contact_label").notNull(),
    sourceName: text("source_name").notNull(), // 原始匯出檔中的對話對象名稱
    createdAt: createdAt(),
  },
  (t) => [index("style_corpora_owner_idx").on(t.ownerId)]
);

export const styleSamples = sqliteTable(
  "style_samples",
  {
    id: id(),
    corpusId: text("corpus_id")
      .notNull()
      .references(() => styleCorpora.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }), // 原訊息時間（可得時保留）
  },
  (t) => [index("style_samples_corpus_idx").on(t.corpusId)]
);

// 一次「AI 協助回覆」的完整記錄。
// adopted = finalText 與 aiDraft 幾乎相同（edit distance ≈ 0）→ 餵成功指標 2 的採用率。
export const draftSessions = sqliteTable(
  "draft_sessions",
  {
    id: id(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id), // 回覆的是哪一則來訊
    userId: text("user_id")
      .notNull()
      .references(() => users.id), // 誰按了 AI 協助
    aiDraft: text("ai_draft").notNull(),
    finalText: text("final_text"),
    adopted: integer("adopted", { mode: "boolean" }).notNull().default(false),
    // 'manual'：使用者按 AI 協助、確認後送出 → 計入採用率（成功指標 2）
    // 'auto'  ：autoReply 開啟時由系統直接送出 → 不計入採用率，避免指標灌水
    mode: text("mode").notNull().default("manual"),
    toneAdjustments: text("tone_adjustments"), // JSON array，例如 ["formal","shorter"]
    createdAt: createdAt(),
  },
  (t) => [index("draft_sessions_user_time_idx").on(t.userId, t.createdAt)]
);
