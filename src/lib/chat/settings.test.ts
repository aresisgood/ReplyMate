import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../db/testDb";
import { tables } from "../db";
import type { AppDatabase } from "../db/types";
import { getAutoReply, setAutoReply, getStyleCategory, setStyleCategoryId } from "./settings";
import { createCategory, renameCategory } from "../corpus/categories";
import { ValidationError } from "./queries";

let db: AppDatabase;
let me: { id: string };
let boss: { id: string };
let convId: string;

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
  convId = db
    .insert(tables.conversations)
    .values({ userAId: me.id, userBId: boss.id })
    .returning()
    .get().id;
});

describe("getAutoReply", () => {
  it("未設定過時預設為 false（人工確認，架構 ADR #7）", () => {
    expect(getAutoReply(db, me.id, convId)).toBe(false);
  });
});

describe("setAutoReply", () => {
  it("首次設定會建立記錄", () => {
    expect(setAutoReply(db, me.id, convId, true)).toBe(true);
    expect(getAutoReply(db, me.id, convId)).toBe(true);
  });

  it("重複設定同一對話不會產生第二筆（upsert，不違反唯一索引）", () => {
    setAutoReply(db, me.id, convId, true);
    setAutoReply(db, me.id, convId, false);

    expect(getAutoReply(db, me.id, convId)).toBe(false);
    const rows = db.select().from(tables.conversationSettings).all();
    expect(rows).toHaveLength(1);
  });

  it("設定是「每使用者 × 每對話」——我開啟不影響對方", () => {
    setAutoReply(db, me.id, convId, true);

    expect(getAutoReply(db, me.id, convId)).toBe(true);
    expect(getAutoReply(db, boss.id, convId)).toBe(false);
  });
});

describe("styleCategory get/set", () => {
  it("預設為 null（通用）", () => {
    expect(getStyleCategory(db, me.id, convId)).toBeNull();
  });

  it("set 後 get 回分類 id 與名稱；rename 後名稱跟著變", () => {
    const cat = createCategory(db, me.id, "主管");
    setStyleCategoryId(db, me.id, convId, cat.id);
    expect(getStyleCategory(db, me.id, convId)).toEqual({ id: cat.id, name: "主管" });
    renameCategory(db, me.id, cat.id, "直屬主管");
    expect(getStyleCategory(db, me.id, convId)?.name).toBe("直屬主管");
  });

  it("set null 回到通用；不影響同列的 autoReply", () => {
    const cat = createCategory(db, me.id, "主管");
    setAutoReply(db, me.id, convId, true);
    setStyleCategoryId(db, me.id, convId, cat.id);
    setStyleCategoryId(db, me.id, convId, null);
    expect(getStyleCategory(db, me.id, convId)).toBeNull();
    expect(getAutoReply(db, me.id, convId)).toBe(true);
  });

  it("set 非本人分類 → ValidationError", () => {
    const theirs = createCategory(db, boss.id, "同事");
    expect(() => setStyleCategoryId(db, me.id, convId, theirs.id)).toThrow(ValidationError);
  });
});
