# 語料上傳（feat/corpus-upload）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or the Execute Plan phase of superpowers:sunnydata-design to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用者可在 `/settings` 上傳 LINE 匯出檔建立風格語料（整組取代語意），並在聊天頁 header 取得設定入口。

**Architecture:** 沿用「route handler 薄殼 + lib 純邏輯」模式。新增 `src/lib/corpus/corpus.ts`（匯入 + 查詢）、兩條 API 路由（`POST /api/corpus/upload`、`GET /api/corpus`）、`/settings` 頁（server 守門 + client 互動），及聊天頁 header 連結。零 schema 變更。

**Tech Stack:** Next.js 15 App Router、Drizzle + better-sqlite3、vitest（node + jsdom）、既有 `lineParser` / `rateLimit` / `http` helper。

**Spec:** `docs/superpowers/specs/2026-07-14-w6-features-design.md` §3

**計畫層決策（spec 未涵蓋，於此定案）：**

1. **我方名字推導**：`extractStyleSamples(result, ownerName)` 需要「我方」在匯出檔
   裡的名字，但使用者的 LINE 名字未必等於 app 內 displayName。1 對 1 匯出檔只有
   兩位發言者——標頭的 `contactName` 是對方，其餘發言者中訊息數最多者即我方。
   不依賴 displayName 比對。
2. **取代不依賴 cascade pragma**：transaction 內先明刪 samples 再刪 corpus，
   不依賴連線是否開 `foreign_keys` pragma，行為在任何環境都確定。
3. **批次 insert**：better-sqlite3 單句參數上限 999，samples 以 100 列/批寫入。
4. **限流**：新增 `corpusUploadRateLimiter`（5 次/分鐘/使用者），與 drafts API 同級
   —— 解析為 CPU 密集操作。

---

### Task 0: 建立分支

- [ ] **Step 0.1: 確認乾淨並建分支**

```bash
git status --short   # 應只有 docs/superpowers/ 的 spec 與本計畫（或已提交）
git checkout -b feat/corpus-upload
```

---

### Task 1: `importLineCorpus` — 匯入邏輯（TDD）

**Files:**
- Create: `src/lib/corpus/corpus.ts`
- Test: `src/lib/corpus/corpus.test.ts`

- [ ] **Step 1.1: 寫失敗測試**

建立 `src/lib/corpus/corpus.test.ts`：

```ts
// importLineCorpus / listCorpora 單元測試：解析→過濾→整組取代的完整語意。
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testDb";
import type { AppDatabase } from "../db/types";
import { styleCorpora, styleSamples, users } from "../db/schema";
import { ValidationError } from "../chat/queries";
import { importLineCorpus, listCorpora } from "./corpus";

// 我方（賴庭右）發言 4 則：1 則有效、1 則有效、[貼圖] 濾除、「嗯」過短濾除
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
      contactLabel: "主管",
    });

    expect(result).toMatchObject({
      sourceName: "王主管",
      contactLabel: "主管",
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
      contactLabel: "主管",
    });
    expect(result.sampleCount).toBe(2);
  });

  it("重傳同一對象：整組取代（舊 corpus 與 samples 消失、replaced=true）", () => {
    const first = importLineCorpus(db, {
      ownerId,
      fileText: EXPORT_FIXTURE,
      contactLabel: "主管",
    });
    const second = importLineCorpus(db, {
      ownerId,
      fileText: EXPORT_FIXTURE,
      contactLabel: "同事", // 重傳可換標籤
    });

    expect(second.replaced).toBe(true);
    expect(second.corpusId).not.toBe(first.corpusId);

    const corpora = db
      .select()
      .from(styleCorpora)
      .where(eq(styleCorpora.ownerId, ownerId))
      .all();
    expect(corpora).toHaveLength(1);
    expect(corpora[0].contactLabel).toBe("同事");

    const orphans = db
      .select()
      .from(styleSamples)
      .where(eq(styleSamples.corpusId, first.corpusId))
      .all();
    expect(orphans).toHaveLength(0);
  });

  it("無 LINE 標頭：ValidationError（無法辨識格式）", () => {
    expect(() =>
      importLineCorpus(db, { ownerId, fileText: "隨便的內容", contactLabel: "主管" })
    ).toThrow(ValidationError);
  });

  it("只有對方發言：ValidationError（無可用樣本），且不寫入任何資料", () => {
    expect(() =>
      importLineCorpus(db, { ownerId, fileText: CONTACT_ONLY_FIXTURE, contactLabel: "主管" })
    ).toThrow(ValidationError);
    expect(db.select().from(styleCorpora).all()).toHaveLength(0);
  });
});

describe("listCorpora", () => {
  it("列出本人語料含句數；不含他人的", () => {
    importLineCorpus(db, { ownerId, fileText: EXPORT_FIXTURE, contactLabel: "主管" });
    const otherId = db
      .insert(users)
      .values({ username: "other", passwordHash: "x", displayName: "路人" })
      .returning()
      .get().id;
    importLineCorpus(db, { ownerId: otherId, fileText: EXPORT_FIXTURE, contactLabel: "朋友" });

    const mine = listCorpora(db, ownerId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      contactLabel: "主管",
      sourceName: "王主管",
      sampleCount: 2,
    });
    expect(mine[0].createdAtMs).toBeTypeOf("number");
  });

  it("無語料時回空陣列", () => {
    expect(listCorpora(db, ownerId)).toEqual([]);
  });
});
```

- [ ] **Step 1.2: 執行測試，確認失敗**

Run: `npm test -- src/lib/corpus/corpus.test.ts`
Expected: FAIL —— `Cannot find module './corpus'`（或等價的模組不存在錯誤）

- [ ] **Step 1.3: 實作 `src/lib/corpus/corpus.ts`**

```ts
// 語料匯入與查詢（架構 §3 F2）：LINE 匯出檔 → styleCorpora + styleSamples。
//
// 我方名字推導：1 對 1 匯出檔只有兩位發言者——標頭的 contactName 是對方，
// 其餘發言者中訊息數最多者即「我方」。不依賴 app displayName 與 LINE 名字一致。
//
// 重傳語意：同 (ownerId, sourceName) 整組取代——transaction 內明刪 samples 與
// corpus 後重建（不依賴連線的 foreign_keys pragma）。原始檔文字不落地（§8 隱私）。

import { and, count, eq } from "drizzle-orm";
import { styleCorpora, styleSamples } from "../db/schema";
import type { AppDatabase } from "../db/types";
import {
  extractStyleSamples,
  parseLineExport,
  type ParsedMessage,
  type ParseResult,
} from "../parser/lineParser";
import { ValidationError } from "../chat/queries";

// better-sqlite3 單句參數上限 999；每列 3 欄，100 列/批留足餘裕。
const INSERT_BATCH_SIZE = 100;

export interface ImportCorpusParams {
  ownerId: string;
  fileText: string;
  contactLabel: string;
}

export interface ImportCorpusResult {
  corpusId: string;
  sourceName: string;
  contactLabel: string;
  sampleCount: number;
  replaced: boolean;
}

function deriveOwnerName(result: ParseResult): string | null {
  const counts = new Map<string, number>();
  for (const m of result.messages) {
    if (m.sender === result.contactName) continue;
    counts.set(m.sender, (counts.get(m.sender) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [name, c] of counts) {
    if (c > bestCount) {
      best = name;
      bestCount = c;
    }
  }
  return best;
}

function toSentAt(m: ParsedMessage): Date {
  // "2026/05/20" + "15:24" → 當地時間 Date；ISO 連字號格式避免引擎差異
  return new Date(`${m.date.replace(/\//g, "-")}T${m.time}:00`);
}

export function importLineCorpus(
  db: AppDatabase,
  { ownerId, fileText, contactLabel }: ImportCorpusParams
): ImportCorpusResult {
  const parsed = parseLineExport(fileText);
  if (!parsed.contactName) throw new ValidationError("無法辨識的 LINE 匯出格式");

  const ownerName = deriveOwnerName(parsed);
  const samples = ownerName ? extractStyleSamples(parsed, ownerName) : [];
  if (samples.length === 0) throw new ValidationError("檔案中沒有可用的風格樣本");

  const sourceName = parsed.contactName;

  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(styleCorpora)
      .where(and(eq(styleCorpora.ownerId, ownerId), eq(styleCorpora.sourceName, sourceName)))
      .get();
    if (existing) {
      tx.delete(styleSamples).where(eq(styleSamples.corpusId, existing.id)).run();
      tx.delete(styleCorpora).where(eq(styleCorpora.id, existing.id)).run();
    }

    const corpus = tx
      .insert(styleCorpora)
      .values({ ownerId, contactLabel, sourceName })
      .returning()
      .get();

    for (let i = 0; i < samples.length; i += INSERT_BATCH_SIZE) {
      const batch = samples.slice(i, i + INSERT_BATCH_SIZE);
      tx.insert(styleSamples)
        .values(batch.map((m) => ({ corpusId: corpus.id, text: m.text, sentAt: toSentAt(m) })))
        .run();
    }

    return {
      corpusId: corpus.id,
      sourceName,
      contactLabel,
      sampleCount: samples.length,
      replaced: Boolean(existing),
    };
  });
}

export interface CorpusSummary {
  id: string;
  contactLabel: string;
  sourceName: string;
  sampleCount: number;
  createdAtMs: number;
}

export function listCorpora(db: AppDatabase, ownerId: string): CorpusSummary[] {
  return db
    .select({
      id: styleCorpora.id,
      contactLabel: styleCorpora.contactLabel,
      sourceName: styleCorpora.sourceName,
      createdAt: styleCorpora.createdAt,
      sampleCount: count(styleSamples.id),
    })
    .from(styleCorpora)
    .leftJoin(styleSamples, eq(styleSamples.corpusId, styleCorpora.id))
    .where(eq(styleCorpora.ownerId, ownerId))
    .groupBy(styleCorpora.id)
    .all()
    .map((r) => ({
      id: r.id,
      contactLabel: r.contactLabel,
      sourceName: r.sourceName,
      sampleCount: r.sampleCount,
      createdAtMs: r.createdAt!.getTime(),
    }));
}
```

- [ ] **Step 1.4: 執行測試，確認通過**

Run: `npm test -- src/lib/corpus/corpus.test.ts`
Expected: PASS（7 tests）

- [ ] **Step 1.5: Commit**

```bash
git add src/lib/corpus/
git commit -m "feat(corpus): add importLineCorpus and listCorpora

語料目前只能靠 seed 寫入，使用者無法匯入自己的 LINE 聊天記錄，
成功指標 1（盲測難辨 AI）無從以真實語料驗證。

以純函式承接既有 lineParser 輸出：我方名字由檔案發言者推導（標頭
contactName 之外訊息數最多者），不依賴 app displayName 與 LINE 名字
一致；重傳同對象採整組取代，transaction 內明刪重建，不依賴
foreign_keys pragma；samples 以 100 列/批寫入避開 better-sqlite3
參數上限。原始檔文字不落地（架構 §8）。

影響 src/lib/corpus/（新增）。API 路由與 UI 由後續 commit 接入。"
```

---

### Task 2: API 路由 — 限流器 + upload + list（TDD）

**Files:**
- Modify: `src/lib/rateLimit.ts:74-92`（全域限流器區塊）
- Create: `src/app/api/corpus/upload/route.ts`
- Create: `src/app/api/corpus/route.ts`
- Test: `src/app/api/corpus.test.ts`

- [ ] **Step 2.1: 寫失敗測試**

建立 `src/app/api/corpus.test.ts`（沿用 `routes.test.ts` 的暫存檔 DB + 動態載入手法）：

```ts
// corpus API 整合測試：匯入語意已在 lib 層單元測過，這裡守
// 401/驗證邊界/413/429 與 happy path。
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
      jsonRequest("/api/corpus/upload", { fileText: EXPORT_FIXTURE, contactLabel: "主管" })
    );
    expect(res.status).toBe(401);
  });

  it("缺 fileText：400", async () => {
    const res = await uploadRoute.POST(
      jsonRequest("/api/corpus/upload", { contactLabel: "主管" }, cookie)
    );
    expect(res.status).toBe(400);
  });

  it("contactLabel 空白或超長：400", async () => {
    const blank = await uploadRoute.POST(
      jsonRequest("/api/corpus/upload", { fileText: EXPORT_FIXTURE, contactLabel: "  " }, cookie)
    );
    expect(blank.status).toBe(400);

    const tooLong = await uploadRoute.POST(
      jsonRequest(
        "/api/corpus/upload",
        { fileText: EXPORT_FIXTURE, contactLabel: "一".repeat(21) },
        cookie
      )
    );
    expect(tooLong.status).toBe(400);
  });

  it("檔案超過字元上限：413", async () => {
    const res = await uploadRoute.POST(
      jsonRequest(
        "/api/corpus/upload",
        { fileText: "a".repeat(2_097_153), contactLabel: "主管" },
        cookie
      )
    );
    expect(res.status).toBe(413);
  });

  it("格式無法辨識：400 + { error }", async () => {
    const res = await uploadRoute.POST(
      jsonRequest("/api/corpus/upload", { fileText: "不是匯出檔", contactLabel: "主管" }, cookie)
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });

  it("happy path：200 + 匯入結果；重傳回 replaced=true", async () => {
    const res = await uploadRoute.POST(
      jsonRequest("/api/corpus/upload", { fileText: EXPORT_FIXTURE, contactLabel: "主管" }, cookie)
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      sourceName: "王主管",
      sampleCount: 2,
      replaced: false,
    });

    const again = await uploadRoute.POST(
      jsonRequest("/api/corpus/upload", { fileText: EXPORT_FIXTURE, contactLabel: "同事" }, cookie)
    );
    expect((await again.json()).replaced).toBe(true);
  });

  it("超過每分鐘上限：429", async () => {
    for (let i = 0; i < 5; i++) {
      await uploadRoute.POST(
        jsonRequest("/api/corpus/upload", { fileText: EXPORT_FIXTURE, contactLabel: "主管" }, cookie)
      );
    }
    const sixth = await uploadRoute.POST(
      jsonRequest("/api/corpus/upload", { fileText: EXPORT_FIXTURE, contactLabel: "主管" }, cookie)
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
    await uploadRoute.POST(
      jsonRequest("/api/corpus/upload", { fileText: EXPORT_FIXTURE, contactLabel: "主管" }, cookie)
    );
    const res = await listRoute.GET(getRequest("/api/corpus", cookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.corpora).toHaveLength(1);
    expect(body.corpora[0]).toMatchObject({ sourceName: "王主管", sampleCount: 2 });
  });
});
```

- [ ] **Step 2.2: 執行測試，確認失敗**

Run: `npm test -- src/app/api/corpus.test.ts`
Expected: FAIL —— `Cannot find module './corpus/upload/route'`

- [ ] **Step 2.3: 修改 `src/lib/rateLimit.ts`**

在既有全域限流器區塊（`autoReplyRateLimiter` 之後）加入：

```ts
export const corpusUploadRateLimiter = createRateLimiter({ limit: 5, windowMs: 60_000 });
```

並在 `resetRateLimiters()` 內加一行：

```ts
  corpusUploadRateLimiter.reset();
```

- [ ] **Step 2.4: 建立 `src/app/api/corpus/upload/route.ts`**

```ts
// POST /api/corpus/upload — { fileText, contactLabel } → 建立/取代風格語料（架構 §3 F2）
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, mapChatError } from "@/lib/http";
import { importLineCorpus } from "@/lib/corpus/corpus";
import { corpusUploadRateLimiter } from "@/lib/rateLimit";

// 以字元計的檔案上限（約 2 MB 文字）；解析為 CPU 密集操作，須擋濫用。
const MAX_FILE_CHARS = 2_097_152;
const MAX_LABEL_CHARS = 20;

export async function POST(request: NextRequest) {
  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;
  const userId = auth;

  if (!corpusUploadRateLimiter.check(userId)) {
    return NextResponse.json({ error: "上傳過於頻繁，請稍後再試" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "請求格式錯誤" }, { status: 400 });
  }

  const { fileText, contactLabel } = (body ?? {}) as {
    fileText?: unknown;
    contactLabel?: unknown;
  };
  if (typeof fileText !== "string" || fileText.length === 0) {
    return NextResponse.json({ error: "缺少 fileText" }, { status: 400 });
  }
  if (fileText.length > MAX_FILE_CHARS) {
    return NextResponse.json({ error: "檔案過大（上限約 2 MB）" }, { status: 413 });
  }
  const label = typeof contactLabel === "string" ? contactLabel.trim() : "";
  if (label.length === 0 || label.length > MAX_LABEL_CHARS) {
    return NextResponse.json({ error: "contactLabel 須為 1–20 字" }, { status: 400 });
  }

  try {
    const result = importLineCorpus(db, { ownerId: userId, fileText, contactLabel: label });
    return NextResponse.json(result);
  } catch (e) {
    return mapChatError(e, "POST corpus/upload");
  }
}
```

- [ ] **Step 2.5: 建立 `src/app/api/corpus/route.ts`**

```ts
// GET /api/corpus — 我的風格語料清單（含句數）
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/http";
import { listCorpora } from "@/lib/corpus/corpus";

export async function GET(request: NextRequest) {
  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json({ corpora: listCorpora(db, auth) });
}
```

- [ ] **Step 2.6: 執行測試，確認通過**

Run: `npm test -- src/app/api/corpus.test.ts`
Expected: PASS（9 tests）

- [ ] **Step 2.7: 跑全套測試（限流器修改波及面檢查）**

Run: `npm test`
Expected: 全綠（208 + 新增）

- [ ] **Step 2.8: Commit**

```bash
git add src/lib/rateLimit.ts src/app/api/corpus/ src/app/api/corpus.test.ts
git commit -m "feat(corpus): add upload and list API routes

lib 層的語料匯入已就緒，但缺 HTTP 入口，前端無從呼叫。

POST /api/corpus/upload 接 JSON { fileText, contactLabel }（前端
FileReader 讀文字後傳，避免引入 multipart 解析），邊界驗證：檔案
2MB 字元上限回 413、標籤 1-20 字、每使用者 5 次/分鐘限流（解析為
CPU 密集操作）。GET /api/corpus 回本人語料清單供設定頁顯示。
錯誤映射沿用 mapChatError，ValidationError → 400。

影響 rateLimit.ts（新增 corpusUploadRateLimiter）與 api/corpus/（新增）。"
```

---

### Task 3: `/settings` 頁 — server 守門 + 互動層（TDD）

**Files:**
- Create: `src/app/settings/page.tsx`
- Create: `src/app/settings/SettingsApp.tsx`
- Test: `src/app/settings/SettingsApp.test.tsx`

- [ ] **Step 3.1: 寫失敗測試**

建立 `src/app/settings/SettingsApp.test.tsx`：

```tsx
// @vitest-environment jsdom
// SettingsApp smoke：清單渲染、sourceName 不匹配警示、上傳前置條件。
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import SettingsApp from "./SettingsApp";

const CORPORA = [
  {
    id: "c1",
    contactLabel: "主管",
    sourceName: "王主管",
    sampleCount: 48,
    createdAtMs: 1_700_000_000_000,
  },
  {
    id: "c2",
    contactLabel: "朋友",
    sourceName: "陳小美",
    sampleCount: 12,
    createdAtMs: 1_700_000_000_000,
  },
];

describe("SettingsApp", () => {
  it("渲染語料清單（標籤、來源、句數）", () => {
    render(<SettingsApp initialCorpora={CORPORA} counterpartNames={["王主管"]} />);
    expect(screen.getByText("主管")).toBeInTheDocument();
    expect(screen.getByText(/王主管/)).toBeInTheDocument();
    expect(screen.getByText(/48 句/)).toBeInTheDocument();
  });

  it("sourceName 與既有對話對象不符時顯示警示", () => {
    render(<SettingsApp initialCorpora={CORPORA} counterpartNames={["王主管"]} />);
    // 陳小美不在對話對象中 → 警示；王主管有 → 無警示
    expect(screen.getAllByText(/沒有名為/)).toHaveLength(1);
  });

  it("未選擇檔案時上傳按鈕 disabled", () => {
    render(<SettingsApp initialCorpora={[]} counterpartNames={[]} />);
    expect(screen.getByRole("button", { name: "上傳" })).toBeDisabled();
  });

  it("無語料時顯示空狀態", () => {
    render(<SettingsApp initialCorpora={[]} counterpartNames={[]} />);
    expect(screen.getByText(/尚未上傳/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3.2: 執行測試，確認失敗**

Run: `npm test -- src/app/settings/SettingsApp.test.tsx`
Expected: FAIL —— `Cannot find module './SettingsApp'`

- [ ] **Step 3.3: 建立 `src/app/settings/SettingsApp.tsx`**

```tsx
"use client";
// 設定頁互動層：風格語料上傳與清單（架構 §3 F2）。
// 個人 API key 區塊由 feat/byok-settings 分支加入本頁。
import { useState } from "react";
import Link from "next/link";
import type { CorpusSummary } from "@/lib/corpus/corpus";

const LABEL_SUGGESTIONS = ["主管", "同事", "朋友", "家人"];

interface Props {
  initialCorpora: CorpusSummary[];
  counterpartNames: string[];
}

export default function SettingsApp({ initialCorpora, counterpartNames }: Props) {
  const [corpora, setCorpora] = useState(initialCorpora);
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const fileText = await file.text();
      const res = await fetch("/api/corpus/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileText, contactLabel: label }),
      });
      const body = (await res.json().catch(() => null)) as
        | {
            sourceName?: string;
            sampleCount?: number;
            replaced?: boolean;
            error?: string;
          }
        | null;
      if (!res.ok || !body?.sourceName) {
        setError(body?.error ?? "上傳失敗，請稍後再試");
        return;
      }
      setNotice(
        `已為「${body.sourceName}」建立 ${body.sampleCount} 句樣本` +
          (body.replaced ? "（取代舊語料）" : "")
      );
      const listRes = await fetch("/api/corpus");
      if (listRes.ok) {
        const listBody = (await listRes.json()) as { corpora: CorpusSummary[] };
        setCorpora(listBody.corpora);
      }
    } catch {
      setError("上傳失敗，請稍後再試");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold">設定</h1>
        <Link href="/" className="text-sm text-blue-600 hover:underline">
          ← 回聊天室
        </Link>
      </div>

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-1 text-sm font-semibold">風格語料</h2>
        <p className="mb-4 text-xs text-gray-500">
          上傳 LINE 匯出的 .txt 聊天記錄，只保留你自己的發言作為 AI 模仿語氣的樣本；
          原始檔內容與對方訊息不會被保存。重複上傳同一位對象會整組取代舊語料。
        </p>

        <form onSubmit={handleUpload} className="mb-4 flex flex-col gap-2">
          <input
            type="file"
            accept=".txt"
            aria-label="選擇 LINE 匯出檔"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-sm"
          />
          <div className="flex gap-2">
            <input
              type="text"
              list="label-suggestions"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="對象類型（如：主管）"
              maxLength={20}
              className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
            />
            <datalist id="label-suggestions">
              {LABEL_SUGGESTIONS.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            <button
              type="submit"
              disabled={!file || label.trim().length === 0 || busy}
              className="rounded bg-blue-600 px-4 py-1 text-sm text-white disabled:opacity-40"
            >
              {busy ? "上傳中…" : "上傳"}
            </button>
          </div>
        </form>

        {notice && <p className="mb-3 text-sm text-green-700">{notice}</p>}
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

        {corpora.length === 0 ? (
          <p className="text-sm text-gray-400">尚未上傳任何語料。</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {corpora.map((c) => (
              <li key={c.id} className="flex items-center justify-between py-2">
                <div>
                  <p className="text-sm">
                    <span className="mr-2 rounded bg-gray-100 px-2 py-0.5 text-xs">
                      {c.contactLabel}
                    </span>
                    {c.sourceName}
                  </p>
                  {!counterpartNames.includes(c.sourceName) && (
                    <p className="mt-1 text-xs text-amber-600">
                      ⚠ 沒有名為「{c.sourceName}」的對話對象，引擎不會使用這組語料
                    </p>
                  )}
                </div>
                <span className="text-xs text-gray-500">{c.sampleCount} 句</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
```

- [ ] **Step 3.4: 建立 `src/app/settings/page.tsx`**

```tsx
// 設定頁（server component）：session 守門 + 初始資料，互動交給 SettingsApp。
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { openSession } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/cookie";
import { listCorpora } from "@/lib/corpus/corpus";
import { listConversations } from "@/lib/chat/queries";
import SettingsApp from "./SettingsApp";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const userId = token ? openSession(token) : null;
  if (!userId) redirect("/login");

  return (
    <SettingsApp
      initialCorpora={listCorpora(db, userId)}
      counterpartNames={listConversations(db, userId).map((c) => c.counterpartName)}
    />
  );
}
```

- [ ] **Step 3.5: 執行測試，確認通過**

Run: `npm test -- src/app/settings/SettingsApp.test.tsx`
Expected: PASS（4 tests）

- [ ] **Step 3.6: Commit**

```bash
git add src/app/settings/
git commit -m "feat(settings): add settings page with corpus upload UI

語料 API 已就緒但無操作介面，使用者仍無法自行匯入聊天記錄。

新增 /settings 頁：server component 守門（沿用聊天首頁模式）+
client 互動層。上傳表單以 FileReader 讀 .txt 後送 JSON；對象類型
提供 datalist 建議（主管/同事/朋友/家人）但允許自由輸入。清單中
sourceName 與既有對話對象不符時顯示警示——引擎以 sourceName 比對
displayName 挑語料（draftContext.ts），不符即為無效語料。

影響 src/app/settings/（新增）。BYOK 區塊後續掛入本頁。"
```

---

### Task 4: 聊天頁 header 加「設定」連結

**Files:**
- Modify: `src/app/chat/ChatApp.tsx:262-267`（header 登出按鈕旁）
- Test: `src/app/chat/ChatApp.test.tsx`（既有檔案加一個斷言）

- [ ] **Step 4.1: 寫失敗測試**

在 `src/app/chat/ChatApp.test.tsx` 的 `describe("ChatApp — 初次載入")` 區塊內
（`載入首個對話的訊息` 測試之後）加入：

```tsx
  it("header 有通往 /settings 的設定連結", () => {
    render(<ChatApp me={ME} initialConversations={conversations()} />);
    const link = screen.getByRole("link", { name: "設定" });
    expect(link).toHaveAttribute("href", "/settings");
  });
```

（該檔既有的 `render`、`screen`、`ME`、`conversations()` 均已在 scope 內，
fetch 與 next/navigation 的 mock 由 `beforeEach` 處理，無需新增準備碼。）

- [ ] **Step 4.2: 執行測試，確認失敗**

Run: `npm test -- src/app/chat/ChatApp.test.tsx`
Expected: FAIL —— `Unable to find an accessible element with the role "link"`

- [ ] **Step 4.3: 修改 `src/app/chat/ChatApp.tsx`**

檔頭 import 區加：

```tsx
import Link from "next/link";
```

header 內把登出按鈕包成群組（原 262-267 行的 `<button>` 前後加上容器與連結）：

```tsx
          <div className="flex items-center gap-1">
            <Link
              href="/settings"
              className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
            >
              設定
            </Link>
            <button
              onClick={handleLogout}
              className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
            >
              登出
            </button>
          </div>
```

- [ ] **Step 4.4: 執行測試，確認通過**

Run: `npm test -- src/app/chat/ChatApp.test.tsx`
Expected: PASS

- [ ] **Step 4.5: Commit**

```bash
git add src/app/chat/ChatApp.tsx src/app/chat/ChatApp.test.tsx
git commit -m "feat(chat): link to settings page from chat header

/settings 已存在但無入口，只能手打網址。

在聊天頁 header 登出鈕旁加「設定」連結，樣式與登出一致。
儀表板入口由 feat/adoption-dashboard 分支自行加入。

影響 ChatApp.tsx header 區塊。"
```

---

### Task 5: 完工驗證

- [ ] **Step 5.1: 全套測試**

Run: `npm test`
Expected: 全綠（21 檔 208 tests + 新增約 20 tests）

- [ ] **Step 5.2: production build**

Run: `npm run build`
Expected: 成功，無型別錯誤；路由清單含 `/settings`、`/api/corpus`、`/api/corpus/upload`

- [ ] **Step 5.3: 手動 smoke（可選，建議）**

依 memory 的 smoke test 方式：`npm run dev` + 真實 `APP_SECRET`，
以 `tingyu` 登入 → 設定頁上傳一份手工 LINE 匯出檔 → 確認清單出現、
回聊天室對王主管的來訊按「AI 協助」確認引擎有吃到新語料。

- [ ] **Step 5.4: 分支收尾**

全綠後載入 sunnydata-branch-lifecycle skill，依 git-workflow.md 走 PR 流程
（self-review diff、PR body 四區段）。
```
