import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../db/testDb";
import { users } from "../db/schema";
import type { AppDatabase } from "../db/types";
import { ValidationError, NotFoundError } from "../chat/queries";
import { createCategory, listCategories, renameCategory, assertOwnedCategory } from "./categories";

let db: AppDatabase;
let ownerId: string;
let otherId: string;

function user(username: string): string {
  return db
    .insert(users)
    .values({ username, passwordHash: "x", displayName: username })
    .returning()
    .get().id;
}

beforeEach(() => {
  db = createTestDb();
  ownerId = user("a");
  otherId = user("b");
});

describe("createCategory / listCategories", () => {
  it("建立分類並列出（只含本人的）", () => {
    const cat = createCategory(db, ownerId, "主管");
    createCategory(db, otherId, "別人的");
    expect(listCategories(db, ownerId)).toEqual([{ id: cat.id, name: "主管" }]);
  });

  it("名稱 trim 後為空或超過 20 字 → ValidationError", () => {
    expect(() => createCategory(db, ownerId, "   ")).toThrow(ValidationError);
    expect(() => createCategory(db, ownerId, "一".repeat(21))).toThrow(ValidationError);
  });

  it("長度以 Unicode code point 計——20 個 emoji（40 UTF-16 單位）可建立", () => {
    expect(() => createCategory(db, ownerId, "😀".repeat(20))).not.toThrow();
    expect(() => createCategory(db, ownerId, "😀".repeat(21))).toThrow(ValidationError);
  });

  it("同 owner 重名 → ValidationError；不同 owner 可同名", () => {
    createCategory(db, ownerId, "主管");
    expect(() => createCategory(db, ownerId, "主管")).toThrow(ValidationError);
    expect(() => createCategory(db, otherId, "主管")).not.toThrow();
  });

  it("保留名稱「通用」不可建立", () => {
    expect(() => createCategory(db, ownerId, "通用")).toThrow(ValidationError);
  });
});

describe("renameCategory", () => {
  it("重新命名後清單反映新名稱", () => {
    const cat = createCategory(db, ownerId, "主管");
    renameCategory(db, ownerId, cat.id, "直屬主管");
    expect(listCategories(db, ownerId)).toEqual([{ id: cat.id, name: "直屬主管" }]);
  });

  it("改成既有名稱或「通用」→ ValidationError；非本人分類 → NotFoundError", () => {
    const a = createCategory(db, ownerId, "主管");
    createCategory(db, ownerId, "朋友");
    expect(() => renameCategory(db, ownerId, a.id, "朋友")).toThrow(ValidationError);
    expect(() => renameCategory(db, ownerId, a.id, "通用")).toThrow(ValidationError);
    const theirs = createCategory(db, otherId, "同事");
    expect(() => renameCategory(db, ownerId, theirs.id, "新名")).toThrow(NotFoundError);
  });

  it("改名為自己目前的名稱不算重名", () => {
    const a = createCategory(db, ownerId, "主管");
    expect(() => renameCategory(db, ownerId, a.id, "主管")).not.toThrow();
  });
});

describe("assertOwnedCategory", () => {
  it("本人分類通過；不存在或他人的 → ValidationError", () => {
    const a = createCategory(db, ownerId, "主管");
    expect(() => assertOwnedCategory(db, ownerId, a.id)).not.toThrow();
    expect(() => assertOwnedCategory(db, ownerId, "no-such-id")).toThrow(ValidationError);
    const theirs = createCategory(db, otherId, "同事");
    expect(() => assertOwnedCategory(db, ownerId, theirs.id)).toThrow(ValidationError);
  });
});
