import { describe, it, expect, beforeAll } from "vitest";
import bcrypt from "bcryptjs";
import { createTestDb } from "../db/testDb";
import { tables } from "../db";
import { DUMMY_HASH, verifyCredentials } from "./password";
import type { AppDatabase } from "../db/types";

let db: AppDatabase;

beforeAll(async () => {
  db = createTestDb();
  const passwordHash = await bcrypt.hash("demo1234", 4); // 低 cost 加速測試
  db.insert(tables.users)
    .values({ username: "tingyu", passwordHash, displayName: "賴庭右" })
    .run();
});

describe("verifyCredentials", () => {
  it("帳密正確時回傳使用者（不含密碼雜湊）", async () => {
    const user = await verifyCredentials(db, "tingyu", "demo1234");
    expect(user).toMatchObject({ username: "tingyu", displayName: "賴庭右" });
    expect(user).not.toHaveProperty("passwordHash");
  });

  it("密碼錯誤時回 null", async () => {
    expect(await verifyCredentials(db, "tingyu", "wrong-password")).toBeNull();
  });

  it("帳號不存在時回 null", async () => {
    expect(await verifyCredentials(db, "nobody", "demo1234")).toBeNull();
  });
});

// 迴歸測試：防帳號列舉的時間側信道。
//
// 舊實作的 DUMMY_HASH 因為一個多餘的 .replace(" ", "") 只有 58 字元（合法
// bcrypt hash 為 60），bcrypt 直接判定格式無效並立刻回 false，完全沒做雜湊
// 運算。結果「帳號不存在」約 0.15ms、「密碼錯誤」約 54ms，攻擊者量測回應
// 時間即可列舉出哪些帳號存在。
describe("DUMMY_HASH（帳號列舉防護）", () => {
  it("是一個合法且與正式雜湊同強度的 bcrypt hash", () => {
    // 格式不合法的話 getRounds 會直接丟錯 —— 舊的 58 字元字串正是如此。
    expect(() => bcrypt.getRounds(DUMMY_HASH)).not.toThrow();
    // 與 scripts/seed.ts 的 cost 10 一致，兩條路徑的運算量才會相當。
    expect(bcrypt.getRounds(DUMMY_HASH)).toBe(10);
  });

  it("比對 DUMMY_HASH 會實際執行雜湊運算（不會提早短路）", async () => {
    const started = performance.now();
    const result = await bcrypt.compare("any-password", DUMMY_HASH);
    const elapsed = performance.now() - started;

    expect(result).toBe(false);
    // cost 10 的 bcrypt 至少數十毫秒；無效 hash 的短路只要 ~0.15ms。
    // 門檻取 5ms，遠低於真實運算又遠高於短路，不受機器效能影響。
    expect(elapsed).toBeGreaterThan(5);
  });
});
