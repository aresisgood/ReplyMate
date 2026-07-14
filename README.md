# ReplyMate

內建 AI 代筆的 1 對 1 訊息軟體 — 讓休息真正成為休息。
（AIPE03 專案 · 8 週課堂 Demo · 規劃 v2「B 路線：自建聊天」）

## 環境需求

- Node.js **20+**（開發驗證環境：Node 22）
- 適用 **Linux / WSL**（macOS 亦可）；指令皆為通用 Bash，無需 sudo

> **WSL 注意**：專案請放在 Linux 檔案系統（如 `~/projects/`），
> 不要放 `/mnt/c/...`，否則 SQLite 與 node_modules 的 I/O 會非常慢。

## 快速開始（Linux / WSL）

```bash
npm install        # 安裝依賴（better-sqlite3 會自動抓預編譯二進位檔）
npm run db:push    # 依 schema 建立 SQLite 資料庫（dev.db）
npm run db:seed    # 寫入 Demo 帳號與示範對話
npm run dev        # http://localhost:3000
```

首頁會顯示資料層自檢（使用者 2 位 / 訊息 5 則 / 風格語料 6 句 = 一切正常）。

### Demo 帳號

| 帳號       | 密碼         | 角色                 |
| ---------- | ------------ | -------------------- |
| `tingyu` | `demo1234` | 賴庭右（本人）       |
| `boss`   | `demo1234` | 王主管（扮演傳訊者） |

### 其他指令

```bash
npm test           # parser 單元測試（vitest）
npm run db:reset   # 砍掉 dev.db 重建 + 重新 seed
npm run build      # production build
```

## 專案結構

```
src/lib/db/schema.ts        資料結構（5 實體：users / conversations / messages /
                            styleCorpora+styleSamples / draftSessions）
src/lib/db/index.ts         Drizzle + better-sqlite3 單例
src/lib/parser/lineParser.ts   LINE 匯出 .txt parser（純函式）
src/lib/parser/lineParser.test.ts
scripts/seed.ts             種子資料
src/app/                    Next.js App Router（Week 1 為佔位首頁）
drizzle.config.ts           drizzle-kit 設定
.env                        DATABASE_FILE；Week 2 起需加 ANTHROPIC_API_KEY
```

## 技術選型備註

- **ORM 用 Drizzle 而非 Prisma**：純 TypeScript、無 Rust 引擎二進位下載、
  離線環境可安裝，少一個部署故障點。schema 語意與原規劃完全一致。
- **即時訊息（Week 4）先用 2 秒輪詢**：Demo 規模下輪詢足夠，
  不引入自架 WebSocket server 的故障面。
- **隱私（brief 約束 3）**：全部資料存本機 SQLite，無雲端資料庫。

## 8 週進度對照

- [X] **W1** 骨架 + schema + LINE parser + 種子帳號 ← 本版
- [ ] **W2–3** 草稿引擎（few-shot 風格模仿 + prompt 調校）
- [ ] **W4** 最小聊天：登入、對話列表、收發（輪詢）
- [ ] **W5** 引擎接入聊天 UI（AI 協助鈕 → 草稿卡片 → 編輯 → 送出）
- [ ] **W6** 語氣微調 + 採用率儀表板 + 語料上傳 UI
- [ ] **W7** 同學實測（+ stretch：盲測模式）
- [ ] **W8** 緩衝 + Demo 打磨
