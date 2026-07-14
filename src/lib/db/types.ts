// 純型別模組——不建立連線。查詢層 helper 與測試工廠共用此型別，
// 避免匯入 db/index.ts（會開啟 dev.db 連線）。
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "./schema";

export type AppDatabase = BetterSQLite3Database<typeof schema>;
