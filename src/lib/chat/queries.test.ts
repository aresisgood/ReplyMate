import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../db/testDb";
import { tables } from "../db";
import type { AppDatabase } from "../db/types";
import {
  listConversations,
  getMessagesAfter,
  postMessage,
  assertParticipant,
  ValidationError,
  MAX_MESSAGE_LENGTH,
} from "./queries";

let db: AppDatabase;
let me: { id: string };
let boss: { id: string };
let friend: { id: string };
let outsider: { id: string };
let convBoss: { id: string };
let convFriend: { id: string };

// 固定時間軸，避免同毫秒碰撞導致排序/游標測試 flaky。
const T0 = 1_700_000_000_000;

function insertUser(username: string, displayName: string) {
  return db
    .insert(tables.users)
    .values({ username, passwordHash: "x", displayName })
    .returning()
    .get();
}

function insertMessage(conversationId: string, senderId: string, text: string, atMs: number) {
  return db
    .insert(tables.messages)
    .values({ conversationId, senderId, text, createdAt: new Date(atMs) })
    .returning()
    .get();
}

beforeEach(() => {
  db = createTestDb();
  me = insertUser("tingyu", "賴庭右");
  boss = insertUser("boss", "王主管");
  friend = insertUser("friend", "小美");
  outsider = insertUser("outsider", "路人");

  convBoss = db
    .insert(tables.conversations)
    .values({ userAId: me.id, userBId: boss.id })
    .returning()
    .get();
  convFriend = db
    .insert(tables.conversations)
    .values({ userAId: friend.id, userBId: me.id }) // 我在 userB 側，測雙向
    .returning()
    .get();

  insertMessage(convBoss.id, boss.id, "提案簡報進度如何？", T0);
  insertMessage(convBoss.id, me.id, "初稿完成八成了", T0 + 1000);
  insertMessage(convFriend.id, friend.id, "週末要不要爬山", T0 + 2000);
});

describe("listConversations", () => {
  it("列出我參與的對話，含對方 displayName 與最後一則預覽", () => {
    const list = listConversations(db, me.id);
    expect(list).toHaveLength(2);
    const withBoss = list.find((c) => c.conversationId === convBoss.id);
    expect(withBoss).toMatchObject({
      counterpartName: "王主管",
      lastMessageText: "初稿完成八成了",
    });
  });

  it("無論我在 userA 或 userB 側都能列出，對方名稱正確", () => {
    const list = listConversations(db, me.id);
    const withFriend = list.find((c) => c.conversationId === convFriend.id);
    expect(withFriend?.counterpartName).toBe("小美");
  });

  it("依最後活動時間降冪排序（最新對話在前）", () => {
    const list = listConversations(db, me.id);
    expect(list[0].conversationId).toBe(convFriend.id); // T0+2000 較新
    expect(list[1].conversationId).toBe(convBoss.id);
  });

  it("與我無關的對話不出現", () => {
    const list = listConversations(db, outsider.id);
    expect(list).toHaveLength(0);
  });

  it("沒有訊息的對話仍列出，預覽為 null", () => {
    const empty = db
      .insert(tables.conversations)
      .values({ userAId: me.id, userBId: outsider.id })
      .returning()
      .get();
    const list = listConversations(db, me.id);
    const found = list.find((c) => c.conversationId === empty.id);
    expect(found).toBeDefined();
    expect(found?.lastMessageText).toBeNull();
  });
});

describe("getMessagesAfter", () => {
  it("不帶游標時回傳全部訊息（時間升冪）", () => {
    const msgs = getMessagesAfter(db, convBoss.id);
    expect(msgs.map((m) => m.text)).toEqual(["提案簡報進度如何？", "初稿完成八成了"]);
  });

  it("帶游標時回傳 >= 游標的訊息（含邊界，交由前端依 id 去重）", () => {
    // 游標語意為 at-or-after：邊界那則會再回傳一次，前端 mergeById 去重（審查 M-1）
    const msgs = getMessagesAfter(db, convBoss.id, T0);
    expect(msgs.map((m) => m.text)).toEqual(["提案簡報進度如何？", "初稿完成八成了"]);
  });

  it("游標晚於所有訊息時回空陣列（輪詢無新訊息）", () => {
    expect(getMessagesAfter(db, convBoss.id, T0 + 1001)).toEqual([]);
  });

  // 迴歸測試：審查 M-1。兩則落在同一毫秒時，嚴格大於（gt）會讓其中一則
  // 在游標推進後永久漏掉；at-or-after（gte）+ 前端去重可保證都收得到。
  it("同毫秒的兩則訊息不會因游標而遺失", () => {
    insertMessage(convBoss.id, boss.id, "同毫秒A", T0 + 5000);
    insertMessage(convBoss.id, me.id, "同毫秒B", T0 + 5000);

    const msgs = getMessagesAfter(db, convBoss.id, T0 + 5000);
    expect(msgs.map((m) => m.text)).toEqual(["同毫秒A", "同毫秒B"]);
  });

  it("訊息帶 createdAtMs 數字欄位供前端當下一次游標", () => {
    const msgs = getMessagesAfter(db, convBoss.id);
    expect(msgs[msgs.length - 1].createdAtMs).toBe(T0 + 1000);
  });
});

describe("postMessage", () => {
  it("寫入訊息並回傳（含 id 與 createdAtMs）", () => {
    const msg = postMessage(db, convBoss.id, me.id, "收到，馬上處理");
    expect(msg.text).toBe("收到，馬上處理");
    expect(msg.id).toBeTruthy();
    expect(typeof msg.createdAtMs).toBe("number");
    const all = getMessagesAfter(db, convBoss.id);
    expect(all[all.length - 1].text).toBe("收到，馬上處理");
  });

  it("空白訊息丟錯（系統邊界驗證）", () => {
    expect(() => postMessage(db, convBoss.id, me.id, "   ")).toThrow();
  });

  it("前後空白會被修剪", () => {
    const msg = postMessage(db, convBoss.id, me.id, "  好的  ");
    expect(msg.text).toBe("好的");
  });

  it("超過長度上限丟 ValidationError（安全稽核 M-4）", () => {
    const tooLong = "字".repeat(MAX_MESSAGE_LENGTH + 1);
    expect(() => postMessage(db, convBoss.id, me.id, tooLong)).toThrow(ValidationError);
    // 剛好上限仍可通過
    expect(() => postMessage(db, convBoss.id, me.id, "字".repeat(MAX_MESSAGE_LENGTH))).not.toThrow();
  });
});

describe("assertParticipant", () => {
  it("參與者通過（不丟錯）", () => {
    expect(() => assertParticipant(db, convBoss.id, me.id)).not.toThrow();
    expect(() => assertParticipant(db, convBoss.id, boss.id)).not.toThrow();
  });

  it("非參與者丟錯（授權守衛）", () => {
    expect(() => assertParticipant(db, convBoss.id, outsider.id)).toThrow();
  });

  it("不存在的對話丟錯", () => {
    expect(() => assertParticipant(db, "no-such-conv", me.id)).toThrow();
  });
});