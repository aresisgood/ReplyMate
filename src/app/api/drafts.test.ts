// drafts / settings / autoReply 的 route 整合測試。
// 引擎以 vi.mock 攔截——不打真 Anthropic API（不花錢、不依賴網路）。

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { NextRequest } from "next/server";
import * as schema from "../../lib/db/schema";
import { resetRateLimiters } from "../../lib/rateLimit";

const AI_DRAFT = "好的，我週六看一下合約再回您";

const generateDraft = vi.fn();
vi.mock("@/lib/engine", () => ({
  generateDraft: (...args: unknown[]) => generateDraft(...args),
}));

const tmpDir = mkdtempSync(path.join(tmpdir(), "replymate-drafts-"));
process.env.DATABASE_FILE = path.join(tmpDir, "test.db");
process.env.APP_SECRET = "test-secret-for-unit-tests-only";
process.env.ANTHROPIC_API_KEY = "sk-env-fallback";

let draftsRoute: typeof import("./drafts/route");
let finalizeRoute: typeof import("./drafts/[id]/finalize/route");
let settingsRoute: typeof import("./conversations/[id]/settings/route");
let messagesRoute: typeof import("./conversations/[id]/messages/route");

let db: ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let meId: string;
let bossId: string;
let outsiderId: string;
let convId: string;
let incomingId: string; // boss 傳給我的訊息
let myMessageId: string;
let meCookie: string;
let bossCookie: string;
let outsiderCookie: string;

function post(url: string, body: unknown, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function put(url: string, body: unknown, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

async function login(username: string): Promise<string> {
  const route = await import("./auth/login/route");
  const res = await route.POST(post("/api/auth/login", { username, password: "demo1234" }));
  return `rm_session=${res.cookies.get("rm_session")!.value}`;
}

beforeAll(async () => {
  sqlite = new Database(process.env.DATABASE_FILE!);
  sqlite.pragma("foreign_keys = ON");
  db = drizzle(sqlite, { schema });
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
  outsiderId = outsider.id;

  convId = db
    .insert(schema.conversations)
    .values({ userAId: meId, userBId: bossId })
    .returning()
    .get().id;

  incomingId = db
    .insert(schema.messages)
    .values({
      conversationId: convId,
      senderId: bossId,
      text: "週六幫我看一下合約，急",
      createdAt: new Date(1_700_000_000_000),
    })
    .returning()
    .get().id;

  myMessageId = db
    .insert(schema.messages)
    .values({
      conversationId: convId,
      senderId: meId,
      text: "我自己說的話",
      createdAt: new Date(1_700_000_001_000),
    })
    .returning()
    .get().id;

  // 我的風格語料（對方 displayName「王主管」對應 sourceName）
  const corpus = db
    .insert(schema.styleCorpora)
    .values({ ownerId: meId, contactLabel: "主管", sourceName: "王主管" })
    .returning()
    .get();
  db.insert(schema.styleSamples)
    .values([{ corpusId: corpus.id, text: "好的，我今晚整理完寄給您" }])
    .run();

  draftsRoute = await import("./drafts/route");
  finalizeRoute = await import("./drafts/[id]/finalize/route");
  settingsRoute = await import("./conversations/[id]/settings/route");
  messagesRoute = await import("./conversations/[id]/messages/route");

  meCookie = await login("tingyu");
  bossCookie = await login("boss");
  outsiderCookie = await login("outsider");
});

afterAll(() => {
  sqlite?.close();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* Windows 檔案鎖，交給 OS 清理 */
  }
});

beforeEach(() => {
  resetRateLimiters();
  generateDraft.mockReset();
  generateDraft.mockResolvedValue({ aiDraft: AI_DRAFT, keySource: "env" });
  // 每個測試從乾淨的 draft/設定狀態開始
  db.delete(schema.draftSessions).run();
  db.delete(schema.conversationSettings).run();
});

describe("POST /api/drafts", () => {
  it("未登入：401", async () => {
    const res = await draftsRoute.POST(post("/api/drafts", { messageId: incomingId }));
    expect(res.status).toBe(401);
  });

  it("缺 messageId：400", async () => {
    const res = await draftsRoute.POST(post("/api/drafts", {}, meCookie));
    expect(res.status).toBe(400);
  });

  it("訊息不存在：404", async () => {
    const res = await draftsRoute.POST(post("/api/drafts", { messageId: "no-such" }, meCookie));
    expect(res.status).toBe(404);
  });

  it("非對話參與者：403", async () => {
    const res = await draftsRoute.POST(
      post("/api/drafts", { messageId: incomingId }, outsiderCookie)
    );
    expect(res.status).toBe(403);
  });

  it("對自己送出的訊息要求代筆：403", async () => {
    const res = await draftsRoute.POST(
      post("/api/drafts", { messageId: myMessageId }, meCookie)
    );
    expect(res.status).toBe(403);
  });

  it("成功：回傳 draftId 與草稿，並建檔為 mode='manual'", async () => {
    const res = await draftsRoute.POST(post("/api/drafts", { messageId: incomingId }, meCookie));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.aiDraft).toBe(AI_DRAFT);
    expect(body.draftId).toBeTruthy();

    const stored = db
      .select()
      .from(schema.draftSessions)
      .where(eq(schema.draftSessions.id, body.draftId))
      .get();
    expect(stored).toMatchObject({ mode: "manual", userId: meId, aiDraft: AI_DRAFT });
    expect(stored?.finalText).toBeNull(); // 尚未定稿
  });

  it("傳給引擎的 prompt 帶著來訊、本人身分與風格語料", async () => {
    await draftsRoute.POST(post("/api/drafts", { messageId: incomingId }, meCookie));

    const params = generateDraft.mock.calls[0][0];
    expect(params.prompt.incomingText).toBe("週六幫我看一下合約，急");
    expect(params.prompt.displayName).toBe("賴庭右");
    expect(params.prompt.contactLabel).toBe("主管");
    expect(params.prompt.styleSamples).toContain("好的，我今晚整理完寄給您");
    expect(params.envFallback).toBe("sk-env-fallback");
  });

  it("同使用者一分鐘內超過上限：429（安全稽核 H-2，付費端點防濫用）", async () => {
    // 前 5 次允許
    for (let i = 0; i < 5; i++) {
      const ok = await draftsRoute.POST(post("/api/drafts", { messageId: incomingId }, meCookie));
      expect(ok.status).toBe(200);
    }
    // 第 6 次被擋，且不再呼叫引擎
    generateDraft.mockClear();
    const res = await draftsRoute.POST(post("/api/drafts", { messageId: incomingId }, meCookie));
    expect(res.status).toBe(429);
    expect(generateDraft).not.toHaveBeenCalled();
  });

  it("引擎失敗：502，且不留下 draft 記錄", async () => {
    generateDraft.mockRejectedValue(new Error("Anthropic 429"));

    const res = await draftsRoute.POST(post("/api/drafts", { messageId: incomingId }, meCookie));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBeTruthy();
    expect(db.select().from(schema.draftSessions).all()).toHaveLength(0);
  });
});

describe("POST /api/drafts/:id/finalize", () => {
  async function newDraft(): Promise<string> {
    const res = await draftsRoute.POST(post("/api/drafts", { messageId: incomingId }, meCookie));
    return (await res.json()).draftId;
  }

  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it("未登入：401", async () => {
    const id = await newDraft();
    const res = await finalizeRoute.POST(
      post(`/api/drafts/${id}/finalize`, { finalText: AI_DRAFT }),
      ctx(id)
    );
    expect(res.status).toBe(401);
  });

  it("原文送出：adopted=true，訊息進入對話", async () => {
    const id = await newDraft();
    const res = await finalizeRoute.POST(
      post(`/api/drafts/${id}/finalize`, { finalText: AI_DRAFT }, meCookie),
      ctx(id)
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.adopted).toBe(true);
    expect(body.message.text).toBe(AI_DRAFT);
    expect(body.message.senderId).toBe(meId);
  });

  it("大幅改寫：adopted=false，仍以改寫後內容送出", async () => {
    const id = await newDraft();
    const res = await finalizeRoute.POST(
      post(`/api/drafts/${id}/finalize`, { finalText: "抱歉這週沒空，下週再說" }, meCookie),
      ctx(id)
    );

    const body = await res.json();
    expect(body.adopted).toBe(false);
    expect(body.message.text).toBe("抱歉這週沒空，下週再說");
  });

  it("非本人的 draft：403", async () => {
    const id = await newDraft();
    const res = await finalizeRoute.POST(
      post(`/api/drafts/${id}/finalize`, { finalText: AI_DRAFT }, bossCookie),
      ctx(id)
    );
    expect(res.status).toBe(403);
  });

  it("空白定稿：400", async () => {
    const id = await newDraft();
    const res = await finalizeRoute.POST(
      post(`/api/drafts/${id}/finalize`, { finalText: "   " }, meCookie),
      ctx(id)
    );
    expect(res.status).toBe(400);
  });

  it("重複定稿：400（不可送出兩則、不可重複計入統計）", async () => {
    const id = await newDraft();
    await finalizeRoute.POST(
      post(`/api/drafts/${id}/finalize`, { finalText: AI_DRAFT }, meCookie),
      ctx(id)
    );
    const res = await finalizeRoute.POST(
      post(`/api/drafts/${id}/finalize`, { finalText: AI_DRAFT }, meCookie),
      ctx(id)
    );
    expect(res.status).toBe(400);
  });

  it("draft 不存在：404", async () => {
    const res = await finalizeRoute.POST(
      post(`/api/drafts/no-such/finalize`, { finalText: AI_DRAFT }, meCookie),
      ctx("no-such")
    );
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/conversations/:id/settings", () => {
  const ctx = () => ({ params: Promise.resolve({ id: convId }) });

  it("未登入：401", async () => {
    const res = await settingsRoute.PUT(
      put(`/api/conversations/${convId}/settings`, { autoReply: true }),
      ctx()
    );
    expect(res.status).toBe(401);
  });

  it("非參與者：403", async () => {
    const res = await settingsRoute.PUT(
      put(`/api/conversations/${convId}/settings`, { autoReply: true }, outsiderCookie),
      ctx()
    );
    expect(res.status).toBe(403);
  });

  it("autoReply 非布林值：400", async () => {
    const res = await settingsRoute.PUT(
      put(`/api/conversations/${convId}/settings`, { autoReply: "yes" }, meCookie),
      ctx()
    );
    expect(res.status).toBe(400);
  });

  it("成功開啟，且只影響自己（每使用者 × 每對話）", async () => {
    const res = await settingsRoute.PUT(
      put(`/api/conversations/${convId}/settings`, { autoReply: true }, meCookie),
      ctx()
    );
    expect(res.status).toBe(200);
    expect((await res.json()).autoReply).toBe(true);

    const rows = db.select().from(schema.conversationSettings).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: meId, autoReply: true });
  });
});

describe("autoReply 掛在送訊上（F4）", () => {
  const ctx = () => ({ params: Promise.resolve({ id: convId }) });

  it("收訊方未開啟：送訊正常，不產生自動回覆", async () => {
    const res = await messagesRoute.POST(
      post(`/api/conversations/${convId}/messages`, { text: "再確認一次" }, bossCookie),
      ctx()
    );
    expect(res.status).toBe(201);

    await vi.waitFor(() => expect(generateDraft).not.toHaveBeenCalled());
    expect(db.select().from(schema.draftSessions).all()).toHaveLength(0);
  });

  it("收訊方開啟：boss 送訊後，系統以我的身分自動回覆（mode='auto'）", async () => {
    await settingsRoute.PUT(
      put(`/api/conversations/${convId}/settings`, { autoReply: true }, meCookie),
      ctx()
    );

    const res = await messagesRoute.POST(
      post(`/api/conversations/${convId}/messages`, { text: "合約看了嗎？" }, bossCookie),
      ctx()
    );
    expect(res.status).toBe(201); // 送訊者不被生成阻塞

    // 自動回覆為非阻塞，等它落地
    await vi.waitFor(() => {
      const drafts = db.select().from(schema.draftSessions).all();
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({ mode: "auto", userId: meId, finalText: AI_DRAFT });
    });

    const msgs = db.select().from(schema.messages).all();
    expect(msgs.at(-1)).toMatchObject({ senderId: meId, text: AI_DRAFT });
  });

  it("引擎失敗時，送訊仍成功（自動回覆失敗不影響來訊）", async () => {
    generateDraft.mockRejectedValue(new Error("Anthropic 500"));
    await settingsRoute.PUT(
      put(`/api/conversations/${convId}/settings`, { autoReply: true }, meCookie),
      ctx()
    );

    const before = db.select().from(schema.messages).all().length;
    const res = await messagesRoute.POST(
      post(`/api/conversations/${convId}/messages`, { text: "在嗎" }, bossCookie),
      ctx()
    );

    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(generateDraft).toHaveBeenCalled());

    // 只多了 boss 那一則，沒有自動回覆
    expect(db.select().from(schema.messages).all()).toHaveLength(before + 1);
    expect(db.select().from(schema.draftSessions).all()).toHaveLength(0);
  });
});
