// 機密欄位加解密（用途：session token、users.anthropicApiKeyEnc）
//
// 演算法：AES-256-GCM（附帶完整性驗證，被竄改的密文解密會直接丟錯）
// 密文格式：base64( iv[12] ‖ authTag[16] ‖ ciphertext )
//
// 金鑰派生（安全稽核 M-1 / H-3 後強化）：
// - 以 HKDF-SHA256 從 APP_SECRET 派生**每個用途各自獨立**的子金鑰。
//   原本 session token 與 API key 共用同一把 key 且密文格式相同、無型別標籤，
//   兩者可互換：一旦有「設定我的 API key」端點且密文會回傳給使用者，攻擊者就能
//   把偽造的 session payload 當成 key 存入、取回密文、貼進 cookie → 任意帳號
//   登入（encryption-oracle confused deputy）。domain separation 直接斷掉這條路。
// - 拒絕 .env.example 的已知預設值：其長度足以通過「至少 16 字元」檢查，若部署
//   時忘了換，金鑰就是任何人都能重算的公開值。

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32; // AES-256

/** 金鑰用途——各自派生獨立子金鑰，密文不可跨用途互換。 */
export type CryptoDomain = "session" | "apikey";

/** .env.example 中的預設值，一律拒絕（見上方說明）。 */
export const DEFAULT_APP_SECRETS = ["change-me-to-a-long-random-string"] as const;

// HKDF 的 salt 為固定常數：APP_SECRET 本身即為高熵祕密，salt 在此只作為
// 派生的定義域參數，不需保密也不需隨機。
const HKDF_SALT = "replymate/v1";

// 派生成本雖低，仍每次請求都會用到——依 (secret, domain) 快取。
const keyCache = new Map<string, Buffer>();

function deriveKey(domain: CryptoDomain): Buffer {
  const secret = process.env.APP_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("APP_SECRET 未設定或過短（至少 16 字元），請檢查 .env");
  }
  if ((DEFAULT_APP_SECRETS as readonly string[]).includes(secret)) {
    throw new Error(
      "APP_SECRET 仍是 .env.example 的預設值，請改成高熵隨機字串（例如 openssl rand -base64 32）"
    );
  }

  const cacheKey = `${domain}:${secret}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  const key = Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, domain, KEY_LENGTH));
  keyCache.set(cacheKey, key);
  return key;
}

export function encryptSecret(plaintext: string, domain: CryptoDomain): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(domain), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function decryptSecret(encoded: string, domain: CryptoDomain): string {
  const buf = Buffer.from(encoded, "base64");
  if (buf.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error("密文格式不正確");
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv("aes-256-gcm", deriveKey(domain), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
