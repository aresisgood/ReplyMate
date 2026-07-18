// importLineCorpus / listCorpora 單元測試：解析→過濾→整組取代的完整語意。
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testDb";
import type { AppDatabase } from "../db/types";
import { styleCorpora, styleSamples, users } from "../db/schema";
import { ValidationError } from "../chat/queries";
import { importLineCorpus, listCorpora } from "./corpus";
import { createCategory } from "./categories";

// 我方（賴庭右）發言 4 則：2 則有效、[貼圖] 濾除、「嗯」過短濾除
const EXPORT_FIXTURE = [
  "[LINE] 與王主管的聊天記錄",
  "儲存日期： 2026/06/01 12:34",
  "",
  "2026/05/20（三）",
  "下午3:24\t賴庭右\t好的沒問題",
  "下午3:25\t王主管\t明天會議提前到九點",
  "下午3:26\t賴庭右\t收到，我會先把資料準備好",
  "下午3:27\t賴庭右\t[貼圖]",
  "下午3:28\t賴庭右\t嗯",
].join("\n");

// 只有對方發言 → 無可用樣本
const CONTACT_ONLY_FIXTURE = [
  "[LINE] 與王主管的聊天記錄",
  "",
  "2026/05/20（三）",
  "下午3:25\t王主管\t明天會議提前到九點",
].join("\n");

let db: AppDatabase;
let ownerId: string;

beforeEach(() => {
  db = createTestDb();
  ownerId = db
    .insert(users)
    .values({ username: "tingyu", passwordHash: "x", displayName: "賴庭右" })
    .returning()
    .get().id;
});

describe("importLineCorpus", () => {
  it("匯入成功：建 corpus + 過濾後樣本，sourceName 取自標頭", () => {
    const result = importLineCorpus(db, {
      ownerId,
      fileText: EXPORT_FIXTURE,
    });

    expect(result).toMatchObject({
      sourceName: "王主管",
      categoryId: null,
      sampleCount: 2,
      replaced: false,
    });

    const rows = db
      .select()
      .from(styleSamples)
      .where(eq(styleSamples.corpusId, result.corpusId))
      .all();
    expect(rows.map((r) => r.text)).toEqual(["好的沒問題", "收到，我會先把資料準備好"]);
    // sentAt 由 date+time 還原（下午3:24 → 15:24 當地時間）
    expect(rows[0].sentAt).toEqual(new Date("2026-05-20T15:24:00"));
  });

  it("我方名字取自檔案發言者，與 app displayName 無關", () => {
    // 換一個 displayName 完全不同的使用者上傳同一檔案，仍能萃取
    const otherId = db
      .insert(users)
      .values({ username: "other", passwordHash: "x", displayName: "完全不同的名字" })
      .returning()
      .get().id;
    const result = importLineCorpus(db, {
      ownerId: otherId,
      fileText: EXPORT_FIXTURE,
    });
    expect(result.sampleCount).toBe(2);
  });

  it("同 owner 同 sourceName 重傳：整組取代且可換分類", () => {
    const cat = createCategory(db, ownerId, "主管");
    const first = importLineCorpus(db, { ownerId, fileText: EXPORT_FIXTURE });
    const second = importLineCorpus(db, {
      ownerId,
      fileText: EXPORT_FIXTURE,
      categoryId: cat.id,
    });

    expect(first.replaced).toBe(false);
    expect(second.replaced).toBe(true);
    expect(second.corpusId).not.toBe(first.corpusId);

    const corpora = db
      .select()
      .from(styleCorpora)
      .where(eq(styleCorpora.ownerId, ownerId))
      .all();
    expect(corpora).toHaveLength(1);
    expect(corpora[0].categoryId).toBe(cat.id);

    const orphans = db
      .select()
      .from(styleSamples)
      .where(eq(styleSamples.corpusId, first.corpusId))
      .all();
    expect(orphans).toHaveLength(0);
  });

  it("categoryId 不存在或非本人 → ValidationError，不寫入資料", () => {
    expect(() =>
      importLineCorpus(db, { ownerId, fileText: EXPORT_FIXTURE, categoryId: "no-such" })
    ).toThrow(ValidationError);
    expect(db.select().from(styleCorpora).all()).toHaveLength(0);
  });

  it("無 LINE 標頭：ValidationError（無法辨識格式）", () => {
    expect(() =>
      importLineCorpus(db, { ownerId, fileText: "隨便的內容" })
    ).toThrow(ValidationError);
  });

  it("只有對方發言：ValidationError（無可用樣本），且不寫入任何資料", () => {
    expect(() =>
      importLineCorpus(db, { ownerId, fileText: CONTACT_ONLY_FIXTURE })
    ).toThrow(ValidationError);
    expect(db.select().from(styleCorpora).all()).toHaveLength(0);
  });
});

describe("listCorpora", () => {
  it("列出本人語料含句數；不含他人的", () => {
    importLineCorpus(db, { ownerId, fileText: EXPORT_FIXTURE });
    const otherId = db
      .insert(users)
      .values({ username: "other", passwordHash: "x", displayName: "路人" })
      .returning()
      .get().id;
    importLineCorpus(db, { ownerId: otherId, fileText: EXPORT_FIXTURE });

    const mine = listCorpora(db, ownerId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      sourceName: "王主管",
      categoryId: null,
      categoryName: null,
      sampleCount: 2,
    });
    expect(mine[0].createdAtMs).toBeTypeOf("number");
  });

  it("無語料時回空陣列", () => {
    expect(listCorpora(db, ownerId)).toEqual([]);
  });
});
