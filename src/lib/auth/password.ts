// 帳密驗證（bcrypt 比對，見架構文件 §8）
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { users } from "../db/schema";
import type { AppDatabase } from "../db/types";

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
}

// 帳號不存在時，仍對一段固定雜湊做一次 compare，讓「查無帳號」與「密碼錯誤」
// 的回應時間相近，降低帳號列舉（user enumeration）的時間側信道。
//
// 必須是「合法」的 bcrypt hash：格式不合法時 bcrypt 會跳過雜湊運算直接回 false
// （~0.15ms vs ~54ms），時間差反而讓帳號列舉更容易。cost 與 scripts/seed.ts 的
// 10 一致，兩條路徑的運算量才會相當。原文是丟棄的隨機字串，永遠比對不中。
export const DUMMY_HASH = "$2b$10$qIo/8Ge.8IkJDjnV3oMFK.Wp1bGhDBXZwlzSedOUgwSRI7QrYixp2";

export async function verifyCredentials(
  db: AppDatabase,
  username: string,
  password: string
): Promise<AuthUser | null> {
  const user = db.select().from(users).where(eq(users.username, username)).get();

  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH).catch(() => false);
    return null;
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return null;

  return { id: user.id, username: user.username, displayName: user.displayName };
}
