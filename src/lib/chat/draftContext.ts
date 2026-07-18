// 草稿情境組裝：把 DB 狀態轉成引擎需要的 BuildPromptInput（架構 §3 F1）。
//
// 語料決策：語料屬於使用者本人；對話可指定分類
// （conversationSettings.styleCategoryId），null = 通用 = 合併全部語料。
// 取出樣本後交 retrieval 分層抽樣；無樣本不阻擋（架構 §6 品質降級）。

import { and, desc, eq, lt } from "drizzle-orm";
import {
  conversations,
  conversationSettings,
  messages,
  styleCorpora,
  styleSamples,
  users,
} from "../db/schema";
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

  // 對話指定分類（null = 通用）；通用 = 本人全部語料，指定分類 = 只用該分類
  const setting = db
    .select()
    .from(conversationSettings)
    .where(
      and(
        eq(conversationSettings.userId, userId),
        eq(conversationSettings.conversationId, incoming.conversationId)
      )
    )
    .get();
  const categoryId = setting?.styleCategoryId ?? null;

  const samples = db
    .select({ text: styleSamples.text, sentAt: styleSamples.sentAt })
    .from(styleSamples)
    .innerJoin(styleCorpora, eq(styleSamples.corpusId, styleCorpora.id))
    .where(
      categoryId === null
        ? eq(styleCorpora.ownerId, userId)
        : and(eq(styleCorpora.ownerId, userId), eq(styleCorpora.categoryId, categoryId))
    )
    .all();

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
    styleSamples: styleSampleTexts,
    recentTurns,
    incomingText: incoming.text,
  };
}