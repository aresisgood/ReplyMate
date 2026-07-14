// Drizzle + better-sqlite3 單例（避免 Next.js dev 熱重載時重複開啟連線）
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

const DB_FILE = process.env.DATABASE_FILE ?? "dev.db";

const globalForDb = globalThis as unknown as {
  db?: BetterSQLite3Database<typeof schema>;
};

function createDb() {
  const sqlite = new Database(DB_FILE);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

export const db = globalForDb.db ?? createDb();

if (process.env.NODE_ENV !== "production") globalForDb.db = db;

export * as tables from "./schema";
