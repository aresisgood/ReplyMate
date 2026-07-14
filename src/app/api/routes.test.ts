// API routes 整合測試：邏輯已在 auth/chat 層單元測過，
// 這裡守 happy path、401/403 與 cookie 流程。
//
// 手法：先在 import route 模組「之前」把 DATABASE_FILE 指到暫存檔並建好
// schema + seed（db/index.ts 在載入時讀環境變數），再動態載入 handlers。

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

const tmpDir = mkdtempSync(path.join(tmpdir(), "replymate-api-"));
const DB_FILE = path.join(tmpDir, "test.db");
process.env.DATABASE_FILE = DB_FILE;
process.env.APP_SECRET = "test-secret-for-unit-tests-only";

// route 模組（動態載入，確保在環境變數設定之後）
let loginRoute: typeof import("./auth/login/route");
let logoutRoute: typeof import("./auth/logout/route");
let conversationsRoute: typeof import("./conversations/route");
let messagesRoute: typeof import("./conversations/[id]/messages/route");

let meId: string;
let bossId: string;
let convId: string;
let outsiderCookie: string;

function jsonRequest(url: string, body: unknown, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function getRequest(url: string, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    headers: cookie ? { cookie } : {},
  });
}

async function loginCookie(username: string, password: string): Promise<string> {
  const res = await loginRoute.POST(jsonRequest("/api/auth/login", { username, password }));
  const token = res.cookies.get("rm_session")?.value;
  if (!token) throw new Error("login 未回傳 session cookie");
  return `rm_session=${token}`;
}

beforeAll(async () => {
  // 建 schema + seed
  const sqlite = new Database(DB_FILE);
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });

  const passwordHash = await bcrypt.hash("demo1234", 4);
  const [me, boss, outsider] = db
    .insert(schema.users)
    .values([
      { username: "tingyu", passwordHash, displayName: "賴庭右" },
      { username: "boss", passwordHash, displayName: "王主管" },
      { username: "outsider", passwordHash, displayName: "路人" },
    ])
    .returning()
    .all();
  meId = me.id;
  bossId = boss.id;

  const conv = db
    .insert(schema.conversations)
    .values({ userAId: me.id, userBId: boss.id })
    .returning()
    .get();
  convId = conv.id;

  db.insert(schema.messages)
    .values({ conversationId: convId, senderId: bossId, text: "急件請確認", createdAt: new Date(1_700_000_000_000) })
    .run();
  sqlite.close();

  loginRoute = await import("./auth/login/route");
  logoutRoute = await import("./auth/logout/route");
  conversationsRoute = await import("./conversations/route");
  messagesRoute = await import("./conversations/[id]/messages/route");

  outsiderCookie = await loginCookie("outsider", "demo1234");
});

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* Windows 上連線未釋放時忽略，暫存目錄由 OS 清理 */
  }
});

describe("POST /api/auth/login", () => {
  it("帳密正確：200、回傳 user、設定 httpOnly session cookie", async () => {
    const res = await loginRoute.POST(jsonRequest("/api/auth/login", { username: "tingyu", password: "demo1234" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toMatchObject({ username: "tingyu", displayName: "賴庭右" });
    const cookie = res.cookies.get("rm_session");
    expect(cookie?.value).toBeTruthy();
    expect(cookie?.httpOnly).toBe(true);
  });

  it("密碼錯誤：401 + { error }", async () => {
    const res = await loginRoute.POST(jsonRequest("/api/auth/login", { username: "tingyu", password: "nope" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBeTruthy();
  });

  it("同帳號短時間內連續嘗試超過上限：429（安全稽核 H-2，防密碼爆破）", async () => {
    // 前 5 次錯誤密碼皆回 401（正常拒絕）
    for (let i = 0; i < 5; i++) {
      const r = await loginRoute.POST(
        jsonRequest("/api/auth/login", { username: "tingyu", password: `wrong-${i}` })
      );
      expect(r.status).toBe(401);
    }
    // 第 6 次被限流擋下，即使密碼正確也不放行
    const res = await loginRoute.POST(
      jsonRequest("/api/auth/login", { username: "tingyu", password: "demo1234" })
    );
    expect(res.status).toBe(429);
  });

  it("缺欄位：400", async () => {
    const res = await loginRoute.POST(jsonRequest("/api/auth/login", { username: "tingyu" }));
    expect(res.status).toBe(400);
  });

  // username 會成為限流 Map 的 key；不設長度上限等於讓外部輸入決定記憶體用量。
  it("超長 username：401，不進入驗證流程", async () => {
    const res = await loginRoute.POST(
      jsonRequest("/api/auth/login", { username: "a".repeat(65), password: "demo1234" })
    );
    expect(res.status).toBe(401);
  });

  it("登入成功會歸還帳號額度：正常使用者反覆登入不會把自己鎖出去", async () => {
    // 帳號層上限是 5；成功登入若也扣額，第 6 次就會被自己的限流擋下。
    for (let i = 0; i < 8; i++) {
      const res = await loginRoute.POST(
        jsonRequest("/api/auth/login", { username: "tingyu", password: "demo1234" })
      );
      expect(res.status).toBe(200);
    }
  });

  // 密碼噴灑：每個帳號只試一兩次，永遠碰不到帳號層上限——只有 IP 層攔得住。
  it("同一 IP 輪換大量帳號嘗試：429（防密碼噴灑）", async () => {
    const from = (username: string) =>
      new NextRequest("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
        body: JSON.stringify({ username, password: "guess" }),
      });

    // IP 層上限 20：前 20 次各自以 401 被拒（帳號層完全沒被觸發）
    for (let i = 0; i < 20; i++) {
      const res = await loginRoute.POST(from(`victim-${i}`));
      expect(res.status).toBe(401);
    }

    // 第 21 次：即使又是一個全新帳號，仍被 IP 層擋下
    const res = await loginRoute.POST(from("victim-fresh"));
    expect(res.status).toBe(429);
  });
});

describe("GET /api/conversations", () => {
  it("未登入：401", async () => {
    const res = await conversationsRoute.GET(getRequest("/api/conversations"));
    expect(res.status).toBe(401);
  });

  it("已登入：回傳含對方名稱與預覽的列表", async () => {
    const cookie = await loginCookie("tingyu", "demo1234");
    const res = await conversationsRoute.GET(getRequest("/api/conversations", cookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]).toMatchObject({
      conversationId: convId,
      counterpartName: "王主管",
      lastMessageText: "急件請確認",
    });
  });
});

describe("/api/conversations/:id/messages", () => {
  const params = () => Promise.resolve({ id: convId });

  it("GET 未登入：401", async () => {
    const res = await messagesRoute.GET(getRequest(`/api/conversations/${convId}/messages`), { params: params() });
    expect(res.status).toBe(401);
  });

  it("GET 非參與者：403", async () => {
    const res = await messagesRoute.GET(
      getRequest(`/api/conversations/${convId}/messages`, outsiderCookie),
      { params: params() }
    );
    expect(res.status).toBe(403);
  });

  it("GET 不存在的對話：404", async () => {
    const res = await messagesRoute.GET(
      getRequest(`/api/conversations/no-such/messages`, outsiderCookie),
      { params: Promise.resolve({ id: "no-such" }) }
    );
    expect(res.status).toBe(404);
  });

  it("POST 送出訊息後，GET ?after= 增量取得", async () => {
    const cookie = await loginCookie("tingyu", "demo1234");

    const before = await messagesRoute.GET(
      getRequest(`/api/conversations/${convId}/messages`, cookie),
      { params: params() }
    );
    const { messages: initial } = await before.json();
    const cursor = initial[initial.length - 1].createdAtMs;

    const postRes = await messagesRoute.POST(
      jsonRequest(`/api/conversations/${convId}/messages`, { text: "收到，我看一下" }, cookie),
      { params: params() }
    );
    expect(postRes.status).toBe(201);

    const after = await messagesRoute.GET(
      getRequest(`/api/conversations/${convId}/messages?after=${cursor}`, cookie),
      { params: params() }
    );
    const { messages: incremental } = await after.json();
    // 游標為 at-or-after：可能連同邊界訊息一起回傳（前端去重），故只斷言新訊息存在
    const texts = incremental.map((m: { text: string }) => m.text);
    expect(texts).toContain("收到，我看一下");
    expect(incremental.find((m: { text: string }) => m.text === "收到，我看一下")).toMatchObject({
      senderId: meId,
    });
  });

  it("POST 空白訊息：400", async () => {
    const cookie = await loginCookie("tingyu", "demo1234");
    const res = await messagesRoute.POST(
      jsonRequest(`/api/conversations/${convId}/messages`, { text: "   " }, cookie),
      { params: params() }
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/logout", () => {
  // logout 是無狀態的：token 不落 DB，清 cookie 即登出，故 handler 不讀 request。
  it("清除 session cookie", async () => {
    const res = await logoutRoute.POST();
    expect(res.status).toBe(200);
    expect(res.cookies.get("rm_session")?.value).toBe("");
  });
});
