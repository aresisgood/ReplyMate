// categories API 整合測試：分類邏輯已在 lib 層單元測過，這裡守
// 401/驗證邊界（重名/超長/保留字）/ownership（他人分類 404）與 happy path。
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

const tmpDir = mkdtempSync(path.join(tmpdir(), "replymate-categories-"));
const DB_FILE = path.join(tmpDir, "test.db");
process.env.DATABASE_FILE = DB_FILE;
process.env.APP_SECRET = "test-secret-for-unit-tests-only";

let loginRoute: typeof import("./auth/login/route");
let listCreateRoute: typeof import("./categories/route");
let renameRoute: typeof import("./categories/[id]/route");

let meCookie: string;
let otherCookie: string;

function jsonRequest(url: string, body: unknown, c?: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(c ? { cookie: c } : {}) },
    body: JSON.stringify(body),
  });
}

function putRequest(url: string, body: unknown, c?: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(c ? { cookie: c } : {}) },
    body: JSON.stringify(body),
  });
}

function getRequest(url: string, c?: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, { headers: c ? { cookie: c } : {} });
}

const renameCtx = (id: string) => ({ params: Promise.resolve({ id }) });

async function login(username: string): Promise<string> {
  const res = await loginRoute.POST(
    jsonRequest("/api/auth/login", { username, password: "demo1234" })
  );
  return `rm_session=${res.cookies.get("rm_session")?.value}`;
}

beforeAll(async () => {
  const sqlite = new Database(DB_FILE);
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  const passwordHash = await bcrypt.hash("demo1234", 4);
  db.insert(schema.users)
    .values([
      { username: "tingyu", passwordHash, displayName: "賴庭右" },
      { username: "other", passwordHash, displayName: "別人" },
    ])
    .run();
  sqlite.close();

  loginRoute = await import("./auth/login/route");
  listCreateRoute = await import("./categories/route");
  renameRoute = await import("./categories/[id]/route");

  meCookie = await login("tingyu");
  otherCookie = await login("other");
});

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* Windows 上連線未釋放時忽略 */
  }
});

describe("GET /api/categories", () => {
  it("未登入：401", async () => {
    const res = await listCreateRoute.GET(getRequest("/api/categories"));
    expect(res.status).toBe(401);
  });

  it("回本人分類清單（不含他人）", async () => {
    await listCreateRoute.POST(jsonRequest("/api/categories", { name: "同事" }, otherCookie));
    await listCreateRoute.POST(jsonRequest("/api/categories", { name: "客戶" }, meCookie));

    const res = await listCreateRoute.GET(getRequest("/api/categories", meCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    const names = body.categories.map((c: { name: string }) => c.name);
    expect(names).toContain("客戶");
    expect(names).not.toContain("同事");
  });
});

describe("POST /api/categories", () => {
  it("未登入：401", async () => {
    const res = await listCreateRoute.POST(jsonRequest("/api/categories", { name: "主管" }));
    expect(res.status).toBe(401);
  });

  it("建立成功：回傳 { id, name }", async () => {
    const res = await listCreateRoute.POST(
      jsonRequest("/api/categories", { name: "主管" }, meCookie)
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ name: "主管" });
    expect(body.id).toBeTruthy();
  });

  it("缺 name：400", async () => {
    const res = await listCreateRoute.POST(jsonRequest("/api/categories", {}, meCookie));
    expect(res.status).toBe(400);
  });

  it("重名：400", async () => {
    await listCreateRoute.POST(jsonRequest("/api/categories", { name: "朋友" }, meCookie));
    const res = await listCreateRoute.POST(
      jsonRequest("/api/categories", { name: "朋友" }, meCookie)
    );
    expect(res.status).toBe(400);
  });

  it("超長（>20 字）：400", async () => {
    const res = await listCreateRoute.POST(
      jsonRequest("/api/categories", { name: "一".repeat(21) }, meCookie)
    );
    expect(res.status).toBe(400);
  });

  it("保留名稱「通用」：400", async () => {
    const res = await listCreateRoute.POST(
      jsonRequest("/api/categories", { name: "通用" }, meCookie)
    );
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/categories/:id", () => {
  async function createFor(cookie: string, name: string): Promise<string> {
    const res = await listCreateRoute.POST(jsonRequest("/api/categories", { name }, cookie));
    return (await res.json()).id;
  }

  it("未登入：401", async () => {
    const res = await renameRoute.PUT(
      putRequest("/api/categories/x", { name: "新名" }),
      renameCtx("x")
    );
    expect(res.status).toBe(401);
  });

  it("改名成功：回傳新名稱", async () => {
    const id = await createFor(meCookie, "改名前");
    const res = await renameRoute.PUT(
      putRequest(`/api/categories/${id}`, { name: "改名後" }, meCookie),
      renameCtx(id)
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, name: "改名後" });
  });

  it("他人的分類：404", async () => {
    const id = await createFor(otherCookie, "他人分類");
    const res = await renameRoute.PUT(
      putRequest(`/api/categories/${id}`, { name: "搶改" }, meCookie),
      renameCtx(id)
    );
    expect(res.status).toBe(404);
  });

  it("改成既有名稱（重名）：400", async () => {
    await createFor(meCookie, "既有A");
    const id = await createFor(meCookie, "既有B");
    const res = await renameRoute.PUT(
      putRequest(`/api/categories/${id}`, { name: "既有A" }, meCookie),
      renameCtx(id)
    );
    expect(res.status).toBe(400);
  });
});

// 放在最後：本測試會在共用 DB 留下大量分類，避免影響前面清單斷言
describe("分類寫入 rate limit", () => {
  it("超過視窗上限後 POST 與 PUT 均回 429", async () => {
    for (let i = 0; i < 20; i++) {
      const res = await listCreateRoute.POST(
        jsonRequest("/api/categories", { name: `限流${i}` }, meCookie)
      );
      expect(res.status).toBe(200);
    }

    const blockedPost = await listCreateRoute.POST(
      jsonRequest("/api/categories", { name: "限流爆量" }, meCookie)
    );
    expect(blockedPost.status).toBe(429);

    // POST/PUT 共用同一限流器（皆為分類寫入）；429 須在 ownership 查找前生效
    const blockedPut = await renameRoute.PUT(
      putRequest("/api/categories/whatever", { name: "改名" }, meCookie),
      renameCtx("whatever")
    );
    expect(blockedPut.status).toBe(429);
  });
});
