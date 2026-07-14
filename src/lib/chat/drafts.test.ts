import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testDb";
import { tables } from "../db";
import type { AppDatabase } from "../db/types";
import { createDraftSession, finalizeDraft, getAdoptionStats } from "./drafts";
import { ForbiddenError, getMessagesAfter, NotFoundError } from "./queries";

let db: AppDatabase;
let me: { id: string };
let boss: { id: string };
let outsider: { id: string };
let convId: string;
let incomingId: string;

const T0 = 1_700_000_000_000;
const AI_DRAFT = "好的，我今晚整理完寄給您";

function user(username: string, displayName: string) {
  return db
    .insert(tables.users)
    .values({ username, passwordHash: "x", displayName })
    .returning()
    .get();
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

  incomingId = db
    .insert(tables.messages)
    .values({ conversationId: convId, senderId: boss.id, text: "急件", createdAt: new Date(T0) })
    .returning()
    .get().id;
});

function newDraft(mode: "manual" | "auto" = "manual") {
  return createDraftSession(db, {
    messageId: incomingId,
    userId: me.id,
    aiDraft: AI_DRAFT,
    mode,
  });
}

describe("createDraftSession", () => {
  it("建檔並回傳 draft（預設 mode=manual、尚未採用）", () => {
    const draft = newDraft();
    expect(draft.id).toBeTruthy();
    expect(draft.aiDraft).toBe(AI_DRAFT);
    expect(draft.mode).toBe("manual");
    expect(draft.adopted).toBe(false);
    expect(draft.finalText).toBeNull();
  });

  it("可建立 auto 模式的 draft", () => {
    expect(newDraft("auto").mode).toBe("auto");
  });
});

describe("finalizeDraft", () => {
  it("原封不動送出 → adopted=true，並寫入一則我的訊息", () => {
    const draft = newDraft();
    const result = finalizeDraft(db, { draftId: draft.id, userId: me.id, finalText: AI_DRAFT });

    expect(result.adopted).toBe(true);
    expect(result.message.text).toBe(AI_DRAFT);
    expect(result.message.senderId).toBe(me.id);

    // 訊息確實進了對話
    const all = getMessagesAfter(db, convId);
    expect(all.at(-1)?.text).toBe(AI_DRAFT);
  });

  it("大幅改寫 → adopted=false，訊息仍以改寫後的內容送出", () => {
    const draft = newDraft();
    const result = finalizeDraft(db, {
      draftId: draft.id,
      userId: me.id,
      finalText: "抱歉這週我沒空，下週再說",
    });

    expect(result.adopted).toBe(false);
    expect(result.message.text).toBe("抱歉這週我沒空，下週再說");
  });

  it("draft 記錄被更新（finalText 與 adopted 落地，供統計使用）", () => {
    const draft = newDraft();
    finalizeDraft(db, { draftId: draft.id, userId: me.id, finalText: AI_DRAFT });

    const stored = db
      .select()
      .from(tables.draftSessions)
      .where(eq(tables.draftSessions.id, draft.id))
      .get();
    expect(stored?.finalText).toBe(AI_DRAFT);
    expect(stored?.adopted).toBe(true);
  });

  it("非本人的 draft → ForbiddenError", () => {
    const draft = newDraft();
    expect(() =>
      finalizeDraft(db, { draftId: draft.id, userId: outsider.id, finalText: AI_DRAFT })
    ).toThrow(ForbiddenError);
  });

  it("draft 不存在 → NotFoundError", () => {
    expect(() =>
      finalizeDraft(db, { draftId: "no-such", userId: me.id, finalText: AI_DRAFT })
    ).toThrow(NotFoundError);
  });

  it("重複 finalize → 丟錯（避免同一次協助送出兩則訊息、污染統計）", () => {
    const draft = newDraft();
    finalizeDraft(db, { draftId: draft.id, userId: me.id, finalText: AI_DRAFT });
    expect(() =>
      finalizeDraft(db, { draftId: draft.id, userId: me.id, finalText: AI_DRAFT })
    ).toThrow();
  });

  it("空白定稿 → 丟錯（不可送出空訊息）", () => {
    const draft = newDraft();
    expect(() =>
      finalizeDraft(db, { draftId: draft.id, userId: me.id, finalText: "   " })
    ).toThrow();
  });
});

describe("getAdoptionStats", () => {
  it("無任何 draft 時，總數 0、採用率 0（不除以零）", () => {
    expect(getAdoptionStats(db, me.id)).toEqual({ total: 0, adopted: 0, rate: 0 });
  });

  it("只計已 finalize 的 manual draft，計算採用率", () => {
    const d1 = newDraft();
    finalizeDraft(db, { draftId: d1.id, userId: me.id, finalText: AI_DRAFT }); // 採用
    const d2 = newDraft();
    finalizeDraft(db, { draftId: d2.id, userId: me.id, finalText: "完全不同的內容改寫" }); // 未採用

    expect(getAdoptionStats(db, me.id)).toMatchObject({ total: 2, adopted: 1, rate: 0.5 });
  });

  it("auto 模式的 draft 不計入（避免自動送出灌水指標，架構 §4.5）", () => {
    const auto = newDraft("auto");
    finalizeDraft(db, { draftId: auto.id, userId: me.id, finalText: AI_DRAFT });

    expect(getAdoptionStats(db, me.id)).toEqual({ total: 0, adopted: 0, rate: 0 });
  });

  it("尚未 finalize 的 draft 不計入（還沒送出，談不上採用）", () => {
    newDraft();
    expect(getAdoptionStats(db, me.id)).toEqual({ total: 0, adopted: 0, rate: 0 });
  });

  it("只統計自己的 draft", () => {
    const d = newDraft();
    finalizeDraft(db, { draftId: d.id, userId: me.id, finalText: AI_DRAFT });
    expect(getAdoptionStats(db, boss.id)).toEqual({ total: 0, adopted: 0, rate: 0 });
  });
});