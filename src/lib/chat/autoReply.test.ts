import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testDb";
import { tables } from "../db";
import type { AppDatabase } from "../db/types";
import { maybeAutoReply } from "./autoReply";
import { setAutoReply } from "./settings";
import { getAdoptionStats } from "./drafts";
import { getMessagesAfter } from "./queries";
import { resetRateLimiters } from "../rateLimit";

let db: AppDatabase;
let me: { id: string };
let boss: { id: string };
let convId: string;
let incomingId: string;

const T0 = 1_700_000_000_000;
const AI_DRAFT = "好的，我週六看一下合約再回您";

function user(username: string, displayName: string) {
  return db
    .insert(tables.users)
    .values({ username, passwordHash: "x", displayName })
    .returning()
    .get();
}

// 假引擎：不打真 API
function fakeGenerate(aiDraft = AI_DRAFT) {
  return vi.fn().mockResolvedValue({ aiDraft, keySource: "env" as const });
}

function run(generate: ReturnType<typeof fakeGenerate>) {
  return maybeAutoReply(
    db,
    {
      conversationId: convId,
      incomingMessageId: incomingId,
      recipientId: me.id, // 我是收訊方（要不要自動代我回覆）
      envFallback: "sk-env",
    },
    { generate }
  );
}

beforeEach(() => {
  resetRateLimiters();
  db = createTestDb();
  me = user("tingyu", "賴庭右");
  boss = user("boss", "王主管");

  convId = db
    .insert(tables.conversations)
    .values({ userAId: me.id, userBId: boss.id })
    .returning()
    .get().id;

  incomingId = db
    .insert(tables.messages)
    .values({
      conversationId: convId,
      senderId: boss.id,
      text: "週六幫我看一下合約，急",
      createdAt: new Date(T0),
    })
    .returning()
    .get().id;
});

describe("maybeAutoReply", () => {
  it("收訊方未開啟 autoReply → 不生成、不送訊（預設人工確認）", async () => {
    const generate = fakeGenerate();
    const result = await run(generate);

    expect(result).toBeNull();
    expect(generate).not.toHaveBeenCalled();
    expect(getMessagesAfter(db, convId)).toHaveLength(1); // 只有來訊
  });

  it("收訊方開啟 autoReply → 生成並直接送出回覆", async () => {
    setAutoReply(db, me.id, convId, true);
    const generate = fakeGenerate();

    const result = await run(generate);

    expect(generate).toHaveBeenCalledOnce();
    expect(result?.text).toBe(AI_DRAFT);
    expect(result?.senderId).toBe(me.id);

    const all = getMessagesAfter(db, convId);
    expect(all).toHaveLength(2);
    expect(all.at(-1)?.text).toBe(AI_DRAFT);
  });

  it("自動送出記為 mode='auto' 且已定稿", async () => {
    setAutoReply(db, me.id, convId, true);
    await run(fakeGenerate());

    const draft = db.select().from(tables.draftSessions).get();
    expect(draft?.mode).toBe("auto");
    expect(draft?.userId).toBe(me.id);
    expect(draft?.aiDraft).toBe(AI_DRAFT);
    expect(draft?.finalText).toBe(AI_DRAFT); // 原文直接送出
  });

  it("auto 模式不計入採用率（避免灌水指標，架構 §4.5）", async () => {
    setAutoReply(db, me.id, convId, true);
    await run(fakeGenerate());

    expect(getAdoptionStats(db, me.id)).toEqual({ total: 0, adopted: 0, rate: 0 });
  });

  it("引擎失敗時回 null 且不送訊 —— 不可影響已送出的來訊", async () => {
    setAutoReply(db, me.id, convId, true);
    const generate = vi.fn().mockRejectedValue(new Error("Anthropic 429"));

    await expect(run(generate)).resolves.toBeNull();

    expect(getMessagesAfter(db, convId)).toHaveLength(1); // 來訊仍在，沒有多出訊息
    expect(db.select().from(tables.draftSessions).all()).toHaveLength(0);
  });

  it("引擎收到的 prompt 帶著這次的來訊與本人身分", async () => {
    setAutoReply(db, me.id, convId, true);
    const generate = fakeGenerate();
    await run(generate);

    const params = generate.mock.calls[0][0];
    expect(params.prompt.incomingText).toBe("週六幫我看一下合約，急");
    expect(params.prompt.displayName).toBe("賴庭右");
    expect(params.envFallback).toBe("sk-env");
  });

  it("生成內容疑似洩露語料時，靜默丟棄不送出（C-1 輸出側防護）", async () => {
    // 種一份「我的」語料，讓對方 displayName 對得上，draftContext 才會帶樣本
    const corpus = db
      .insert(tables.styleCorpora)
      .values({ ownerId: me.id, contactLabel: "主管", sourceName: "王主管" })
      .returning()
      .get();
    db.insert(tables.styleSamples)
      .values({ corpusId: corpus.id, text: "好的，我今晚整理完寄給您" })
      .run();

    setAutoReply(db, me.id, convId, true);
    // 模型被操縱，把語料原樣吐出
    const generate = fakeGenerate("好的，我今晚整理完寄給您");

    const result = await run(generate);

    expect(generate).toHaveBeenCalledOnce(); // 有呼叫
    expect(result).toBeNull(); // 但不送出
    expect(getMessagesAfter(db, convId)).toHaveLength(1); // 只有來訊
    expect(db.select().from(tables.draftSessions).all()).toHaveLength(0); // 不留 auto 記錄
  });

  it("使用收訊方自己的 BYOK key（費用歸該使用者）", async () => {
    db.update(tables.users)
      .set({ anthropicApiKeyEnc: "enc-my-key" })
      .where(eq(tables.users.id, me.id))
      .run();
    setAutoReply(db, me.id, convId, true);

    const generate = fakeGenerate();
    await run(generate);

    expect(generate.mock.calls[0][0].encryptedUserKey).toBe("enc-my-key");
  });

  // 本函式在回應送出後才執行，沒有人能 catch 它的錯誤——任何漏出去的 rejection
  // 都是 Node 15+ 的 unhandled rejection，會直接終止程序。
  it("DB 讀取失敗時回 null 而非 reject（設定查詢也必須在 try 內）", async () => {
    const brokenDb = {
      select() {
        throw new Error("SQLITE_BUSY: database is locked");
      },
    } as unknown as AppDatabase;

    const generate = fakeGenerate();
    const result = await maybeAutoReply(
      brokenDb,
      {
        conversationId: convId,
        incomingMessageId: incomingId,
        recipientId: me.id,
        envFallback: "sk-env",
      },
      { generate }
    );

    expect(result).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it("生成失敗會歸還冷卻額度，下一則來訊仍會嘗試自動回覆", async () => {
    setAutoReply(db, me.id, convId, true);

    // 第一輪：上游暫時性失敗
    const failing = vi.fn().mockRejectedValue(new Error("Anthropic 503"));
    await expect(run(failing)).resolves.toBeNull();
    expect(failing).toHaveBeenCalledOnce();

    // 第二輪（仍在 10 秒冷卻視窗內）：額度已歸還，不該被靜默略過
    const succeeding = fakeGenerate();
    const result = await run(succeeding);

    expect(succeeding).toHaveBeenCalledOnce();
    expect(result?.text).toBe(AI_DRAFT);
  });

  it("成功後冷卻生效：同一對話連續來訊不會每則都打一次付費 API", async () => {
    setAutoReply(db, me.id, convId, true);

    await run(fakeGenerate());

    const second = fakeGenerate();
    await expect(run(second)).resolves.toBeNull();
    expect(second).not.toHaveBeenCalled(); // 冷卻中，沒有第二次 LLM 呼叫
  });
});
