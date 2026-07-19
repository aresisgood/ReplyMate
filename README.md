# ReplyMate

內建 AI 代筆的 1 對 1 訊息軟體 — 讓休息真正成為休息。

ReplyMate 是一個自建的網頁聊天系統：你上傳自己的 LINE 聊天記錄讓 AI 學習語氣，之後收到訊息時，AI 能以「你的口吻」代擬回覆草稿——你可以確認後送出、動手修改，或對特定對話開啟全自動回覆。

## 系統功能

- **1 對 1 聊天**：登入後即有對話列表與訊息收發，新訊息以 2 秒輪詢更新。
- **風格語料**：上傳 LINE 匯出的 `.txt` 聊天記錄，系統只擷取「你自己的發言」作為語氣樣本；對方的訊息與原始檔內容不會被保存。重複上傳同一份對話會整組取代舊語料。
- **語料分類**：可自訂分類（如「對主管」「對朋友」），並替每個對話指定要模仿哪一類語氣；未指定則使用全部語料。
- **AI 協助草稿**：在對話中按「AI 協助」，引擎以 few-shot prompting 從你的語料取樣，生成符合你語氣的回覆草稿卡；可直接採用、編輯後送出，或用「更正式 / 更簡短」等按鈕微調重生。
- **自動回覆**：每個對話可各自開啟（預設關閉、明確 opt-in）；開啟後對方來訊時 AI 直接以你的語氣生成並送出。
- **採用率記錄**：每次 AI 協助都會記錄草稿與最終送出文字，比對編輯距離判定是否「被採用」；自動回覆的訊息不計入，避免指標灌水。
- **BYOK（自帶金鑰）**：可在設定頁填入個人 Anthropic API key（以 AES-256-GCM 加密存放）；未設定則 fallback 到 `.env` 的開發用 key。

## 技術架構

| 層 | 選型 |
| --- | --- |
| 前端 / 後端 | Next.js 15（App Router）+ React 19 + Tailwind CSS 4 |
| 資料庫 | SQLite（better-sqlite3）+ Drizzle ORM |
| AI 引擎 | Anthropic SDK，模型固定 `claude-haiku-4-5`（草稿短、成本低） |
| 測試 | Vitest + Testing Library |

設計要點：

- **隱私**：全部資料存本機 SQLite，無雲端資料庫；語料只保留使用者本人的發言。
- **引擎與聊天解耦**：草稿引擎（`src/lib/engine`）不碰資料庫，只負責「語料 → prompt → 草稿」；聊天系統透過 API route 呼叫並記錄結果。
- **只做 1 對 1**：無群組即無特殊情況，資料結構與 UI 都因此保持簡單。
- **即時性用輪詢**：Demo 規模下 2 秒輪詢足夠，不引入自架 WebSocket server 的故障面。
- **ORM 用 Drizzle 而非 Prisma**：純 TypeScript、無額外二進位引擎，離線環境可安裝。

## 環境需求

- Node.js **20+**（開發驗證環境：Node 22）
- 適用 Linux / WSL / macOS / Windows

> **WSL 注意**：專案請放在 Linux 檔案系統（如 `~/projects/`），不要放 `/mnt/c/...`，
> 否則 SQLite 與 node_modules 的 I/O 會非常慢；也不要混用 Windows 與 WSL 的 npm，
> 原生模組（better-sqlite3）會因平台不符而損壞。

## 快速開始

```bash
npm install        # 安裝依賴（better-sqlite3 會自動抓預編譯二進位檔）
npm run db:push    # 依 schema 建立 SQLite 資料庫（dev.db）
npm run db:seed    # 寫入 Demo 帳號與示範對話
npm run dev        # http://localhost:3000
```

`.env` 需要：

```bash
DATABASE_FILE=dev.db
APP_SECRET=<隨機長字串，用於 session 與 BYOK 金鑰加密>
ANTHROPIC_API_KEY=sk-ant-...   # 開發用 fallback key；使用者未設個人 key 時使用
```

### Demo 帳號

| 帳號 | 密碼 | 角色 |
| --- | --- | --- |
| `tingyu` | `demo1234` | 賴庭右（本人） |
| `boss` | `demo1234` | 王主管（扮演傳訊者） |

### 其他指令

```bash
npm test           # 單元／元件測試（vitest）
npm run typecheck  # TypeScript 型別檢查
npm run lint       # ESLint
npm run db:reset   # 砍掉 dev.db 重建 + 重新 seed
npm run build      # production build
```

## 專案結構

```
src/app/                    Next.js App Router
  page.tsx                  聊天首頁（session 守門 + 初始資料）
  chat/ChatApp.tsx          聊天 UI：對話列表、訊息、草稿卡、自動回覆開關
  login/  onboarding/       登入頁、首次登入語料匯入引導
  settings/                 設定頁：語料上傳／清單、個人 API key
  api/                      auth / conversations / messages / drafts /
                            corpus / categories 等 REST route
src/lib/
  db/schema.ts              資料結構：users / conversations / messages /
                            styleCategories / styleCorpora+styleSamples /
                            draftSessions / conversationSettings
  engine/                   草稿引擎：語料取樣 → prompt 組裝 → Anthropic 呼叫
  chat/                     聊天邏輯：查詢、草稿流程、自動回覆、編輯距離、輸出防護
  corpus/                   語料與分類管理
  parser/lineParser.ts      LINE 匯出 .txt parser（純函式）
  auth/  crypto.ts          session／密碼雜湊；BYOK 金鑰 AES-256-GCM 加解密
scripts/seed.ts             種子資料
drizzle.config.ts           drizzle-kit 設定
```
