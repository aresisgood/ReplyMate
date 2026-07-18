import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../db/testDb";
import { tables } from "../db";
import type { AppDatabase } from "../db/types";
import {
  buildDraftContext,
  loadStyleSamplePool,
  MAX_SAMPLE_POOL,
  RECENT_TURNS,
} from "./draftContext";
import { ForbiddenError, NotFoundError } from "./queries";
import { createCategory } from "../corpus/categories";
import { setStyleCategoryId } from "./settings";

let db: AppDatabase;
let me: { id: string };
let boss: { id: string };
let outsider: { id: string };
let convId: string;
let incomingId: string; // 對方（boss）傳來、我要回覆的訊息
let myOwnMessageId: string;

const T0 = 1_700_000_000_000;

function user(username: string, displayName: string) {
  return db
    .insert(tables.users)
    .values({ username, passwordHash: "x", displayName })
    .returning()
    .get();
}

function message(senderId: string, text: string, atMs: number) {
  return db
    .insert(tables.messages)
    .values({ conversationId: convId, senderId, text, createdAt: new Date(atMs) })
    .returning()
    .get();
}

function seedCorpus(
  ownerId: string,
  sourceName: string,
  samples: string[],
  categoryId: string | null = null
) {
  const corpus = db
    .insert(tables.styleCorpora)
    .values({ ownerId, sourceName, categoryId })
    .returning()
    .get();
  db.insert(tables.styleSamples)
    .values(samples.map((text) => ({ corpusId: corpus.id, text })))
    .run();
  return corpus;
}

beforeEach(() => {
  db = createTestDb();
  me = user("tingyu", "賴庭右");
  boss = user("boss", "王主管");
  outsider = user("outsider", "路人");

  convId = db
    .insert(tables.conversations)
    .values({ userAId: me.id, userBId: boss.id })
    .returning()
    .get().id;

  // 8 則歷史（超過 RECENT_TURNS=6，測截斷）
  for (let i = 0; i < 7; i++) {
    message(i % 2 === 0 ? boss.id : me.id, `歷史訊息${i}`, T0 + i * 1000);
  }
  myOwnMessageId = message(me.id, "我自己說的話", T0 + 7000).id;
  incomingId = message(boss.id, "週六幫我看一下合約，急", T0 + 8000).id;

  // 使用者層級語料，預設通用（categoryId = null）
  seedCorpus(me.id, "王主管", [
    "好的，我今晚整理完寄給您",
    "了解，這部分我週三前處理好",
    "收到，我先確認一下細節再回覆您",
  ]);
});

describe("buildDraftContext", () => {
  it("組出引擎所需的 BuildPromptInput", () => {
    const ctx = buildDraftContext(db, { messageId: incomingId, userId: me.id });
    expect(ctx.displayName).toBe("賴庭右");
    expect(ctx.incomingText).toBe("週六幫我看一下合約，急");
  });

  it("未設定分類（通用）時取得本人全部語料樣本", () => {
    const ctx = buildDraftContext(db, { messageId: incomingId, userId: me.id });
    expect(ctx.styleSamples.length).toBeGreaterThan(0);
    expect(ctx.styleSamples).toContain("好的，我今晚整理完寄給您");
  });

  it("只用「我」的語料——別人的語料不會被誤用", () => {
    // outsider 也有一份語料，但不該進到我的 prompt
    seedCorpus(outsider.id, "王主管", ["這是路人的語氣，不該出現"]);
    const ctx = buildDraftContext(db, { messageId: incomingId, userId: me.id });
    expect(ctx.styleSamples).not.toContain("這是路人的語氣，不該出現");
  });

  it("通用（未設定）：合併所有分類的樣本", () => {
    const cat = createCategory(db, me.id, "朋友");
    seedCorpus(me.id, "陳小美", ["晚點打給你"], cat.id);
    const ctx = buildDraftContext(db, { messageId: incomingId, userId: me.id });
    expect(ctx.styleSamples).toContain("好的，我今晚整理完寄給您");
    expect(ctx.styleSamples).toContain("晚點打給你");
  });

  it("對話設了分類：只用該分類的樣本", () => {
    const cat = createCategory(db, me.id, "朋友");
    seedCorpus(me.id, "陳小美", ["晚點打給你"], cat.id);
    setStyleCategoryId(db, me.id, convId, cat.id);
    const ctx = buildDraftContext(db, { messageId: incomingId, userId: me.id });
    expect(ctx.styleSamples).toEqual(["晚點打給你"]);
  });

  it("分類下沒有語料：不阻擋，styleSamples 為空", () => {
    const cat = createCategory(db, me.id, "空分類");
    setStyleCategoryId(db, me.id, convId, cat.id);
    const ctx = buildDraftContext(db, { messageId: incomingId, userId: me.id });
    expect(ctx.styleSamples).toEqual([]);
  });

  it("對話近況取最後 6 則、時間升冪，且不含這次的來訊", () => {
    const ctx = buildDraftContext(db, { messageId: incomingId, userId: me.id });
    expect(ctx.recentTurns).toHaveLength(RECENT_TURNS);
    expect(ctx.recentTurns.at(-1)?.text).toBe("我自己說的話");
    expect(ctx.recentTurns.map((t) => t.text)).not.toContain("週六幫我看一下合約，急");
    // 來訊前共 8 則（歷史訊息0..6 + 我自己說的話），取最後 6 則 → 從「歷史訊息2」起
    expect(ctx.recentTurns[0].text).toBe("歷史訊息2");
  });

  it("recentTurns 正確標記 isSelf 與說話者名稱", () => {
    const ctx = buildDraftContext(db, { messageId: incomingId, userId: me.id });
    const mine = ctx.recentTurns.find((t) => t.text === "我自己說的話");
    expect(mine).toMatchObject({ isSelf: true, sender: "賴庭右" });
    const theirs = ctx.recentTurns.find((t) => t.text === "歷史訊息4");
    expect(theirs).toMatchObject({ isSelf: false, sender: "王主管" });
  });

  it("使用者沒有任何語料時不阻擋，styleSamples 為空（架構 §6：語料不足不阻擋）", () => {
    // boss 沒有任何語料，對我的訊息要求代筆時不該阻擋
    const ctx = buildDraftContext(db, { messageId: myOwnMessageId, userId: boss.id });
    expect(ctx.styleSamples).toEqual([]);
    expect(ctx.incomingText).toBe("我自己說的話");
  });

  it("樣本池有上限——大量語料不會全數載入記憶體", () => {
    // beforeEach 已 seed 3 句；再灌超過上限的量（分批避開 SQLite 參數上限）
    const extra = MAX_SAMPLE_POOL + 50;
    for (let i = 0; i < extra; i += 100) {
      const batch = Array.from(
        { length: Math.min(100, extra - i) },
        (_, j) => `大量樣本 ${i + j}`
      );
      seedCorpus(me.id, `來源${i}`, batch);
    }

    const pool = loadStyleSamplePool(db, me.id, null);
    expect(pool.length).toBe(MAX_SAMPLE_POOL);
    // 走完整流程仍正常運作，回傳的 few-shot 數量不受影響
    const ctx = buildDraftContext(db, { messageId: incomingId, userId: me.id });
    expect(ctx.styleSamples.length).toBeGreaterThan(0);
    expect(ctx.styleSamples.length).toBeLessThanOrEqual(15);
  });

  it("非對話參與者要求代筆 → ForbiddenError", () => {
    expect(() => buildDraftContext(db, { messageId: incomingId, userId: outsider.id })).toThrow(
      ForbiddenError
    );
  });

  it("不可對自己送出的訊息要求代筆 → ForbiddenError", () => {
    expect(() => buildDraftContext(db, { messageId: myOwnMessageId, userId: me.id })).toThrow(
      ForbiddenError
    );
  });

  it("訊息不存在 → NotFoundError", () => {
    expect(() => buildDraftContext(db, { messageId: "no-such", userId: me.id })).toThrow(
      NotFoundError
    );
  });
});
