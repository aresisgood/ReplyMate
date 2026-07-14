// 草稿引擎 — BYOK API key 解析（見架構文件 §6/§8，ADR #8）
//
// 解析順序：使用者個人 key（AES-256-GCM 解密）?? .env 開發用 fallback key。
// 費用歸給使用者（brief 約束 2）；金鑰只在 server 端解密使用，永不進前端。
//
// 安全決策：被竄改的使用者密文會讓 decryptSecret 丟錯（GCM 完整性驗證），
// 此處刻意「不」捕捉後靜默 fallback 到 env——竄改應大聲失敗，避免以未預期
// 的金鑰計費，也避免掩蓋潛在攻擊。

import { decryptSecret } from "../crypto";

export type ApiKeySource = "user" | "env";

export interface ResolvedKey {
  key: string;
  source: ApiKeySource;
}

export interface ResolveApiKeyParams {
  /** users.anthropicApiKeyEnc；null/空字串代表未設定。 */
  encryptedUserKey?: string | null;
  /** .env 的 ANTHROPIC_API_KEY，由呼叫端傳入以維持純函式可測。 */
  envFallback?: string | null;
}

export function resolveApiKey({
  encryptedUserKey,
  envFallback,
}: ResolveApiKeyParams): ResolvedKey {
  if (encryptedUserKey) {
    // 竄改/損毀時直接丟錯（見上方安全決策）。
    return { key: decryptSecret(encryptedUserKey, "apikey"), source: "user" };
  }

  if (envFallback) {
    return { key: envFallback, source: "env" };
  }

  throw new Error("找不到可用的 Anthropic API key（未設定個人 key，且無 .env fallback）");
}
