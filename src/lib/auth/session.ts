// Session token 封裝（無狀態 cookie session，見架構文件 §5/§8）
//
// 決策（ADR 對齊 crypto 復用）：session 不落 DB，直接把 { userId, exp } 以
// AES-256-GCM 封裝成 httpOnly cookie 值。竄改/過期都無法通過解密或 exp 檢查。
// 復用已測的 crypto.ts，零新依賴。

import { decryptSecret, encryptSecret } from "../crypto";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

interface SessionPayload {
  userId: string;
  exp: number; // 過期時間（epoch ms）
}

export function sealSession(
  userId: string,
  opts: { ttlMs?: number; now?: number } = {}
): string {
  const now = opts.now ?? Date.now();
  const exp = now + (opts.ttlMs ?? SESSION_TTL_MS);
  return encryptSecret(JSON.stringify({ userId, exp } satisfies SessionPayload), "session");
}

// 回傳 userId，或在竄改/過期/格式不符時回 null。
// 註：此處捕捉解密例外並回 null 是刻意的邊界處理——無效/過期 cookie 是正常
// 情境（未登入、cookie 過期、竄改），應視為「未驗證」而非拋錯中斷請求。
export function openSession(token: string, opts: { now?: number } = {}): string | null {
  const now = opts.now ?? Date.now();
  try {
    const payload = JSON.parse(decryptSecret(token, "session")) as unknown;
    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof (payload as SessionPayload).userId !== "string" ||
      typeof (payload as SessionPayload).exp !== "number"
    ) {
      return null;
    }
    const { userId, exp } = payload as SessionPayload;
    if (exp <= now) return null;
    return userId;
  } catch {
    return null;
  }
}
