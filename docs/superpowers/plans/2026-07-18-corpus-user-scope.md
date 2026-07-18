# 語料分類系統（style categories）Implementation Plan v2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or the Execute Plan phase of superpowers:sunnydata-design to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 語料改為使用者自控分類（通用 = 全部語料）、匯入/聊天皆可選分類、移除名字自動比對、登入後無語料引導匯入。

**Architecture:** 由下而上：schema+分類模組 → corpus → conversation settings → draftContext/prompt → API（categories 新增、upload/settings 擴充）→ 共用元件（CategoryPicker、CorpusUploadForm）→ 設定頁/onboarding/登入/ChatApp。每模組測試先紅後綠；vitest 不做跨檔 typecheck，最後統一 `typecheck`/`lint`/`build`。

**Tech Stack:** Next.js 15 App Router、Drizzle + better-sqlite3、Vitest + Testing Library。

**Spec:** `docs/superpowers/specs/2026-07-18-corpus-user-scope-design.md`（v2）

**使用者工作流：** commit 一律由使用者本人執行，各 Task 末尾只提供 message。測試前 `$env:Path = "C:\Program Files\nodejs;$env:Path"`。

---

### Task 1: schema、migration、categories 模組

**Files:**
- Modify: `src/lib/db/schema.ts`
- Create: `drizzle/0001_*.sql`（generate 產生）
- Create: `src/lib/corpus/categories.ts`
- Test（Create）: `src/lib/corpus/categories.test.ts`
- Modify: `scripts/seed.ts:55-60`

- [ ] **Step 1: 撰寫 categories.test.ts（紅）**

```ts
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
```

- [ ] **Step 2: 跑測試確認紅** — `npx vitest run src/lib/corpus/categories.test.ts` → FAIL（模組不存在）。

- [ ] **Step 3: schema.ts 三處變更**

1. `styleCorpora` 前**新增** `styleCategories` 表，並更新註解：

```ts
// 使用者自訂的語料分類。「通用」不是資料列——categoryId = null 即通用
//（= 使用全部語料），故「通用」為保留名稱。
export const styleCategories = sqliteTable(
  "style_categories",
  {
    id: id(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("style_categories_owner_name_unique").on(t.ownerId, t.name)]
);
```

2. `styleCorpora`：刪除 `contactLabel: text("contact_label").notNull(),`，加入：

```ts
    // null = 通用（不屬於任何自訂分類）
    categoryId: text("category_id").references(() => styleCategories.id),
```

表上方註解改為：

```ts
// 使用者上傳 LINE 匯出檔後建立的風格語料（使用者層級語氣樣本）。
// sourceName 僅用於「重複上傳同一檔案整組取代」與清單顯示，不參與引擎比對。
```

3. `conversationSettings` 加欄位（`autoReply` 之後）：

```ts
    // 此對話代筆用的語料分類；null = 通用（全部語料）
    styleCategoryId: text("style_category_id").references(() => styleCategories.id),
```

- [ ] **Step 4: 產生 migration** — `npx drizzle-kit generate` → 產出 `drizzle/0001_*.sql`（建 style_categories、style_corpora 去 contact_label 加 category_id、conversation_settings 加 style_category_id）。testDb 的 `migrate()` 自動套用。

- [ ] **Step 5: 建立 categories.ts**

```ts
// 語料分類（styleCategories）：使用者自訂、可改名。
// 「通用」是虛擬預設分類（categoryId = null = 全部語料），不落資料列，
// 故列為保留名稱。驗證與錯誤型別沿用 chat/queries 的 ValidationError 慣例。

import { and, eq } from "drizzle-orm";
import { styleCategories } from "../db/schema";
import type { AppDatabase } from "../db/types";
import { NotFoundError, ValidationError } from "../chat/queries";

const MAX_NAME_CHARS = 20;
const RESERVED_NAME = "通用";

export interface CategorySummary {
  id: string;
  name: string;
}

function validateName(
  db: AppDatabase,
  ownerId: string,
  name: string,
  excludeId?: string
): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_CHARS) {
    throw new ValidationError(`分類名稱須為 1–${MAX_NAME_CHARS} 字`);
  }
  if (trimmed === RESERVED_NAME) {
    throw new ValidationError("「通用」為保留名稱");
  }
  const dup = db
    .select()
    .from(styleCategories)
    .where(and(eq(styleCategories.ownerId, ownerId), eq(styleCategories.name, trimmed)))
    .get();
  if (dup && dup.id !== excludeId) throw new ValidationError("分類名稱已存在");
  return trimmed;
}

export function listCategories(db: AppDatabase, ownerId: string): CategorySummary[] {
  return db
    .select({ id: styleCategories.id, name: styleCategories.name })
    .from(styleCategories)
    .where(eq(styleCategories.ownerId, ownerId))
    .all();
}

export function createCategory(
  db: AppDatabase,
  ownerId: string,
  name: string
): CategorySummary {
  const trimmed = validateName(db, ownerId, name);
  const row = db
    .insert(styleCategories)
    .values({ ownerId, name: trimmed })
    .returning()
    .get();
  return { id: row.id, name: row.name };
}

export function renameCategory(
  db: AppDatabase,
  ownerId: string,
  categoryId: string,
  name: string
): CategorySummary {
  const existing = db
    .select()
    .from(styleCategories)
    .where(and(eq(styleCategories.id, categoryId), eq(styleCategories.ownerId, ownerId)))
    .get();
  if (!existing) throw new NotFoundError("分類不存在");
  const trimmed = validateName(db, ownerId, name, categoryId);
  db.update(styleCategories)
    .set({ name: trimmed })
    .where(eq(styleCategories.id, existing.id))
    .run();
  return { id: existing.id, name: trimmed };
}

// 匯入語料 / 對話設定引用分類前的 ownership 驗證。
// 以 ValidationError 呈現（對呼叫端而言是「參數不合法」而非資源查找）。
export function assertOwnedCategory(
  db: AppDatabase,
  ownerId: string,
  categoryId: string
): void {
  const row = db
    .select()
    .from(styleCategories)
    .where(and(eq(styleCategories.id, categoryId), eq(styleCategories.ownerId, ownerId)))
    .get();
  if (!row) throw new ValidationError("分類不存在");
}
```

- [ ] **Step 6: seed.ts 更新** — L56-60 改為（通用分類 = 不帶 categoryId）：

```ts
  const [corpus] = db
    .insert(tables.styleCorpora)
    .values({ ownerId: me.id, sourceName: "王主管" })
    .returning()
    .all();
```

- [ ] **Step 7: 跑測試確認綠** — `npx vitest run src/lib/corpus/categories.test.ts` → PASS。

- [ ] **Step 8: commit message（使用者執行）**

```
feat(corpus): 新增使用者自訂語料分類，schema 移除 contactLabel

實測發現語料以對方名字自動比對綁定，比對失敗時語氣樣本歸零；
需求修訂為使用者自控分類：匯入時選分類、聊天時依對話選分類，
「通用」= 使用全部語料。

新增 styleCategories 表與 categories 模組（建立/改名/清單/
ownership 驗證，「通用」為保留名稱不落列）；styleCorpora 刪
contact_label 改掛 categoryId（null = 通用）；conversationSettings
加 styleCategoryId。新增 0001 migration。

破壞性變更：DB schema 需 db:reset 重建。corpus/引擎/API/UI 的
對應修改在後續 commit。
```

---

### Task 2: corpus.ts — 匯入帶分類、移除 contactLabel

**Files:**
- Modify: `src/lib/corpus/corpus.ts`
- Test: `src/lib/corpus/corpus.test.ts`

- [ ] **Step 1: 更新 corpus.test.ts（紅）**

1. 所有 `importLineCorpus` 呼叫移除 `contactLabel` 屬性；回傳斷言（L51-56）改為：

```ts
    expect(result).toMatchObject({
      sourceName: "王主管",
      categoryId: null,
      sampleCount: 2,
      replaced: false,
    });
```

2. 重傳測試（L84-104）：移除 `contactLabel` 斷言；改驗「重傳可換分類」：

```ts
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
    const corpora = db.select().from(styleCorpora).where(eq(styleCorpora.ownerId, ownerId)).all();
    expect(corpora).toHaveLength(1);
    expect(corpora[0].categoryId).toBe(cat.id);
    // 舊 samples 無孤兒（保留原測試的 orphan 檢查段落）
  });
```

檔頭補 `import { createCategory } from "./categories";`

3. **新增**無效分類測試：

```ts
  it("categoryId 不存在或非本人 → ValidationError，不寫入資料", () => {
    expect(() =>
      importLineCorpus(db, { ownerId, fileText: EXPORT_FIXTURE, categoryId: "no-such" })
    ).toThrow(ValidationError);
    expect(db.select().from(styleCorpora).all()).toHaveLength(0);
  });
```

4. listCorpora 斷言（L140-144）改為：

```ts
    expect(mine[0]).toMatchObject({
      sourceName: "王主管",
      categoryId: null,
      categoryName: null,
      sampleCount: 2,
    });
```

- [ ] **Step 2: 跑測試確認紅** — `npx vitest run src/lib/corpus/corpus.test.ts`。

- [ ] **Step 3: 修改 corpus.ts**

1. import 增加 `styleCategories`（schema）與 `assertOwnedCategory`（`./categories`）。
2. 介面：

```ts
export interface ImportCorpusParams {
  ownerId: string;
  fileText: string;
  categoryId?: string | null; // null / 未給 = 通用
}

export interface ImportCorpusResult {
  corpusId: string;
  sourceName: string;
  categoryId: string | null;
  sampleCount: number;
  replaced: boolean;
}
```

3. `importLineCorpus`：解析後、transaction 前加：

```ts
  const categoryId = params.categoryId ?? null;
  if (categoryId !== null) assertOwnedCategory(db, params.ownerId, categoryId);
```

insert 改 `.values({ ownerId, sourceName, categoryId })`；回傳物件含 `categoryId`。
4. `CorpusSummary` 改為：

```ts
export interface CorpusSummary {
  id: string;
  sourceName: string;
  categoryId: string | null;
  categoryName: string | null;
  sampleCount: number;
  createdAtMs: number;
}
```

`listCorpora` select 加 `categoryId: styleCorpora.categoryId, categoryName: styleCategories.name`，
加 `.leftJoin(styleCategories, eq(styleCorpora.categoryId, styleCategories.id))`，
map 補 `categoryId: r.categoryId, categoryName: r.categoryName ?? null`。
5. 檔頭註解改述使用者層級語意（移除「我方名字推導」以外的對象綁定敘述）。

- [ ] **Step 4: 跑測試確認綠**，**Step 5: commit message（使用者執行）**

```
fix(corpus): 匯入語料改掛使用者分類，移除 contactLabel

importLineCorpus 以 categoryId?（null = 通用）取代必填的
contactLabel；寫入前驗證分類 ownership；重傳取代時套用新分類。
listCorpora 回傳 categoryId/categoryName（left join，通用為 null）。

影響：ImportCorpusParams/ImportCorpusResult/CorpusSummary 介面；
上層 API 與 UI 在後續 commit 跟進。
```

---

### Task 3: settings.ts — 對話的語料分類記憶

**Files:**
- Modify: `src/lib/chat/settings.ts`
- Test: `src/lib/chat/settings.test.ts`

- [ ] **Step 1: settings.test.ts 追加測試（紅）**（沿用該檔既有 testDb/fixture helper；下列為新增的 describe）

```ts
describe("styleCategory get/set", () => {
  it("預設為 null（通用）", () => {
    expect(getStyleCategory(db, userId, conversationId)).toBeNull();
  });

  it("set 後 get 回分類 id 與名稱；rename 後名稱跟著變", () => {
    const cat = createCategory(db, userId, "主管");
    setStyleCategoryId(db, userId, conversationId, cat.id);
    expect(getStyleCategory(db, userId, conversationId)).toEqual({ id: cat.id, name: "主管" });
    renameCategory(db, userId, cat.id, "直屬主管");
    expect(getStyleCategory(db, userId, conversationId)?.name).toBe("直屬主管");
  });

  it("set null 回到通用；不影響同列的 autoReply", () => {
    const cat = createCategory(db, userId, "主管");
    setAutoReply(db, userId, conversationId, true);
    setStyleCategoryId(db, userId, conversationId, cat.id);
    setStyleCategoryId(db, userId, conversationId, null);
    expect(getStyleCategory(db, userId, conversationId)).toBeNull();
    expect(getAutoReply(db, userId, conversationId)).toBe(true);
  });

  it("set 非本人分類 → ValidationError", () => {
    const theirs = createCategory(db, otherUserId, "同事");
    expect(() => setStyleCategoryId(db, userId, conversationId, theirs.id)).toThrow(
      ValidationError
    );
  });
});
```

（import 補 `createCategory, renameCategory`、`ValidationError`；若檔內無第二個使用者 fixture，仿現有 user helper 建 `otherUserId`。）

- [ ] **Step 2: 紅** → **Step 3: settings.ts 實作**（檔頭註解的「目前只有 autoReply」改為「autoReply 與 styleCategoryId」）：

```ts
export interface ConversationStyleCategory {
  id: string;
  name: string;
}

// 此對話代筆用的分類；null = 通用。join 取名稱，改名自動反映。
export function getStyleCategory(
  db: AppDatabase,
  userId: string,
  conversationId: string
): ConversationStyleCategory | null {
  const row = db
    .select({ id: styleCategories.id, name: styleCategories.name })
    .from(conversationSettings)
    .innerJoin(styleCategories, eq(conversationSettings.styleCategoryId, styleCategories.id))
    .where(whereUserAndConversation(userId, conversationId))
    .get();
  return row ?? null;
}

export function setStyleCategoryId(
  db: AppDatabase,
  userId: string,
  conversationId: string,
  categoryId: string | null
): void {
  if (categoryId !== null) assertOwnedCategory(db, userId, categoryId);
  const existing = db
    .select()
    .from(conversationSettings)
    .where(whereUserAndConversation(userId, conversationId))
    .get();

  if (existing) {
    db.update(conversationSettings)
      .set({ styleCategoryId: categoryId })
      .where(eq(conversationSettings.id, existing.id))
      .run();
  } else {
    db.insert(conversationSettings)
      .values({ userId, conversationId, styleCategoryId: categoryId })
      .run();
  }
}
```

（import 補 `styleCategories`、`assertOwnedCategory`。）

- [ ] **Step 4: 綠** — `npx vitest run src/lib/chat/settings.test.ts`。**Step 5: commit message**

```
feat(chat): 對話設定記住語料分類（styleCategoryId）

聊天室選定的分類須跨 session 生效，且 autoReply 自動回覆要用
同一分類，故落在 conversationSettings（upsert 模式同 autoReply）。
get 以 join 回傳 {id, name}，分類改名即時反映。

影響：settings 模組介面；draftContext 與 API 在後續 commit 使用。
```

---

### Task 4: draftContext — 依對話分類取樣本

**Files:**
- Modify: `src/lib/chat/draftContext.ts`
- Test: `src/lib/chat/draftContext.test.ts`

- [ ] **Step 1: 更新 draftContext.test.ts（紅）**

1. `seedCorpus` helper 改簽名（categoryId 選填）：

```ts
function seedCorpus(
  ownerId: string,
  sourceName: string,
  samples: string[],
  categoryId: string | null = null
) {
  const corpus = db
    .insert(tables.styleCorpora)
    .values({ ownerId, sourceName, categoryId })
    .returning()
    .get();
  db.insert(tables.styleSamples)
    .values(samples.map((text) => ({ corpusId: corpus.id, text })))
    .run();
}
```

2. beforeEach 呼叫改 `seedCorpus(me.id, "王主管", [...三句同前...]);`（註解：使用者層級語料，預設通用）。
3. 移除「組出 BuildPromptInput」測試中的 `expect(ctx.contactLabel).toBe("主管");`。
4. 原「依對方 displayName 比對」測試改名「未設定分類（通用）時取得本人全部語料樣本」，斷言不變。
5. 「只用我的語料」測試：`seedCorpus(outsider.id, "王主管", ["這是路人的語氣，不該出現"]);`
6. **新增**（import 補 `createCategory` 自 `../corpus/categories`、`setStyleCategoryId` 自 `./settings`）：

```ts
  it("通用（未設定）：合併所有分類的樣本", () => {
    const cat = createCategory(db, me.id, "朋友");
    seedCorpus(me.id, "陳小美", ["晚點打給你"], cat.id);
    const ctx = buildDraftContext(db, { messageId: incomingId, userId: me.id });
    expect(ctx.styleSamples).toContain("好的，我今晚整理完寄給您");
    expect(ctx.styleSamples).toContain("晚點打給你");
  });

  it("對話設了分類：只用該分類的樣本", () => {
    const cat = createCategory(db, me.id, "朋友");
    seedCorpus(me.id, "陳小美", ["晚點打給你"], cat.id);
    setStyleCategoryId(db, me.id, convId, cat.id);
    const ctx = buildDraftContext(db, { messageId: incomingId, userId: me.id });
    expect(ctx.styleSamples).toEqual(["晚點打給你"]);
  });

  it("分類下沒有語料：不阻擋，styleSamples 為空", () => {
    const cat = createCategory(db, me.id, "空分類");
    setStyleCategoryId(db, me.id, convId, cat.id);
    const ctx = buildDraftContext(db, { messageId: incomingId, userId: me.id });
    expect(ctx.styleSamples).toEqual([]);
  });
```

7. 原「找不到對應語料時不阻擋」測試改寫為「使用者沒有任何語料時不阻擋」（boss 對 `myOwnMessageId` 要求代筆，斷言 `styleSamples` 為 `[]`、移除 contactLabel 斷言；刪除 stranger 段落）。

- [ ] **Step 2: 紅** → **Step 3: 改寫 draftContext.ts**

1. 檔頭語料決策註解改為：「語料屬於使用者本人；對話可指定分類（conversationSettings.styleCategoryId），null = 通用 = 合併全部語料。取出樣本後交 retrieval 分層抽樣；無樣本不阻擋（架構 §6 品質降級）。」
2. 移除原「依對方名稱找語料」區塊（L54-65），改為：

```ts
  // 對話指定分類（null = 通用）；通用 = 本人全部語料，指定分類 = 只用該分類
  const setting = db
    .select()
    .from(conversationSettings)
    .where(
      and(
        eq(conversationSettings.userId, userId),
        eq(conversationSettings.conversationId, incoming.conversationId)
      )
    )
    .get();
  const categoryId = setting?.styleCategoryId ?? null;

  const samples = db
    .select({ text: styleSamples.text, sentAt: styleSamples.sentAt })
    .from(styleSamples)
    .innerJoin(styleCorpora, eq(styleSamples.corpusId, styleCorpora.id))
    .where(
      categoryId === null
        ? eq(styleCorpora.ownerId, userId)
        : and(eq(styleCorpora.ownerId, userId), eq(styleCorpora.categoryId, categoryId))
    )
    .all();
```

3. import 補 `conversationSettings`；回傳物件移除 `contactLabel` 行；`selectStyleSamples` 呼叫的 map 改用 `samples`（欄位名已對齊，`s.sentAt?.getTime() ?? null` 不變）。

- [ ] **Step 4: 綠** → **Step 5: commit message**

```
fix(engine): 草稿樣本改依對話分類取用，廢除名字自動比對

原以對方 displayName 比對語料 sourceName，比對失敗時 few-shot
樣本歸零，語氣學習實測不可用（W7 回饋）。

buildDraftContext 改讀對話的 styleCategoryId：null（通用）合併
本人全部語料樣本，指定分類只用該分類；交既有分層抽樣。
BuildPromptInput 不再含 contactLabel。autoReply 經同一路徑，
自動套用對話分類。

影響：所有草稿生成路徑（手動 + 自動）。
```

---

### Task 5: prompt — 移除 contactLabel

**Files:**
- Modify: `src/lib/engine/prompt.ts`
- Test: `src/lib/engine/prompt.test.ts`

- [ ] **Step 1（紅）:** `baseInput` 移除 `contactLabel: "主管",`；L19-23 測試改為：

```ts
  it("system 帶入本人名稱與語氣模仿指示", () => {
    const { system } = buildPrompt(baseInput());
    expect(system).toContain("賴庭右");
    expect(system).toContain("你過去傳過的真實訊息範例");
  });
```

- [ ] **Step 2: 修改 prompt.ts** — `BuildPromptInput` 移除 `contactLabel: string;`；`buildSystem` 首段改為：

```ts
  const parts = [
    `你是 ${displayName} 本人。以下是你過去傳過的真實訊息範例，` +
      `請嚴格模仿其語氣、用詞、標點習慣與訊息長度。`,
  ];
```

- [ ] **Step 3: 綠** — `npx vitest run src/lib/engine/ src/lib/chat/autoReply.test.ts src/lib/chat/drafts.test.ts`；若 generate/autoReply/drafts 測試的 BuildPromptInput fixture 帶 `contactLabel` 或斷言其文案，一併移除該欄位/斷言。

- [ ] **Step 4: commit message**

```
fix(engine): prompt 移除對象類型標籤，改通用語氣模仿指示

語料改為分類制後，「對『主管』類型對象的範例」說法失去依據。
BuildPromptInput 移除 contactLabel；system 首段改為「以下是你
過去傳過的真實訊息範例」。安全規則、tone 調整、標籤中和不變。
```

---

### Task 6: API — categories 路由（新）、upload、conversation settings

**Files:**
- Create: `src/app/api/categories/route.ts`
- Create: `src/app/api/categories/[id]/route.ts`
- Modify: `src/app/api/corpus/upload/route.ts`
- Modify: `src/app/api/conversations/[id]/settings/route.ts`
- Test（Create）: `src/app/api/categories.test.ts`
- Test: `src/app/api/corpus.test.ts`、`src/app/api/routes.test.ts`（settings PUT 案例所在檔，執行時確認）

- [ ] **Step 1: categories.test.ts（紅）**（request/cookie helper 仿 `corpus.test.ts` 同檔模式）

測試案例：GET 未登入 401；GET 回本人清單；POST 建立回 `{ id, name }`；POST 重名/超長/「通用」→ 400；PUT 改名成功；PUT 他人分類 → 404；PUT 重名 → 400。

- [ ] **Step 2: corpus.test.ts / settings 相關測試更新（紅）**

1. upload 呼叫全部移除 `contactLabel`；刪除「contactLabel 空白或超長」測試；happy path 斷言含 `categoryId: null`。
2. **新增** upload 帶分類案例：先 POST `/api/categories` 建「主管」，upload body `{ fileText, categoryId }` → 200 且 GET /api/corpus 回 `categoryName: "主管"`；`categoryId: "no-such"` → 400。
3. conversation settings PUT 測試（於其所在測試檔）新增：`{ styleCategoryId }` 設定成功回 `{ styleCategoryId }`；`{ styleCategoryId: null }` 成功；`{}` → 400；`{ autoReply: true, styleCategoryId: null }` 同時設定成功。

- [ ] **Step 3: 實作 categories/route.ts**

```ts
// GET /api/categories — 本人分類清單；POST — 建立自訂分類
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, mapChatError } from "@/lib/http";
import { createCategory, listCategories } from "@/lib/corpus/categories";

export async function GET(request: NextRequest) {
  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json({ categories: listCategories(db, auth) });
}

export async function POST(request: NextRequest) {
  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "請求格式錯誤" }, { status: 400 });
  }
  const { name } = (body ?? {}) as { name?: unknown };
  if (typeof name !== "string") {
    return NextResponse.json({ error: "缺少 name" }, { status: 400 });
  }
  try {
    return NextResponse.json(createCategory(db, auth, name));
  } catch (e) {
    return mapChatError(e, "POST categories");
  }
}
```

- [ ] **Step 4: 實作 categories/[id]/route.ts**

```ts
// PUT /api/categories/:id — 重新命名自訂分類
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, mapChatError } from "@/lib/http";
import { renameCategory } from "@/lib/corpus/categories";

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, { params }: RouteContext) {
  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "請求格式錯誤" }, { status: 400 });
  }
  const { name } = (body ?? {}) as { name?: unknown };
  if (typeof name !== "string") {
    return NextResponse.json({ error: "缺少 name" }, { status: 400 });
  }
  try {
    return NextResponse.json(renameCategory(db, auth, id, name));
  } catch (e) {
    return mapChatError(e, "PUT categories/[id]");
  }
}
```

- [ ] **Step 5: 修改 upload/route.ts** — 檔頭註解改 `{ fileText, categoryId? }`；刪 `MAX_LABEL_CHARS` 與 label 驗證；解構與驗證改為：

```ts
  const { fileText, categoryId } = (body ?? {}) as {
    fileText?: unknown;
    categoryId?: unknown;
  };
  if (typeof fileText !== "string" || fileText.length === 0) {
    return NextResponse.json({ error: "缺少 fileText" }, { status: 400 });
  }
  if (fileText.length > MAX_FILE_CHARS) {
    return NextResponse.json({ error: "檔案過大（上限約 2 MB）" }, { status: 413 });
  }
  if (categoryId !== undefined && categoryId !== null && typeof categoryId !== "string") {
    return NextResponse.json({ error: "categoryId 格式錯誤" }, { status: 400 });
  }
```

呼叫改 `importLineCorpus(db, { ownerId: userId, fileText, categoryId: categoryId ?? null })`
（ownership 錯誤由 `assertOwnedCategory` 丟 ValidationError，`mapChatError` 轉 400）。

- [ ] **Step 6: 修改 conversations/[id]/settings/route.ts** — body 處理改為：

```ts
  const raw = (body ?? {}) as { autoReply?: unknown; styleCategoryId?: unknown };
  const hasAutoReply = "autoReply" in raw;
  const hasCategory = "styleCategoryId" in raw;
  if (!hasAutoReply && !hasCategory) {
    return NextResponse.json({ error: "至少需要 autoReply 或 styleCategoryId" }, { status: 400 });
  }
  if (hasAutoReply && typeof raw.autoReply !== "boolean") {
    return NextResponse.json({ error: "autoReply 必須是布林值" }, { status: 400 });
  }
  if (hasCategory && raw.styleCategoryId !== null && typeof raw.styleCategoryId !== "string") {
    return NextResponse.json({ error: "styleCategoryId 必須是字串或 null" }, { status: 400 });
  }

  try {
    const result: { autoReply?: boolean; styleCategoryId?: string | null } = {};
    if (hasAutoReply) {
      result.autoReply = setAutoReply(db, userId, id, raw.autoReply as boolean);
    }
    if (hasCategory) {
      const categoryId = raw.styleCategoryId as string | null;
      setStyleCategoryId(db, userId, id, categoryId);
      result.styleCategoryId = categoryId;
    }
    return NextResponse.json(result);
  } catch (e) {
    return mapChatError(e, "PUT settings");
  }
}
```

（import 補 `setStyleCategoryId`；檔頭註解更新。）

- [ ] **Step 7: 綠** — `npx vitest run src/app/api/` 全數 PASS。**Step 8: commit message**

```
feat(api): 分類 CRUD 路由；upload 與對話設定支援分類

新增 GET/POST /api/categories 與 PUT /api/categories/:id
（改名）。upload body 改 { fileText, categoryId? } 並移除
contactLabel 驗證；PUT conversations/:id/settings 擴充為
{ autoReply?, styleCategoryId? } 皆選填（至少一項）。

破壞性變更：upload 契約移除必填 contactLabel；settings PUT
原格式（只帶 autoReply）向後相容。
```

---

### Task 7: UI 共用元件 — CategoryPicker、CorpusUploadForm

**Files:**
- Create: `src/app/components/CategoryPicker.tsx`
- Create: `src/app/components/CorpusUploadForm.tsx`
- Test（Create）: `src/app/components/CategoryPicker.test.tsx`

- [ ] **Step 1: CategoryPicker.test.tsx（紅）**（jsdom、cleanup 模式同 login page.test）

測試案例（完整 render + userEvent，fixture `categories = [{id:"k1",name:"主管"}]`）：
1. 按鈕顯示 `valueName`；點擊展開選單且呼叫 `onOpen`
2. 點「通用」→ `onSelect(null)`；點「主管」→ `onSelect({id:"k1",name:"主管"})`
3. 點「＋ 新增分類」→ 輸入名稱 → 按「建立」→ `onCreate("朋友")` 被呼叫；resolve 後選單關閉並 `onSelect` 新分類
4. 點「重新命名 主管」→ 輸入框預填「主管」→ 改字送出 → `onRename("k1", 新名)`

- [ ] **Step 2: 實作 CategoryPicker.tsx**

```tsx
"use client";
// 語料分類選擇器（純展示層）：資料操作透過 async callback 交由外層。
// valueName 與 categories 分離：外層可延遲載入清單（開啟選單才抓），
// 但按鈕上的目前分類名必須立即可顯示。「通用」= valueId null，非資料列。
import { useState } from "react";

export interface CategoryOption {
  id: string;
  name: string;
}

interface Props {
  categories: CategoryOption[];
  valueId: string | null; // null = 通用
  valueName: string;
  onOpen?: () => void;
  onSelect: (category: CategoryOption | null) => void;
  onCreate: (name: string) => Promise<CategoryOption | null>; // null = 失敗（錯誤由外層顯示）
  onRename: (id: string, name: string) => Promise<boolean>;
  /** 選單展開方向；聊天輸入列在畫面底部須向上展開 */
  direction?: "down" | "up";
  disabled?: boolean;
}

export default function CategoryPicker({
  categories,
  valueId,
  valueName,
  onOpen,
  onSelect,
  onCreate,
  onRename,
  direction = "down",
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  function resetEditing() {
    setCreating(false);
    setRenamingId(null);
    setInput("");
  }

  function toggleOpen() {
    if (disabled) return;
    if (!open) onOpen?.();
    setOpen(!open);
    resetEditing();
  }

  function choose(category: CategoryOption | null) {
    onSelect(category);
    setOpen(false);
    resetEditing();
  }

  async function submitCreate() {
    if (busy || !input.trim()) return;
    setBusy(true);
    const created = await onCreate(input);
    setBusy(false);
    if (created) choose(created);
  }

  async function submitRename(id: string) {
    if (busy || !input.trim()) return;
    setBusy(true);
    const ok = await onRename(id, input);
    setBusy(false);
    if (ok) resetEditing();
  }

  const menuPosition = direction === "up" ? "bottom-full mb-1" : "top-full mt-1";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggleOpen}
        disabled={disabled}
        aria-label="語料分類"
        className="rounded-full border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40"
      >
        🗂 {valueName}
      </button>

      {open && (
        <ul
          className={`absolute left-0 z-10 w-56 rounded-lg border border-gray-200 bg-white py-1 shadow-lg ${menuPosition}`}
        >
          <li>
            <button
              type="button"
              onClick={() => choose(null)}
              className={`w-full px-3 py-1.5 text-left text-sm hover:bg-gray-50 ${
                valueId === null ? "font-semibold text-blue-600" : ""
              }`}
            >
              通用
            </button>
          </li>

          {categories.map((c) => (
            <li key={c.id} className="flex items-center">
              {renamingId === c.id ? (
                <span className="flex flex-1 items-center gap-1 px-3 py-1">
                  <input
                    aria-label="分類新名稱"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    maxLength={20}
                    className="w-full rounded border border-gray-300 px-2 py-0.5 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => submitRename(c.id)}
                    disabled={busy || !input.trim()}
                    className="text-xs text-blue-600 disabled:opacity-40"
                  >
                    確定
                  </button>
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => choose(c)}
                    className={`flex-1 px-3 py-1.5 text-left text-sm hover:bg-gray-50 ${
                      valueId === c.id ? "font-semibold text-blue-600" : ""
                    }`}
                  >
                    {c.name}
                  </button>
                  <button
                    type="button"
                    aria-label={`重新命名 ${c.name}`}
                    onClick={() => {
                      setCreating(false);
                      setRenamingId(c.id);
                      setInput(c.name);
                    }}
                    className="px-2 text-xs text-gray-400 hover:text-gray-600"
                  >
                    ✏️
                  </button>
                </>
              )}
            </li>
          ))}

          <li className="border-t border-gray-100">
            {creating ? (
              <span className="flex items-center gap-1 px-3 py-1">
                <input
                  aria-label="新分類名稱"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  maxLength={20}
                  className="w-full rounded border border-gray-300 px-2 py-0.5 text-sm"
                />
                <button
                  type="button"
                  onClick={submitCreate}
                  disabled={busy || !input.trim()}
                  className="text-xs text-blue-600 disabled:opacity-40"
                >
                  建立
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setRenamingId(null);
                  setCreating(true);
                  setInput("");
                }}
                className="w-full px-3 py-1.5 text-left text-sm text-gray-500 hover:bg-gray-50"
              >
                ＋ 新增分類
              </button>
            )}
          </li>
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 3: 實作 CorpusUploadForm.tsx**（自我管理分類清單：延遲載入、建立/改名打 API）

```tsx
"use client";
// 共用語料上傳表單（設定頁 + onboarding）：選檔 + 分類（預設通用）→ 上傳。
// 分類清單延遲載入（展開選單才抓），建立/改名直接打 /api/categories。
import { useState } from "react";
import CategoryPicker, { type CategoryOption } from "./CategoryPicker";

interface Props {
  onUploaded?: () => void | Promise<void>;
}

export default function CorpusUploadForm({ onUploaded }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState<CategoryOption | null>(null); // null = 通用
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [categoriesLoaded, setCategoriesLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadCategories() {
    if (categoriesLoaded) return;
    try {
      const res = await fetch("/api/categories");
      if (res.ok) {
        const body = (await res.json()) as { categories: CategoryOption[] };
        setCategories(body.categories);
        setCategoriesLoaded(true);
      }
    } catch {
      // 載入失敗維持通用；下次展開重試
    }
  }

  async function createCategory(name: string): Promise<CategoryOption | null> {
    setError(null);
    try {
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = (await res.json().catch(() => null)) as
        | { id?: string; name?: string; error?: string }
        | null;
      if (!res.ok || !body?.id || !body.name) {
        setError(body?.error ?? "分類建立失敗，請稍後再試");
        return null;
      }
      const created = { id: body.id, name: body.name };
      setCategories((list) => [...list, created]);
      return created;
    } catch {
      setError("無法連線到伺服器");
      return null;
    }
  }

  async function renameCategory(id: string, name: string): Promise<boolean> {
    setError(null);
    try {
      const res = await fetch(`/api/categories/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = (await res.json().catch(() => null)) as
        | { id?: string; name?: string; error?: string }
        | null;
      if (!res.ok || !body?.name) {
        setError(body?.error ?? "分類改名失敗，請稍後再試");
        return false;
      }
      const renamed = { id, name: body.name };
      setCategories((list) => list.map((c) => (c.id === id ? renamed : c)));
      setCategory((current) => (current?.id === id ? renamed : current));
      return true;
    } catch {
      setError("無法連線到伺服器");
      return false;
    }
  }

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
        body: JSON.stringify(
          category ? { fileText, categoryId: category.id } : { fileText }
        ),
      });
      const body = (await res.json().catch(() => null)) as
        | { sourceName?: string; sampleCount?: number; replaced?: boolean; error?: string }
        | null;
      if (!res.ok || !body?.sourceName) {
        setError(body?.error ?? "上傳失敗，請稍後再試");
        return;
      }
      setNotice(
        `已從「${body.sourceName}」的對話建立 ${body.sampleCount} 句語氣樣本` +
          `（分類：${category?.name ?? "通用"}）` +
          (body.replaced ? "（取代舊語料）" : "")
      );
      await onUploaded?.();
    } catch {
      setError("上傳失敗，請稍後再試");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleUpload} className="flex flex-col gap-2">
      <input
        type="file"
        accept=".txt"
        aria-label="選擇 LINE 匯出檔"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="text-sm"
      />
      <div className="flex items-center gap-2">
        <CategoryPicker
          categories={categories}
          valueId={category?.id ?? null}
          valueName={category?.name ?? "通用"}
          onOpen={loadCategories}
          onSelect={setCategory}
          onCreate={createCategory}
          onRename={renameCategory}
        />
        <button
          type="submit"
          disabled={!file || busy}
          className="rounded bg-blue-600 px-4 py-1 text-sm text-white disabled:opacity-40"
        >
          {busy ? "上傳中…" : "上傳"}
        </button>
      </div>
      {notice && <p className="text-sm text-green-700">{notice}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
```

- [ ] **Step 4: 綠** — `npx vitest run src/app/components/`。**Step 5: commit message**

```
feat(ui): 共用分類選擇器與語料上傳表單

CategoryPicker：按鈕顯示目前分類（預設通用），展開選單可選
通用/自訂分類、inline 新增與改名；純展示層，資料操作交外層
async callback。CorpusUploadForm：選檔 + 分類 + 上傳，分類清單
延遲載入並直接打 categories API；成功後 onUploaded 回呼。

供設定頁、onboarding、聊天室（僅 Picker）三處共用。
```

---

### Task 8: SettingsApp 改用共用表單

**Files:**
- Modify: `src/app/settings/SettingsApp.tsx`
- Modify: `src/app/settings/page.tsx`
- Test: `src/app/settings/SettingsApp.test.tsx`

- [ ] **Step 1（紅）:** 測試更新：
1. `CORPORA` fixture：移除 `contactLabel`，加 `categoryId: null, categoryName: null`（c1）與 `categoryId: "k1", categoryName: "朋友"`（c2）。
2. render 移除 `counterpartNames` prop；刪除「查無對話對象警示」測試；清單斷言改驗 sourceName、句數與分類 badge（「通用」與「朋友」各一）。
3. `fillForm` 只選檔案（同 v1 plan）；上傳 body 斷言 `{ fileText: "..." }`；成功訊息斷言改「已從「王主管」的對話建立 48 句語氣樣本（分類：通用）」。

- [ ] **Step 2: SettingsApp.tsx 改寫** — 用 `CorpusUploadForm`（`onUploaded` = 重抓 `/api/corpus` 更新清單），props 只剩 `initialCorpora`，清單項目：

```tsx
              <li key={c.id} className="flex items-center justify-between py-2">
                <p className="text-sm">
                  <span className="mr-2 rounded bg-gray-100 px-2 py-0.5 text-xs">
                    {c.categoryName ?? "通用"}
                  </span>
                  {c.sourceName}
                </p>
                <span className="text-xs text-gray-500">{c.sampleCount} 句</span>
              </li>
```

說明文案末句改「重複上傳同一份對話會整組取代舊語料」。
- [ ] **Step 3: settings/page.tsx** — 移除 `listConversations` import；`return <SettingsApp initialCorpora={listCorpora(db, userId)} />;`
- [ ] **Step 4: 綠** — `npx vitest run src/app/settings/`。**Step 5: commit message**

```
refactor(ui): 設定頁改用共用上傳表單，語料清單顯示分類

移除舊對象標籤輸入與「查無對話對象」警示（名字比對已廢除）；
清單以分類 badge（通用/自訂名）+ sourceName + 句數呈現。
SettingsApp props 移除 counterpartNames。
```

---

### Task 9: onboarding 頁

**Files:**
- Create: `src/app/onboarding/OnboardingApp.tsx`、`src/app/onboarding/page.tsx`
- Test（Create）: `src/app/onboarding/OnboardingApp.test.tsx`

- [ ] **Step 1: OnboardingApp.test.tsx（紅）**

```tsx
// @vitest-environment jsdom
// OnboardingApp：上傳成功導回聊天、略過導回聊天、上傳失敗顯示錯誤不導頁。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import OnboardingApp from "./OnboardingApp";

const { push, refresh, router } = vi.hoisted(() => {
  const push = vi.fn();
  const refresh = vi.fn();
  return { push, refresh, router: { push, refresh } };
});
vi.mock("next/navigation", () => ({ useRouter: () => router }));

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return { ok: init.ok ?? true, status: init.status ?? 200, json: async () => body } as Response;
}

const fetchMock = vi.fn();

async function uploadFile(user: ReturnType<typeof userEvent.setup>) {
  const file = new File(["2024/01/01\n10:00\t我\t收到，晚點回你"], "line.txt", {
    type: "text/plain",
  });
  await user.upload(screen.getByLabelText("選擇 LINE 匯出檔"), file);
  await user.click(screen.getByRole("button", { name: "上傳" }));
}

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OnboardingApp", () => {
  it("顯示語氣學習說明與略過選項", () => {
    render(<OnboardingApp />);
    expect(screen.getByText(/學習你的語氣/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "先略過，直接開始" })).toBeInTheDocument();
  });

  it("上傳成功後導向聊天首頁", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ sourceName: "王主管", sampleCount: 3, replaced: false })
    );

    render(<OnboardingApp />);
    await uploadFile(user);

    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    expect(refresh).toHaveBeenCalled();
  });

  it("按「先略過」直接導向聊天首頁", async () => {
    const user = userEvent.setup();
    render(<OnboardingApp />);
    await user.click(screen.getByRole("button", { name: "先略過，直接開始" }));
    expect(push).toHaveBeenCalledWith("/");
  });

  it("上傳失敗顯示錯誤且不導頁", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "無法辨識的 LINE 匯出格式" }, { ok: false, status: 400 })
    );

    render(<OnboardingApp />);
    await uploadFile(user);

    expect(await screen.findByText("無法辨識的 LINE 匯出格式")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑測試確認紅** — 模組不存在。

- [ ] **Step 3: 建立 OnboardingApp.tsx**

```tsx
"use client";
// 首次登入引導：匯入 LINE 對話讓 AI 學習語氣；可略過，之後仍可在設定頁上傳。
import { useRouter } from "next/navigation";
import CorpusUploadForm from "../components/CorpusUploadForm";

export default function OnboardingApp() {
  const router = useRouter();

  function goChat() {
    router.push("/");
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-sm">
        <h1 className="text-xl font-bold">讓 AI 學習你的語氣</h1>
        <p className="mt-2 text-sm text-gray-600">
          上傳 LINE 匯出的 .txt 聊天記錄，AI 會只擷取你自己的發言作為語氣樣本，
          代筆時就能模仿你的用詞與標點習慣。對方的訊息與原始檔內容不會被保存。
        </p>

        <div className="mt-6">
          <CorpusUploadForm onUploaded={goChat} />
        </div>

        <button
          type="button"
          onClick={goChat}
          className="mt-6 w-full rounded-lg border border-gray-300 py-2 text-sm text-gray-600 hover:bg-gray-50"
        >
          先略過，直接開始
        </button>
        <p className="mt-2 text-center text-xs text-gray-400">
          之後可隨時在「設定」頁上傳語料。
        </p>
      </div>
    </main>
  );
}
```

- [ ] **Step 4: 建立 onboarding/page.tsx**

```tsx
// 引導頁（server component）：session 守門，互動交給 OnboardingApp。
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { openSession } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/cookie";
import OnboardingApp from "./OnboardingApp";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const userId = token ? openSession(token) : null;
  if (!userId) redirect("/login");

  return <OnboardingApp />;
}
```

- [ ] **Step 5: 綠** — `npx vitest run src/app/onboarding/`。**Step 6: commit message**

```
feat(ui): 新增登入後語料匯入引導頁 /onboarding

語料上傳原本只藏在設定頁，使用者不知道要先餵語料。新增
onboarding 頁（session 守門 + 共用上傳表單含分類選擇 + 可略
過），上傳成功或略過皆導向聊天首頁。導向由登入頁觸發（下一
commit）。
```

---

### Task 10: 登入後依語料狀態導向

**Files:**
- Modify: `src/app/login/page.tsx:29-30`
- Test: `src/app/login/page.test.tsx`

- [ ] **Step 1: page.test.tsx 更新（紅）**

1. 既有「登入成功時以帳密呼叫 API 並導向聊天首頁」測試改名並補語料 mock：

```ts
  it("登入成功且已有語料 → 導向聊天首頁", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ corpora: [{ id: "c1" }] }));

    render(<LoginPage />);
    await fillCredentials(user);
    await user.click(screen.getByRole("button", { name: "登入" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    expect(refresh).toHaveBeenCalled();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/auth/login");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      username: "tingyu",
      password: "demo1234",
    });
  });
```

2. **新增**兩個測試：

```ts
  it("登入成功但沒有語料 → 導向 /onboarding", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ corpora: [] }));

    render(<LoginPage />);
    await fillCredentials(user);
    await user.click(screen.getByRole("button", { name: "登入" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/onboarding"));
  });

  it("語料檢查失敗時仍導向聊天首頁（引導失敗不阻擋登入）", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockRejectedValueOnce(new Error("network down"));

    render(<LoginPage />);
    await fillCredentials(user);
    await user.click(screen.getByRole("button", { name: "登入" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
  });
```

3. 「送出中按鈕顯示…」測試：在 `resolveLogin(jsonResponse({ ok: true }));` 前加
   `fetchMock.mockResolvedValueOnce(jsonResponse({ corpora: [{ id: "c1" }] }));`

- [ ] **Step 2: 跑測試確認紅** — 無語料案例仍導向 `/`。

- [ ] **Step 3: 修改 login/page.tsx** — 原 L29-30（`router.push("/"); router.refresh();`）改為：

```ts
      // 無語料的新使用者導向引導頁；檢查失敗不阻擋登入（退回聊天首頁）
      let target = "/";
      try {
        const corpusRes = await fetch("/api/corpus");
        if (corpusRes.ok) {
          const corpusBody = (await corpusRes.json()) as { corpora?: unknown[] };
          if (Array.isArray(corpusBody.corpora) && corpusBody.corpora.length === 0) {
            target = "/onboarding";
          }
        }
      } catch {
        // 引導檢查失敗不影響登入
      }
      router.push(target);
      router.refresh();
```

- [ ] **Step 4: 綠** — `npx vitest run src/app/login/page.test.tsx`。**Step 5: commit message**

```
feat(ui): 登入後無語料時導向 /onboarding 引導匯入

登入成功後打 GET /api/corpus：空 → /onboarding，否則進聊天；
檢查失敗一律退回聊天首頁，引導不阻擋登入。僅登入流程觸發，
直接開啟 / 不強制導向。
```

---

### Task 11: ChatApp — AI 協助旁的分類選擇器

**Files:**
- Modify: `src/app/chat/ChatApp.tsx`
- Modify: `src/app/page.tsx`
- Test: `src/app/chat/ChatApp.test.tsx`

- [ ] **Step 1: ChatApp.test.tsx 更新（紅）**

1. `conversations()` fixture 兩筆各加 `styleCategoryId: null, styleCategoryName: null`。
2. fetchMock 的 `mockImplementation` 加一個分派分支（`/messages` 之前）：

```ts
    if (url.endsWith("/api/categories") && method === "GET") {
      return jsonResponse({ categories: [{ id: "k1", name: "朋友" }] });
    }
```

3. **新增** describe：

```ts
describe("ChatApp — 語料分類選擇", () => {
  it("AI 協助旁顯示目前分類（預設通用）", async () => {
    render(<ChatApp me={ME} initialConversations={conversations()} />);
    expect(await screen.findByRole("button", { name: "語料分類" })).toHaveTextContent("通用");
  });

  it("展開選單選擇分類 → PUT 對話設定並更新按鈕", async () => {
    const user = userEvent.setup();
    render(<ChatApp me={ME} initialConversations={conversations()} />);
    await user.click(screen.getByRole("button", { name: "語料分類" }));
    await user.click(await screen.findByRole("button", { name: "朋友" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "語料分類" })).toHaveTextContent("朋友")
    );
    const putCall = fetchMock.mock.calls.find(
      ([u, i]) => String(u).includes("/conversations/c1/settings") && i?.method === "PUT"
    );
    expect(putCall).toBeTruthy();
    expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual({
      styleCategoryId: "k1",
    });
  });

  it("PUT 失敗時顯示錯誤且按鈕維持原分類", async () => {
    const user = userEvent.setup();
    // 覆寫：settings PUT 回 400
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/settings") && init?.method === "PUT") {
        return jsonResponse({ error: "x" }, { ok: false, status: 400 });
      }
      return base(input, init);
    });

    render(<ChatApp me={ME} initialConversations={conversations()} />);
    await user.click(screen.getByRole("button", { name: "語料分類" }));
    await user.click(await screen.findByRole("button", { name: "朋友" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "語料分類" })).toHaveTextContent("通用");
  });

  it("切換對話時選擇器顯示該對話自己的分類", async () => {
    const user = userEvent.setup();
    const convs = conversations();
    convs[1] = { ...convs[1], styleCategoryId: "k1", styleCategoryName: "朋友" };
    render(<ChatApp me={ME} initialConversations={convs} />);
    expect(screen.getByRole("button", { name: "語料分類" })).toHaveTextContent("通用");
    await user.click(screen.getByText("小美"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "語料分類" })).toHaveTextContent("朋友")
    );
  });
});
```

- [ ] **Step 2: 紅** → **Step 3: ChatApp.tsx 修改**

1. import `CategoryPicker, { type CategoryOption }`。
2. `ConversationSummary` 加 `styleCategoryId: string | null; styleCategoryName: string | null;`。
3. 新 state 與函式（分類清單延遲載入 + 建立/改名 API 同 `CorpusUploadForm` 模式，錯誤走既有 `setError`）：

```tsx
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [categoriesLoaded, setCategoriesLoaded] = useState(false);

  async function loadCategories() {
    if (categoriesLoaded) return;
    try {
      const res = await fetch("/api/categories");
      if (res.ok) {
        const body = (await res.json()) as { categories: CategoryOption[] };
        setCategories(body.categories);
        setCategoriesLoaded(true);
      }
    } catch {
      // 展開時載入失敗維持現狀；下次展開重試
    }
  }

  async function handleCreateCategory(name: string): Promise<CategoryOption | null> {
    setError(null);
    try {
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = (await res.json().catch(() => null)) as
        | { id?: string; name?: string; error?: string }
        | null;
      if (!res.ok || !body?.id || !body.name) {
        setError(body?.error ?? "分類建立失敗，請稍後再試");
        return null;
      }
      const created = { id: body.id, name: body.name };
      setCategories((list) => [...list, created]);
      return created;
    } catch {
      setError("無法連線到伺服器");
      return null;
    }
  }

  async function handleRenameCategory(id: string, name: string): Promise<boolean> {
    setError(null);
    try {
      const res = await fetch(`/api/categories/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = (await res.json().catch(() => null)) as
        | { name?: string; error?: string }
        | null;
      if (!res.ok || !body?.name) {
        setError(body?.error ?? "分類改名失敗，請稍後再試");
        return false;
      }
      const newName = body.name;
      setCategories((list) => list.map((c) => (c.id === id ? { id, name: newName } : c)));
      // 已套用此分類的對話按鈕名稱同步更新
      setConversations((list) =>
        list.map((c) =>
          c.styleCategoryId === id ? { ...c, styleCategoryName: newName } : c
        )
      );
      return true;
    } catch {
      setError("無法連線到伺服器");
      return false;
    }
  }

  async function handleSelectCategory(category: CategoryOption | null) {
    if (!active) return;
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${active.conversationId}/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ styleCategoryId: category?.id ?? null }),
      });
      if (res.ok) {
        setConversations((list) =>
          list.map((c) =>
            c.conversationId === active.conversationId
              ? {
                  ...c,
                  styleCategoryId: category?.id ?? null,
                  styleCategoryName: category?.name ?? null,
                }
              : c
          )
        );
      } else {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "語料分類設定失敗，請稍後再試");
      }
    } catch {
      setError("無法連線到伺服器");
    }
  }
```

4. 輸入列（`AI 協助` 按鈕之前）插入：

```tsx
              <CategoryPicker
                categories={categories}
                valueId={active.styleCategoryId}
                valueName={active.styleCategoryName ?? "通用"}
                onOpen={loadCategories}
                onSelect={handleSelectCategory}
                onCreate={handleCreateCategory}
                onRename={handleRenameCategory}
                direction="up"
              />
```

- [ ] **Step 4: page.tsx（聊天首頁）** — import 補 `getStyleCategory`，map 改為：

```ts
  const conversations = listConversations(db, userId).map((c) => {
    const styleCategory = getStyleCategory(db, userId, c.conversationId);
    return {
      ...c,
      autoReply: getAutoReply(db, userId, c.conversationId),
      styleCategoryId: styleCategory?.id ?? null,
      styleCategoryName: styleCategory?.name ?? null,
    };
  });
```

- [ ] **Step 5: 綠** — `npx vitest run src/app/chat/`（含既有測試不得回歸）。**Step 6: commit message**

```
feat(chat): AI 協助旁加語料分類選擇器，選擇存入對話設定

分類「對應使用對象」由使用者在對話中主動指定：選擇即 PUT
conversation settings（styleCategoryId），手動草稿與 autoReply
經 draftContext 讀同一設定自動生效。分類清單延遲載入；改名
同步更新側欄各對話的按鈕名稱；失敗走既有錯誤列並還原顯示。

影響：ChatApp、聊天首頁初始資料（帶入各對話分類）。
```

---

### Task 12: 收尾 — 全案驗證

- [ ] **Step 1:** `npx vitest run --coverage` → 全 PASS、覆蓋率 ≥ 80%
- [ ] **Step 2:** `npm run typecheck; npm run lint` → 0 error（殘留 contactLabel 引用逐一清除）
- [ ] **Step 3:** `npm run db:reset` → dev.db 依新 schema 重建 + seed
- [ ] **Step 4:** `npm run build` → 成功，路由含 `/onboarding`、`/api/categories`
- [ ] **Step 5: 冒煙測試（手動）**
  1. `npm run dev`（真實 APP_SECRET）
  2. 登入 `boss`（無語料）→ `/onboarding`；建自訂分類「同事」→ 上傳 .txt 到該分類 → 進聊天
  3. 登入 `tingyu` → 直接進聊天；AI 協助旁顯示「通用」；展開選單建「主管」分類、改名、選擇 → 重新整理後選擇保留
  4. 對來訊按 AI 協助 → 草稿正常（需 ANTHROPIC_API_KEY）；開 autoReply 讓 boss 傳訊 → 自動回覆使用對話分類
  5. 設定頁：上傳帶分類、清單顯示分類 badge
- [ ] **Step 6:** 載入 sunnydata-code-review skill self-review（處理 CRITICAL/HIGH）→ 使用者依 git-workflow.md 建 PR

---

## 計畫不包含（YAGNI）

- 分類刪除、語料跨分類搬移、每則訊息臨時切換分類
- `ReplyMate_架構文件_v2.md` / README 文字更新（可另補 docs commit）

## Self-review 紀錄

- Spec 覆蓋：A（T1-3）、B（T4-5）、C（T6）、D（T7-11）、E（各 UI Task 錯誤案例 + T6 驗證）、F（各 Task Step 1 + T12）✓
- 型別一致：`CategoryOption`（Picker 匯出，Form/ChatApp 共用）、`CorpusSummary.categoryId/categoryName`（T2 定義、T8 使用）、`ConversationSummary.styleCategoryId/Name`（T11 與 page.tsx 對齊）、settings PUT 回傳鍵名 `styleCategoryId`（T6 與 T11 對齊）✓
- 無佔位符：T9/T10 已展開為完整程式碼；條件式指示（「如有則移除」）附明確判準 ✓
