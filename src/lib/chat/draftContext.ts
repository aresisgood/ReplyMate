// 草稿情境組裝：把 DB 狀態轉成引擎需要的 BuildPromptInput（架構 §3 F1）。
//
// 語料對應決策：以「對方的 displayName」比對 styleCorpora.sourceName（該欄位
// 保存匯出檔中的對話對象名稱），取出其 contactLabel 與樣本。零 schema 變更，
// seed 的「王主管」即可對上「主管」語料。找不到時不阻擋——退化為無 few-shot
// 範例、以對方名稱當標籤（架構 §6：語料不足不阻擋，僅品質降級）。

import { and, desc, eq, lt } from "drizzle-orm";
import { conversations, messages, styleCorpora, styleSamples, users } from "../db/schema";
import type { AppDatabase } from "../db/types";
import { selectStyleSamples } from "../engine/retrieval";
import type { BuildPromptInput, ConversationTurn } from "../engine/prompt";
import { ForbiddenError, NotFoundError } from "./queries";

export const RECENT_TURNS = 6; // 架構 §6：對話最近 N=6 則

export interface DraftContextParams {
  messageId: string; // 要回覆的來訊
  userId: string; // 誰按了「AI 協助」
}

export function buildDraftContext(
  db: AppDatabase,
  { messageId, userId }: DraftContextParams
): BuildPromptInput {
  const incoming = db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!incoming) throw new NotFoundError("訊息不存在");

  const conversation = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, incoming.conversationId))
    .get();
  if (!conversation) throw new NotFoundError("對話不存在");

  if (conversation.userAId !== userId && conversation.userBId !== userId) {
    throw new ForbiddenError("非此對話的參與者");
  }
  // 代筆的前提是「回覆對方」——對自己的訊息要求草稿沒有意義。
  if (incoming.senderId === userId) {
    throw new ForbiddenError("不可對自己送出的訊息要求代筆");
  }

  const me = db.select().from(users).where(eq(users.id, userId)).get();
  if (!me) throw new NotFoundError("使用者不存在");

  const counterpart = db
    .select()
    .from(users)
    .where(eq(users.id, incoming.senderId))
    .get();
  if (!counterpart) throw new NotFoundError("對話對象不存在");

  // 依對方名稱找「我的」語料（只用自己的語料，不會誤用他人的）
  const corpus = db
    .select()
    .from(styleCorpora)
    .where(
      and(eq(styleCorpora.ownerId, userId), eq(styleCorpora.sourceName, counterpart.displayName))
    )
    .get();

  const samples = corpus
    ? db.select().from(styleSamples).where(eq(styleSamples.corpusId, corpus.id)).all()
    : [];

  const styleSampleTexts = selectStyleSamples(
    samples.map((s) => ({ text: s.text, sentAt: s.sentAt?.getTime() ?? null }))
  ).map((s) => s.text);

  // 對話近況：來訊「之前」的最後 N 則（查最新 N 則再反轉為升冪）
  const recent = db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, incoming.conversationId),
        lt(messages.createdAt, incoming.createdAt!)
      )
    )
    .orderBy(desc(messages.createdAt))
    .limit(RECENT_TURNS)
    .all()
    .reverse();

  const recentTurns: ConversationTurn[] = recent.map((m) => {
    const isSelf = m.senderId === userId;
    return {
      sender: isSelf ? me.displayName : counterpart.displayName,
      text: m.text,
      isSelf,
    };
  });

  return {
    displayName: me.displayName,
    contactLabel: corpus?.contactLabel ?? counterpart.displayName,
    styleSamples: styleSampleTexts,
    recentTurns,
    incomingText: incoming.text,
  };
}