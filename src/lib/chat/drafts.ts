// 草稿資料層：draft_sessions 的建檔、定稿與採用率統計（架構 §4.5）。
//
// 「一次 AI 協助 = 一筆 draft_session」。定稿（finalize）時計算編輯距離決定
// adopted，並把定稿內容寫成一則真正的訊息——這是成功指標 2 的唯一資料來源。
//
// mode 語意：
//   'manual'：使用者按「AI 協助」、確認後送出 → 計入採用率
//   'auto'  ：autoReply 開啟時系統直接送出 → 不計入（避免灌水指標）

import { and, eq, isNotNull } from "drizzle-orm";
import { draftSessions, messages } from "../db/schema";
import type { AppDatabase } from "../db/types";
import { isAdopted } from "./editDistance";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  postMessage,
  type ChatMessage,
} from "./queries";

export type DraftMode = "manual" | "auto";

export interface DraftSession {
  id: string;
  messageId: string;
  userId: string;
  aiDraft: string;
  finalText: string | null;
  adopted: boolean;
  mode: string;
}

export interface CreateDraftParams {
  messageId: string;
  userId: string;
  aiDraft: string;
  mode?: DraftMode;
  // auto 模式一建檔即定稿（原文直接送出）。manual 模式留給 finalizeDraft 填。
  finalText?: string;
}

export function createDraftSession(
  db: AppDatabase,
  { messageId, userId, aiDraft, mode = "manual", finalText }: CreateDraftParams
): DraftSession {
  return db
    .insert(draftSessions)
    .values({ messageId, userId, aiDraft, mode, finalText })
    .returning()
    .get();
}

export interface FinalizeParams {
  draftId: string;
  userId: string;
  finalText: string;
}

export interface FinalizeResult {
  message: ChatMessage;
  adopted: boolean;
}

export function finalizeDraft(
  db: AppDatabase,
  { draftId, userId, finalText }: FinalizeParams
): FinalizeResult {
  const draft = db.select().from(draftSessions).where(eq(draftSessions.id, draftId)).get();
  if (!draft) throw new NotFoundError("草稿不存在");
  if (draft.userId !== userId) throw new ForbiddenError("非此草稿的擁有者");

  // 同一次協助只能定稿一次——否則會送出兩則訊息並重複計入統計。
  if (draft.finalText !== null) throw new ValidationError("此草稿已定稿，不可重複送出");

  const text = finalText.trim();
  if (!text) throw new ValidationError("訊息不可為空");

  // 定稿的訊息屬於來訊所在的對話
  const incoming = db.select().from(messages).where(eq(messages.id, draft.messageId)).get();
  if (!incoming) throw new NotFoundError("來訊不存在");

  const adopted = isAdopted(draft.aiDraft, text);
  const message = postMessage(db, incoming.conversationId, userId, text);

  db.update(draftSessions)
    .set({ finalText: text, adopted })
    .where(eq(draftSessions.id, draftId))
    .run();

  return { message, adopted };
}

export interface AdoptionStats {
  total: number;
  adopted: number;
  rate: number; // 0..1
}

// 採用率：只計「已定稿」且「mode='manual'」的協助（架構 §4.5）。
export function getAdoptionStats(db: AppDatabase, userId: string): AdoptionStats {
  const rows = db
    .select()
    .from(draftSessions)
    .where(
      and(
        eq(draftSessions.userId, userId),
        eq(draftSessions.mode, "manual"),
        isNotNull(draftSessions.finalText)
      )
    )
    .all();

  const total = rows.length;
  const adopted = rows.filter((r) => r.adopted).length;

  return { total, adopted, rate: total === 0 ? 0 : adopted / total };
}
