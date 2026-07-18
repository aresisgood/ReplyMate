// corpus API 整合測試：匯入語意已在 lib 層單元測過，這裡守
// 401/驗證邊界/413/429、分類（categoryId）與 happy path。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { NextRequest } from "next/server";
import * as schema from "../../lib/db/schema";
import { resetRateLimiters } from "../../lib/rateLimit";

beforeEach(() => resetRateLimiters());

const tmpDir = mkdtempSync(path.join(tmpdir(), "replymate-corpus-"));
const DB_FILE = path.join(tmpDir, "test.db");
process.env.DATABASE_FILE = DB_FILE;
process.env.APP_SECRET = "test-secret-for-unit-tests-only";

let loginRoute: typeof import("./auth/login/route");
let uploadRoute: typeof import("./corpus/upload/route");
let listRoute: typeof import("./corpus/route");
let categoriesRoute: typeof import("./categories/route");

let cookie: string;

const EXPORT_FIXTURE = [
  "[LINE] 與王主管的聊天記錄",
  "",
  "2026/05/20（三）",
  "下午3:24\t賴庭右\t好的沒問題",
  "下午3:25\t王主管\t明天會議提前到九點",
  "下午3:26\t賴庭右\t收到，我會先把資料準備好",
].join("\n");

function jsonRequest(url: string, body: unknown, c?: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(c ? { cookie: c } : {}) },
    body: JSON.stringify(body),
  });
}

function getRequest(url: string, c?: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, { headers: c ? { cookie: c } : {} });
}

async function createCategory(name: string): Promise<string> {
  const res = await categoriesRoute.POST(jsonRequest("/api/categories", { name }, cookie));
  return (await res.json()).id;
}

beforeAll(async () => {
  const sqlite = new Database(DB_FILE);
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  const passwordHash = await bcrypt.hash("demo1234", 4);
  db.insert(schema.users)
    .values({ username: "tingyu", passwordHash, displayName: "賴庭右" })
    .run();
  sqlite.close();

  loginRoute = await import("./auth/login/route");
  uploadRoute = await import("./corpus/upload/route");
  listRoute = await import("./corpus/route");
  categoriesRoute = await import("./categories/route");

  const res = await loginRoute.POST(
    jsonRequest("/api/auth/login", { username: "tingyu", password: "demo1234" })
  );
  cookie = `rm_session=${res.cookies.get("rm_session")?.value}`;
});

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* Windows 上連線未釋放時忽略 */
  }
});

describe("POST /api/corpus/upload", () => {
  it("未登入：401", async () => {
    const res = await uploadRoute.POST(
      jsonRequest("/api/corpus/upload", { fileText: EXPORT_FIXTURE })
    );
    expect(res.status).toBe(401);
  });

  it("缺 fileText：400", async () => {
    const res = await uploadRoute.POST(jsonRequest("/api/corpus/upload", {}, cookie));
    expect(res.status).toBe(400);
  });

  it("檔案超過字元上限：413", async () => {
    const res = await uploadRoute.POST(
      jsonRequest("/api/corpus/upload", { fileText: "a".repeat(2_097_153) }, cookie)
    );
    expect(res.status).toBe(413);
  });

  it("request body 超過位元組上限：413（在解析 JSON 之前就擋下）", async () => {
    // 9 MiB > 8 MiB 上限；fileText 的字元檢查根本輪不到就已回 413
    const res = await uploadRoute.POST(
      jsonRequest("/api/corpus/upload", { fileText: "a".repeat(9 * 1024 * 1024) }, cookie)
    );
    expect(res.status).toBe(413);
  });

  it("格式無法辨識：400 + { error }", async () => {
    const res = await uploadRoute.POST(
      jsonRequest("/api/corpus/upload", { fileText: "不是匯出檔" }, cookie)
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });

  it("categoryId 格式錯誤（非字串/null）：400", async () => {
    const res = await uploadRoute.POST(
      jsonRequest("/api/corpus/upload", { fileText: EXPORT_FIXTURE, categoryId: 123 }, cookie)
    );
    expect(res.status).toBe(400);
  });

  it("categoryId 不存在：400", async () => {
    const res = await uploadRoute.POST(
      jsonRequest(
        "/api/corpus/upload",
        { fileText: EXPORT_FIXTURE, categoryId: "no-such" },
        cookie
      )
    );
    expect(res.status).toBe(400);
  });

  it("happy path：200 + 匯入結果（categoryId=null）；重傳回 replaced=true", async () => {
    const res = await uploadRoute.POST(
      jsonRequest("/api/corpus/upload", { fileText: EXPORT_FIXTURE }, cookie)
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      sourceName: "王主管",
      categoryId: null,
      sampleCount: 2,
      replaced: false,
    });

    const again = await uploadRoute.POST(
      jsonRequest("/api/corpus/upload", { fileText: EXPORT_FIXTURE }, cookie)
    );
    expect((await again.json()).replaced).toBe(true);
  });

  it("帶分類上傳：200，且清單回該分類名稱", async () => {
    const categoryId = await createCategory("主管");
    const res = await uploadRoute.POST(
      jsonRequest("/api/corpus/upload", { fileText: EXPORT_FIXTURE, categoryId }, cookie)
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sourceName: "王主管", categoryId });

    const list = await listRoute.GET(getRequest("/api/corpus", cookie));
    const body = await list.json();
    expect(body.corpora[0]).toMatchObject({ categoryName: "主管" });
  });

  it("超過每分鐘上限：429", async () => {
    for (let i = 0; i < 5; i++) {
      await uploadRoute.POST(jsonRequest("/api/corpus/upload", { fileText: EXPORT_FIXTURE }, cookie));
    }
    const sixth = await uploadRoute.POST(
      jsonRequest("/api/corpus/upload", { fileText: EXPORT_FIXTURE }, cookie)
    );
    expect(sixth.status).toBe(429);
  });
});

describe("GET /api/corpus", () => {
  it("未登入：401", async () => {
    const res = await listRoute.GET(getRequest("/api/corpus"));
    expect(res.status).toBe(401);
  });

  it("回本人語料清單", async () => {
    await uploadRoute.POST(jsonRequest("/api/corpus/upload", { fileText: EXPORT_FIXTURE }, cookie));
    const res = await listRoute.GET(getRequest("/api/corpus", cookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.corpora).toHaveLength(1);
    expect(body.corpora[0]).toMatchObject({ sourceName: "王主管", sampleCount: 2 });
  });
});
