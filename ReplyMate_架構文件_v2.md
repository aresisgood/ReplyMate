# ReplyMate 系統架構文件

> **文件定位**：本專案（AIPE03 · 工作和生活取得平衡）的完整技術架構，
> 可作為後續 15 張卡的「上游文件」貼位來源。
> **狀態標記**：✅ 已實作並驗證（Week 1）｜🔲 已規劃未實作（標註對應週次）。
> 依據：專案種子簡報 v1 + 規劃 v2（B 路線：自建聊天 + 內建 AI 代筆）。
> **v2 變更**：新增「每對話自動送出模式」與「BYOK 個人 API key」；
> 期望成果 4 修訂為「預設由本人確認後送出；全自動模式為每對話明確 opt-in」。

---

## 1. 產品定位

一個 **1 對 1 文字聊天軟體**，在每則來訊旁內建「AI 協助」：以使用者本人的
LINE 聊天記錄為風格語料，生成貼近本人語氣的回覆草稿；使用者確認或編輯後才送出。

**核心原則（源自 brief 期望成果 4）**：AI 只起草，**人保有最終送出權**。

**驗收目標**：8 週課堂 Demo，非上線產品。對應成功指標：

| 成功指標（brief） | 架構中的對應機制 |
|---|---|
| 1. 同學盲測難辨 AI | 風格語料 few-shot（§6）＋ 盲測模式（W7 stretch） |
| 2. 草稿採用率 ≥ 60% | `draft_sessions.adopted` 自動判定（§4.5）＋ 儀表板（W6） |
| 3. 登入→收訊→AI→確認→送出全程無誤 | 自建聊天閉環（§3 流程 F1） |

---

## 2. 系統架構總覽

```
┌─────────────────────────── Browser ───────────────────────────┐
│  Next.js App Router（React 19 + Tailwind v4）                  │
│  登入頁 🔲W4 │ 聊天介面 🔲W4-5 │ 語料上傳 🔲W6 │ 儀表板 🔲W6      │
└───────────────┬────────────────────────────────────────────────┘
                │ HTTP（訊息收取採 2 秒輪詢）
┌───────────────▼──────────── Next.js Server ────────────────────┐
│  API Routes（Route Handlers）🔲W4-6                             │
│  ├─ 認證（session cookie）                                      │
│  ├─ 聊天（conversations / messages）                            │
│  ├─ 草稿引擎入口（drafts）──────────┐                            │
│  └─ 語料上傳（corpus）              │                            │
│                                    ▼                            │
│  草稿引擎 🔲W2-3                Anthropic API                    │
│  few-shot 檢索 + prompt 組裝 → （claude-haiku）                  │
│                                                                 │
│  LINE Parser ✅（純函式，src/lib/parser）                        │
│  資料層 ✅  Drizzle ORM + better-sqlite3 → dev.db（本機 SQLite） │
└─────────────────────────────────────────────────────────────────┘
```

**分層原則**：草稿引擎與「訊息從哪來」解耦。引擎輸入只有
`（來訊文字, 對話上下文, 風格語料）`，因此未來換輸入層
（例如 Android 通知監聽）時引擎零改動。

---

## 3. 核心資料流程

**F1 — AI 協助回覆（主流程，成功指標 3）** 🔲W5 串接

```
王主管傳訊 ─→ messages 表 ─→ 輪詢帶回聊天視窗
                                   │ 使用者點「AI 協助」
                                   ▼
                    POST /api/drafts { messageId }
                                   │
        ┌──────────────────────────┼─────────────────────────┐
        ▼                          ▼                         ▼
  來訊 + 對話最近 N 則     styleSamples 取 8–15 句      使用者選的語氣參數
        └──────────────→ Prompt 組裝 ←──────────────────────┘
                                   │
                          Anthropic API（Haiku）
                                   ▼
                    draft_sessions 建檔（aiDraft）
                                   │ 使用者編輯/確認 → 送出
                                   ▼
              messages 新增一則 + draft_sessions 更新
              finalText、adopted =（編輯距離 ≈ 0）
```

**F2 — 風格語料建立** 🔲W6 UI（parser ✅ 已完成）

```
LINE 匯出 .txt 上傳 ─→ parseLineExport()：標頭/日期/訊息行結構化
                    ─→ extractStyleSamples()：只留我方發言、
                        濾除貼圖/媒體/通話/收回/純網址/過短過長
                    ─→ 寫入 styleCorpora + styleSamples（標 contactLabel）
                    ─→ 原始檔即棄，不落地保存（隱私，§8）
```

**F3 — 訊息收發** 🔲W4

```
送出：POST /api/conversations/:id/messages ─→ insert
接收：GET  /api/conversations/:id/messages?after=<cursor>（每 2 秒輪詢）
      cursor = 最後一則 createdAt，只回增量
```

**F4 — 自動回覆模式（opt-in）** 🔲W5

```
王主管 POST 訊息 → insert messages
                 → 查 conversation_settings：收訊方對此對話 autoReply？
                 → true：草稿引擎生成（用收訊方自己的 API key）
                          → insert 回覆 + draft_sessions（mode: "auto"）
                 → false：不動作，等使用者手動按 AI 協助（mode: "manual"）
```

觸發點內建於送訊 API handler，無背景 worker；輪詢架構下對方 2 秒內收到回覆。
自動送出之草稿**不計入採用率**（成功指標 2 僅統計 mode = 'manual'）。

---

## 4. 資料結構 ✅（`src/lib/db/schema.ts`，已建表驗證）

```
users ──┬─< conversations（userA, userB；@@unique 防重複配對）
        │        ├─< conversation_settings（userId+conversationId 唯一；autoReply）
        │        └─< messages（conversationId, senderId, text, createdAt）
        │                └─< draft_sessions
        ├─< style_corpora（contactLabel, sourceName）
        │        └─< style_samples（text, sentAt?; onDelete: cascade）
        └─< draft_sessions（aiDraft, finalText?, adopted, toneAdjustments?）
```

### 4.1 users
`id, username(unique), passwordHash(bcrypt), displayName, anthropicApiKeyEnc?, createdAt`
`anthropicApiKeyEnc`：使用者個人 Anthropic API key（BYOK），AES-256-GCM 加密落地（§8）。

### 4.2 conversations
只支援 1 對 1（**沒有群組 = 沒有特殊情況**）。`(userAId, userBId)` 唯一索引。

### 4.2b conversation_settings ✅
每使用者 × 每對話一筆：`autoReply`（預設 false = 人工確認）。
單獨開關粒度：可只對「主管」對話開自動、朋友維持手動。

### 4.3 messages
索引 `(conversationId, createdAt)` — 輪詢增量查詢的主路徑。

### 4.4 style_corpora / style_samples
語料按「對象類型」分組（`contactLabel`：主管/同事/朋友…），
引擎依當前對話對象的類型挑對應語料。`sourceName` 保留原匯出檔對象名。

### 4.5 draft_sessions（成功指標 2 的資料來源）
一次 AI 協助 = 一筆。`adopted` 判定規則：
`normalized_edit_distance(aiDraft, finalText) ≤ 0.1 → true`（W5 實作於 finalize API）。
`toneAdjustments` 存 JSON 字串（如 `["formal","shorter"]`，SQLite 無陣列型別）。
`mode`：`'manual'`（人工確認，計入採用率）| `'auto'`（自動送出，不計入）。

---

## 5. API 介面規劃 🔲W4–W6

| Method | Path | 用途 | 週次 |
|---|---|---|---|
| POST | `/api/auth/login` | 帳密驗證 → 設 session cookie | W4 |
| POST | `/api/auth/logout` | 清除 session | W4 |
| GET | `/api/conversations` | 我的對話列表（含最後一則預覽） | W4 |
| GET | `/api/conversations/:id/messages?after=` | 增量拉訊息（輪詢） | W4 |
| POST | `/api/conversations/:id/messages` | 送出訊息 | W4 |
| POST | `/api/drafts` | `{messageId}` → 生成草稿 | W5 |
| POST | `/api/drafts/:id/adjust` | `{tone}` → 語氣重生 | W6 |
| POST | `/api/drafts/:id/finalize` | `{finalText}` → 計算 adopted、寫入訊息 | W5 |
| POST | `/api/corpus/upload` | 上傳 LINE .txt → 建語料 | W6 |
| GET | `/api/stats/adoption` | 採用率統計（僅 mode='manual'） | W6 |
| PUT | `/api/conversations/:id/settings` | 切換此對話的 autoReply | W5 |
| PUT | `/api/settings/api-key` | 設定/清除個人 API key（只回「已設定」布林） | W6 |

慣例：所有 API 皆需 session；錯誤回 `{ error: string }` + 對應 HTTP status；
Anthropic API key 只存在 server 端環境變數，永不進瀏覽器。

---

## 6. 草稿引擎設計 🔲W2–3（風險最高，最早做）

**方法：few-shot prompting，不做 fine-tuning**（8 週 + API 費用約束下的最小解）。

### Prompt 骨架

```
system:
  你是 {displayName} 本人。以下是你過去對「{contactLabel}」類型對象
  的真實訊息範例，嚴格模仿其語氣、用詞、標點習慣與訊息長度：
  <examples>{8–15 句 styleSamples}</examples>
  規則：只輸出回覆本文；長度貼近範例平均；不解釋、不加引號。
  {語氣參數：更正式/更簡短/更委婉（若有）}

user:
  <對話最近 {N=6} 則，標明說話者>
  對方剛傳來：{incoming_text}
  請以 {displayName} 的身分草擬回覆。
```

### 檢索策略（v1 → 可迭代）

- v1：同 `contactLabel` 語料中**隨機取樣** 8–15 句（保留長短分布）
- v2（若 W3 品質不足）：以字數區間 + 關鍵詞相似度加權取樣
- 明確不做：embedding 向量庫（Demo 語料量級用不上，過度設計）

### 成本控制（brief 約束 2）

模型 `claude-haiku`；`max_tokens ≤ 300`；語料截 15 句上限；
一鍵重生視為新 draft_session（可統計重生率）。
**BYOK**：key 解析順序 = `使用者個人 key ?? .env 開發用 key`，
費用由各使用者自己的帳號承擔（直接解掉 brief 約束 2）。

---

## 7. 關鍵技術決策記錄（ADR 摘要）

| # | 決策 | 理由 | 淘汰的替代方案 |
|---|---|---|---|
| 1 | 自建聊天（B 路線） | Demo 完整閉環，貼合成功指標 3 | 貼上式（流程有斷點）；LINE 外掛（Chrome 版已判死、桌面版無外掛 API、逆向工程會被封號） |
| 2 | Drizzle ORM，非 Prisma | 純 TS、無 Rust 引擎二進位下載、離線可裝 | Prisma（引擎下載為額外故障點，已實測受阻） |
| 3 | SQLite 本機檔 | 單機 Demo、零維運、隱私最佳 | Postgres/雲端 DB（過度設計＋隱私面擴大） |
| 4 | 2 秒輪詢，非 WebSocket | 兩人 Demo 規模輪詢足夠，少一個自架 server 故障點 | WebSocket / Supabase Realtime（列為升級項） |
| 5 | few-shot，非 fine-tune | 時程與費用約束；風格模仿夠用 | fine-tuning（成本高、迭代慢） |
| 6 | 預建帳號，無註冊流程 | 成功指標 3 只要求「登入」 | 完整註冊/OAuth（範圍外） |
| 7 | 自動送出＝每對話 opt-in，預設人工確認 | 保留 brief 期望成果 4 精神；auto 不計採用率防指標灌水 | 全域開關（粒度太粗）；預設自動（違反掌控原則） |
| 8 | BYOK 個人 API key，AES-256-GCM 加密落地 | 費用歸各使用者（解約束 2）；金鑰不出 server | 共用 server key（費用集中且無法多人 Demo）；明文存放（違反約束 3） |

---

## 8. 安全與隱私（brief 約束 3）

- **資料不出本機**：SQLite 檔案存於專案目錄，無雲端資料庫。
- **語料最小化**：LINE 匯出檔解析後**只保留我方發言**，對方訊息與原始檔即棄。
- **密碼**：bcrypt（cost 10）雜湊，不存明文。✅（seed 已實作）
- **API key（BYOK）**：個人 key 以 AES-256-GCM 加密存 DB（金鑰 = `.env` 的 `APP_SECRET`），
  解密與 LLM 呼叫只在 server 端；前端僅能看到「已設定/未設定」。✅（crypto.ts 已實作＋測試）
- **開發用 fallback key**：`ANTHROPIC_API_KEY` 僅存 `.env`（已 gitignore）。
- **自動模式風險**：AI 以本人語氣自動發話，開啟時 UI 須有持續可見的狀態標示；
  Demo 時向受測者揭露。
- **送往 LLM 的內容**：來訊 + 近 6 則上下文 + 語料樣本；Demo 前向受測同學揭露此事。
- 明確不做（範圍外）：端對端加密、多租戶隔離、稽核日誌。

---

## 9. 目錄結構

```
reply-mate/
├── drizzle.config.ts            # drizzle-kit 設定 ✅
├── next.config.ts               # serverExternalPackages: better-sqlite3 ✅
├── scripts/seed.ts              # Demo 帳號 + 示範對話 + 初始語料 ✅
├── src/
│   ├── app/                     # App Router
│   │   ├── page.tsx             # W1 資料層自檢頁 ✅（W4 換登入/聊天）
│   │   ├── api/                 # 🔲 W4-6（§5 路由）
│   │   └── (chat)/              # 🔲 W4-5 聊天介面
│   └── lib/
│       ├── db/schema.ts         # 五實體 schema ✅
│       ├── db/index.ts          # Drizzle 單例 ✅
│       ├── parser/lineParser.ts # LINE 匯出 parser ✅（9 tests）
│       ├── crypto.ts            # AES-256-GCM 機密欄位加解密 ✅（4 tests）
│       └── engine/              # 🔲 W2-3 草稿引擎
└── dev.db                       # 本機 SQLite（gitignore）
```

---

## 10. 里程碑 × 模組對照

| 週 | 交付 | 觸及模組 |
|---|---|---|
| 1 ✅ | 骨架 + schema + parser + seed | db/、parser/、app 殼層 |
| 2–3 | 草稿引擎 + prompt 調校 | engine/、Anthropic API |
| 4 | 登入 + 聊天（輪詢） | api/auth、api/conversations、(chat)/ |
| 5 | 引擎接入 UI + adopted 判定 | api/drafts、草稿卡片元件 |
| 6 | 語氣微調 + 儀表板 + 語料上傳 | api/drafts/adjust、api/corpus、api/stats |
| 7 | 同學實測（stretch：盲測模式） | — |
| 8 | 緩衝 + Demo 打磨 | — |

## 11. 風險與對策

| 風險 | 對策 |
|---|---|
| 草稿「不像本人」（成功指標 1 失敗） | W2-3 最早做；語料按對象分組；預留 v2 檢索策略 |
| 真實 LINE 匯出格式與 parser 假設有出入 | parser 為純函式 + 測試齊全，拿到真實檔案即可加 fixture 修正 |
| API 費用超支 | Haiku + max_tokens 300 + 語料上限；儀表板順帶記錄呼叫次數 |
| Demo 當天網路/環境故障 | 全本機架構，僅 LLM 呼叫需外網；預錄備用影片（W8） |

---

*ReplyMate 架構文件 v2 · 2026-07-09 · 對應程式碼：reply-mate-week1.zip（含 v2 schema）*
