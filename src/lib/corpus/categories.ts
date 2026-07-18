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
