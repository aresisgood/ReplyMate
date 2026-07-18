# 語料分類系統（style categories）設計文件

- **日期**: 2026-07-18（v2 — 由「完全移除分類」修訂為「使用者自控分類」）
- **分支**: `fix/corpus-user-scope`
- **來源**: W7 同學實測回饋 — 語意讀取應是登入時選擇匯入文字檔，目的為
  學習使用者語氣，並非（由系統自動）綁定對話對象。

## 問題陳述

實測發現的語意錯誤：

1. **語料被系統自動綁定在對話對象上**：`draftContext.ts` 以對方的
   `displayName` 比對 `styleCorpora.sourceName`，名字對不上 → few-shot
   樣本數為 0，AI 完全學不到使用者語氣。
2. **上傳入口只在設定頁**：登入後無任何引導，引擎長期在無語料狀態運作。

## 修訂歷程

- v1 決策曾為「完全移除分類」；使用者進一步定義需求後修訂為 v2：
  **分類保留，但改為使用者主動選擇**（匯入時選分類、聊天時選分類），
  系統不再以名字自動比對。「對不同對象用不同語氣」的能力保留，
  「比對失敗樣本歸零」的故障模式消除。

## 決策（已與使用者確認）

| 決策點 | 結論 |
| :--- | :--- |
| 分類模型 | 獨立分類表 `styleCategories` + FK；`categoryId = null` 代表「通用」 |
| 通用語意 | **通用 = 使用全部語料**（合併所有分類的樣本抽樣）；特定分類 = 只用該分類 |
| 匯入預設 | 匯入表單預設「通用」；點擊出現選單：通用、自訂分類（可重新命名）、新增分類 |
| 聊天選擇 | AI 協助按鈕旁有分類選擇器，**每個對話記住選擇**（存 `conversationSettings`），手動草稿與 autoReply 皆用同一分類 |
| 舊 contactLabel | 移除（schema 欄位刪除）；由新分類系統取代 |
| 登入引導 | 登入成功後語料為空 → 導 `/onboarding`（可略過）；有語料 → 進聊天 |
| sourceName 去留 | 保留：重複上傳同檔取代依據 + 清單顯示 |
| 分支 | `fix/corpus-user-scope`（單一分支） |

## 變更設計

### A. 資料層

- `styleCategories` 新表：

```ts
export const styleCategories = sqliteTable(
  "style_categories",
  {
    id: id(),
    ownerId: text("owner_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("style_categories_owner_name_unique").on(t.ownerId, t.name)]
);
```

- `styleCorpora`：刪除 `contactLabel`；新增
  `categoryId: text("category_id").references(() => styleCategories.id)`（nullable，null = 通用）
- `conversationSettings`：新增
  `styleCategoryId: text("style_category_id").references(() => styleCategories.id)`（nullable，null = 通用）
- migration 以 `drizzle-kit generate` 產生（testDb 走 migrations）；
  dev.db 以 `db:reset` 重建

- 新模組 `src/lib/corpus/categories.ts`：
  - `listCategories(db, ownerId)` → `{ id, name }[]`
  - `createCategory(db, ownerId, name)` — name trim 後 1–20 字、
    同 owner 不重複、不得為保留字「通用」；違反 → `ValidationError`
  - `renameCategory(db, ownerId, categoryId, name)` — 驗證同上 +
    ownership 檢查（非本人分類 → `NotFoundError`）
- `corpus.ts`：`importLineCorpus` 增加 `categoryId?: string | null`，
  寫入前驗證該分類屬於 owner（不存在/非本人 → `ValidationError`）；
  重傳取代語意不變（取代時套用新傳入的 categoryId）；
  `CorpusSummary` 改含 `categoryId: string | null` 與 `categoryName: string | null`
- `settings.ts`：新增 `getStyleCategoryId` / `setStyleCategoryId`
  （upsert 模式同 autoReply；set 前驗證分類屬於本人或為 null）

### B. 引擎層

- `draftContext.ts`：
  1. 由 `incoming.conversationId` 讀 `conversationSettings.styleCategoryId`
  2. `null`（通用）→ join 取 owner 全部語料樣本
  3. 有值 → join 加 `styleCorpora.categoryId = 設定值` 過濾
  4. 分類下無樣本 → 空陣列，不阻擋（維持品質降級原則）
  5. 回傳不含 `contactLabel`
- `prompt.ts`：`BuildPromptInput` 移除 `contactLabel`；system 首段改為
  「以下是你過去傳過的真實訊息範例」
- `autoReply.ts`：經由 `buildDraftContext` 自動套用對話分類，預期零修改
  （計畫階段驗證）

### C. API 層

- **新增** `GET /api/categories` → `{ categories: [{ id, name }] }`
- **新增** `POST /api/categories` body `{ name }` → 建立，回 `{ id, name }`
- **新增** `PUT /api/categories/[id]` body `{ name }` → 重新命名
- `POST /api/corpus/upload`：body `{ fileText, categoryId? }`；
  移除 contactLabel 驗證
- `GET /api/corpus`：項目含 `categoryId`/`categoryName`
- `PUT /api/conversations/[id]/settings`：body 擴充為
  `{ autoReply?, styleCategoryId? }`（皆選填，至少一項）；
  `styleCategoryId: null` = 通用
- `POST /api/drafts`：**契約不變**（分類由對話設定推導）

### D. UI 層

- **新增 `src/app/components/CategoryPicker.tsx`**（共用分類選擇器）：
  - 按鈕顯示目前分類名（預設「通用」）；點擊展開選單
  - 選單：「通用」+ 自訂分類清單（各含「改名」鈕，inline 輸入）+
    「＋ 新增分類」（inline 輸入）
  - props：`categories`、`value`（categoryId | null）、`onChange`、
    `onCreate(name)`、`onRename(id, name)`（資料操作交由外層打 API）
- **`CorpusUploadForm.tsx`**（共用上傳表單）：選檔 + `CategoryPicker`
  （預設通用）+ 上傳；成功後 `onUploaded` 回呼
- `SettingsApp.tsx`：用共用表單；清單顯示 sourceName + 分類名 + 句數；
  移除舊標籤輸入與「查無對話對象」警示
- **新增 `/onboarding`**：說明 + `CorpusUploadForm` + 「略過」；
  上傳成功或略過 → 聊天首頁
- `ChatApp.tsx`：AI 協助按鈕旁放 `CategoryPicker`，值 =
  該對話的 `styleCategoryId`（隨對話切換）；變更 → PUT conversation
  settings 並樂觀更新本地 state；`Conversation` 型別與 `page.tsx`
  初始資料補上 `styleCategoryId`
- `login/page.tsx`：登入成功後 `GET /api/corpus`，空 → `/onboarding`，
  否則 `/`；檢查失敗 fallback `/`

### E. 錯誤處理

- 分類名驗證失敗 / 重名 → 400 + 明確訊息（「分類名稱 1–20 字」「分類名稱已存在」）
- 上傳帶不存在或他人的 categoryId → 400
- 聊天分類選單載入失敗 → 選擇器顯示「通用」並可重試；不阻擋聊天
- 分類下無語料樣本 → 草稿照常生成（無 few-shot，品質降級不阻擋）

### F. 測試計畫（TDD）

- `categories.test.ts`（新）：建立/改名/清單、重名 400、保留字、ownership
- `corpus.test.ts`：匯入帶分類/不帶分類、無效分類、取代時換分類
- `draftContext.test.ts`：通用合併全部、指定分類只用該分類、
  分類無樣本不阻擋、他人語料不混入
- `settings.test.ts`：styleCategoryId get/set upsert、無效分類
- API tests：categories CRUD、upload 帶分類、conversation settings 擴充
- `CategoryPicker.test.tsx`（新）：展開選單、選擇、新增、改名
- `SettingsApp.test.tsx` / `OnboardingApp.test.tsx` / `ChatApp.test.tsx` /
  `login/page.test.tsx`：對應流程更新
- 覆蓋率維持 ≥ 80%

## 不做的事（YAGNI）

- 分類刪除（需處理語料與對話設定的重指派，本期不做；累積過多再議）
- 語料在分類間搬移（重傳即可換分類）
- 每則訊息臨時切換分類（分類屬於對話層級）
- contactLabel 資料遷移（欄位直接刪除，開發期資料可重建）

## 影響評估

- **嚴重度**: HIGH（核心功能——語氣學習——實測不可用）
- **影響範圍**: schema（2 表改 1 表增）、corpus/categories、draftContext、
  prompt、settings、4 個 API route（2 新增）、ChatApp、設定頁、登入頁、
  新 onboarding 頁、共用元件 ×2
- **破壞性變更**: upload API body 契約、conversation settings API body
  擴充（向後相容）、DB schema 需重建（db:reset）
