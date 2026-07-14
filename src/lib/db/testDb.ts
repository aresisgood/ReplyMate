// 測試專用 DB 工廠：in-memory SQLite + 套用 drizzle migration。
// 僅供 *.test.ts 匯入（不進 app bundle）。查詢層 helper 接受注入的 db，
// 因此可對隔離的記憶體資料庫測試，不污染 dev.db。

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";
import type { AppDatabase } from "./types";

export function createTestDb(): AppDatabase {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  return db;
}
