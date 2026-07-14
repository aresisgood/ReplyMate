# W6 功能組設計文件：語料上傳、語氣微調、採用率儀表板、BYOK 設定

- **日期**：2026-07-14
- **狀態**：已與使用者確認設計方向，待最終審閱
- **上游文件**：`ReplyMate_架構文件_v2.md`（§3 F2、§5、§6、§8）
- **範圍**：架構文件里程碑 W6 的全部四項功能。W2–W5 的引擎、聊天閉環、
  finalize/adopted 判定、autoReply 均已完成並有測試（208 tests 全綠），不在本文範圍。

---

## 1. 目標與背景

W6 是 Demo 前最後一批功能開發（W7 實測、W8 打磨）。四項功能補齊三條使用者旅程：

1. **語料上傳**：使用者能自行匯入 LINE 聊天記錄建立風格語料 —— 直接影響
   成功指標 1（盲測難辨 AI）；目前語料只能靠 seed 寫入。
2. **語氣微調**：草稿不滿意時一鍵重生（更正式/更簡短/更委婉）—— 提升
   成功指標 2（採用率 ≥ 60%）的達成機會。
3. **採用率儀表板**：成功指標 2 的展示面，Demo 時可直接投影。
4. **BYOK 設定**：多人 Demo 時各自負擔 API 費用（brief 約束 2 的解法），
   目前 key 只能靠 `.env`。

## 2. 交付方式

四個功能各開一個分支、獨立 PR，依序交付：

| 順序 | 分支 | 功能 |
| :--- | :--- | :--- |
| 1 | `feat/corpus-upload` | 語料上傳 + `/settings` 頁骨架 + header 導航 |
| 2 | `feat/tone-adjust` | 語氣微調 |
| 3 | `feat/adoption-dashboard` | 採用率儀表板（`/dashboard`） |
| 4 | `feat/byok-settings` | BYOK 個人 API key 設定 |

順序理由：語料上傳最先 —— 真實語料進來才能開始驗證 prompt 品質（風險 §11 第 1 條）；
它同時建立 `/settings` 頁骨架供 BYOK 重用。四者間無硬相依，可獨立 review 與 revert。

**共通實作模式**（沿用現有慣例）：

- Route handler 薄殼（session 驗證 + 輸入驗證 + 呼叫 lib）+ `src/lib` 純邏輯函式。
- 錯誤回 `{ error: string }` + 對應 HTTP status（§5 慣例）。
- 測試：API route 用 node 環境 + `testDb.ts` 記憶體 DB；元件用
  `// @vitest-environment jsdom` docblock。維持 80%+ 覆蓋率。

**UI 佈局決策**（使用者已確認）：

- `/dashboard` 獨立頁（Demo 投影用）。
- `/settings` 單頁含「風格語料」與「個人 API Key」兩區塊。
- 聊天頁 header 加「設定」「儀表板」連結。

---

## 3. 功能一：語料上傳（`feat/corpus-upload`）

### 3.1 API

**`POST /api/corpus/upload`**

- Body（JSON）：`{ fileText: string, contactLabel: string }`。
  前端以 `FileReader.readAsText()` 讀檔後傳文字，不引入 multipart 解析。
- 驗證：需 session；`fileText` 非空且 ≤ 2 MB（2,097,152 字元上限，超過回 413）；
  `contactLabel` trim 後非空且 ≤ 20 字元。
- 流程：
  1. `parseLineExport(fileText)` → 取得 `sourceName`（匯出檔標頭的對象名）與結構化訊息。
     解析失敗（無有效標頭）→ 400 `{ error: "無法辨識的 LINE 匯出格式" }`。
  2. `extractStyleSamples()` → 只留我方發言並過濾貼圖/媒體/通話/收回/純網址/過短過長。
  3. 可用樣本 0 句 → 400 `{ error: "檔案中沒有可用的風格樣本" }`，不寫入任何資料。
  4. **整組取代**（使用者已確認）：同一 transaction 內，刪除
     `(ownerId, sourceName)` 相同的既有 corpus（samples 隨 `onDelete: cascade` 清空），
     再 insert 新 corpus + samples。
  5. 回 200 `{ sourceName, contactLabel, sampleCount }`。
- 隱私（§8）：`fileText` 僅存在於請求處理期間，對方訊息與原始內容即棄，
  只有過濾後的我方發言落地至 `style_samples`。

**`GET /api/corpus`**

- 回 `{ corpora: Array<{ id, contactLabel, sourceName, sampleCount, createdAt }> }`，
  僅限本人（`ownerId = session.userId`）。
- 架構文件 §5 未列此路由；為 `/settings` 顯示既有語料所需，屬本設計新增。
- 不做刪除 API：重傳即整組取代，已覆蓋修正需求（YAGNI）。

### 3.2 UI（`/settings` 風格語料區塊）

- 檔案選擇（`accept=".txt"`）+ `contactLabel` 文字輸入
  （附 `datalist` 建議：主管、同事、朋友、家人）。
- 既有語料清單：每組顯示 contactLabel、sourceName、句數。
- 上傳後即時回饋：成功顯示「已建立 N 句樣本」；同名取代時顯示「已取代舊語料」；
  失敗顯示 API 回傳的錯誤原因。
- 語料比對提示：清單中 `sourceName` 若與任何既有對話對象的 displayName 都不符，
  顯示提醒（引擎以 `sourceName == 對方 displayName` 挑語料，見 `draftContext.ts`）。

### 3.3 導航（本分支順帶交付）

- 建立 `/settings` 頁骨架（後續 BYOK 區塊掛入同頁）。
- 聊天頁 header 加「設定」連結；「儀表板」連結由功能三的分支自行加入。

---

## 4. 功能二：語氣微調（`feat/tone-adjust`）

### 4.1 API

**`POST /api/drafts/:id/adjust`**

- Body：`{ tone: "formal" | "shorter" | "softer" }`（更正式/更簡短/更委婉，§6）。
  其他值回 400。
- 驗證：需 session；draft session 存在且屬於本人，否則 404/403；
  原 session 已 finalize（`finalText` 非 null）→ 409 `{ error: "草稿已定稿" }`。
- 行為：
  1. 以原 session 的 `messageId` 重建 draft context（`buildDraftContext`）。
  2. `toneAdjustments` = 原 session 的陣列 + 新 tone（**累積**，去重；
     如先「更正式」再「更簡短」= `["formal","shorter"]`）。
  3. 呼叫引擎生成（沿用 `keyResolver` 的 key 解析順序與 `max_tokens ≤ 300`）。
  4. 通過 `outputGuard` 檢查；未通過回 502（與現有 drafts API 行為一致）。
  5. **建立新 draft_session**（§6：一鍵重生視為新 session，供統計重生率），
     繼承原 `messageId` 與 `mode`，寫入累積後的 `toneAdjustments`（JSON 字串）。
  6. 回 200 `{ draftId, aiDraft, toneAdjustments }`。
- 原 session 不修改、不刪除（不可變原則；舊 session 留存即重生率的統計來源）。

### 4.2 UI（聊天頁草稿卡片）

- 草稿卡片加三顆按鈕：「更正式」「更簡短」「更委婉」。
- 點擊 → 呼叫 adjust API → 卡片內容換成新草稿，並以標籤顯示已套用的語氣
  （如 `已調整：更正式`）；後續編輯/送出走既有 finalize 流程（對新 draftId）。
- 生成中按鈕 disabled + 載入狀態；失敗顯示錯誤且保留原草稿。

---

## 5. 功能三：採用率儀表板（`feat/adoption-dashboard`）

### 5.1 API

**`GET /api/stats/adoption`**

- 需 session；只統計本人（`draft_sessions.userId = session.userId`）的資料。
- 回應：

```json
{
  "manualDrafts": 12,      // mode='manual' 且已 finalize 的 session 數
  "adoptedCount": 9,       // 其中 adopted=true 的數量
  "adoptionRate": 0.75,    // adoptedCount / manualDrafts；manualDrafts=0 時為 null
  "autoDrafts": 5,         // mode='auto' 的 session 總數（不計入採用率）
  "toneRegenCount": 3      // toneAdjustments 非空的 session 數（重生率素材）
}
```

- 採用率**只算 `mode='manual'` 且已 finalize**（§3 F4：auto 不計入，防指標灌水）。
  未 finalize 的 manual session（生成後被放棄）不列入分母 —— 與 §4.5
  「adopted 於 finalize 時判定」一致；被放棄的草稿數可由
  `manualDrafts` 與生成總數之差推得，不另立欄位（YAGNI）。

### 5.2 UI（`/dashboard` 獨立頁）

- 大數字顯示採用率（百分比），標示成功指標 2 的 60% 門檻
  （達標/未達標視覺區分；`adoptionRate === null` 顯示「尚無資料」）。
- 明細列：手動草稿數、採用數、自動送出數、語氣重生數。
- 載入時抓一次 + 手動「重新整理」鈕；不輪詢。
- header 加「儀表板」連結（本分支交付）。

---

## 6. 功能四：BYOK 設定（`feat/byok-settings`）

### 6.1 API

**`PUT /api/settings/api-key`**

- Body：`{ apiKey: string | null }`。
  - 字串：trim 後須以 `sk-ant-` 開頭且長度 ≥ 20，否則 400
    `{ error: "API key 格式不正確" }`（真偽交給實際呼叫時的上游 401）。
    通過則以 `crypto.ts`（AES-256-GCM，金鑰 = `APP_SECRET`）加密寫入
    `users.anthropicApiKeyEnc`。
  - `null`：清除（欄位設回 null）。
- 回 200 `{ configured: boolean }`。**永不回明文 key**（§5 慣例、§8）。

**`GET /api/settings/api-key`**

- 回 `{ configured: boolean }`（`anthropicApiKeyEnc` 是否非 null）。
- 架構文件 §5 未列此路由；為 UI 顯示狀態所需，屬本設計新增。

### 6.2 UI（`/settings` 個人 API Key 區塊）

- `type="password"` 輸入框 + 「儲存」鈕；「清除」鈕（送 `apiKey: null`）。
- 狀態顯示「已設定 / 未設定」（來自 GET）；儲存成功後清空輸入框。
- 說明文字：設定後草稿生成費用計入個人 Anthropic 帳號；
  未設定時使用系統開發用 key（`keyResolver` 既有解析順序，零改動）。

---

## 7. 錯誤處理與安全（全功能共通）

- 所有新路由皆需 session，未登入回 401（沿用既有 cookie/session 機制）。
- 輸入驗證在 route 邊界完成，快速失敗、訊息友善（rules/coding-style.md）。
- `corpus/upload` 與 `drafts/:id/adjust` 涉及較重操作（解析大檔 / LLM 呼叫），
  套用既有 `rateLimit.ts` 機制，額度沿用 drafts API 的既有設定精神。
- 不新增 schema migration：四項功能全部使用既有欄位
  （`styleCorpora`、`styleSamples`、`draftSessions.toneAdjustments`、
  `users.anthropicApiKeyEnc`）。

## 8. 測試計畫

每分支內：

- **API 測試**（node + testDb）：401 未登入、輸入驗證失敗、happy path、
  功能邊界 —— upload：0 句樣本、重傳取代、超大檔；adjust：已定稿 409、
  語氣累積、outputGuard 攔截；stats：無資料 null、auto 不計入；
  api-key：格式驗證、設定→清除、回應不含明文。
- **UI smoke test**（jsdom）：區塊渲染與主要互動各一。
- 全套 `npm test` 綠燈為各 PR 前置條件。

## 9. 明確不做（YAGNI）

- 語料刪除 API（重傳即取代）。
- 語料累加去重、embedding 檢索（§6 已排除）。
- 儀表板輪詢或圖表庫（大數字 + 明細足夠 Demo）。
- API key 有效性預檢呼叫（交給實際生成時的錯誤處理）。
- 全站 nav bar 重構（只加兩個連結）。
