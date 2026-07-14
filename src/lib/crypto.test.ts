import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { encryptSecret, decryptSecret, DEFAULT_APP_SECRETS } from "./crypto";

const GOOD_SECRET = "test-secret-for-unit-tests-only";

beforeAll(() => {
  process.env.APP_SECRET = GOOD_SECRET;
});

afterEach(() => {
  process.env.APP_SECRET = GOOD_SECRET;
});

describe("encryptSecret / decryptSecret", () => {
  it("加密後可還原原文（roundtrip）", () => {
    const key = "sk-ant-api03-example-key";
    expect(decryptSecret(encryptSecret(key, "apikey"), "apikey")).toBe(key);
  });

  it("同一原文每次加密結果不同（隨機 IV）", () => {
    expect(encryptSecret("same", "apikey")).not.toBe(encryptSecret("same", "apikey"));
  });

  it("密文被竄改時解密丟錯（GCM 完整性驗證）", () => {
    const enc = encryptSecret("secret", "apikey");
    const buf = Buffer.from(enc, "base64");
    buf[buf.length - 1] ^= 0xff; // 翻轉最後一個 byte
    expect(() => decryptSecret(buf.toString("base64"), "apikey")).toThrow();
  });

  it("APP_SECRET 缺失時直接丟錯而非靜默失敗", () => {
    delete process.env.APP_SECRET;
    expect(() => encryptSecret("x", "apikey")).toThrow(/APP_SECRET/);
  });

  it("APP_SECRET 過短時丟錯", () => {
    process.env.APP_SECRET = "short";
    expect(() => encryptSecret("x", "apikey")).toThrow(/APP_SECRET/);
  });
});

// 迴歸測試：安全稽核 H-3。
// .env.example 的預設值長度 33 字元，會通過「至少 16 字元」的檢查。若部署時忘了
// 更換，加密金鑰即為 HKDF(公開字串)，任何讀過此 repo 的人都能重算出來 ——
// 可直接偽造任意 userId 的 session、解密所有使用者的 Anthropic key。
describe("APP_SECRET 預設值防護（H-3）", () => {
  it("已知的 .env.example 預設值一律拒絕（即使長度足夠）", () => {
    for (const weak of DEFAULT_APP_SECRETS) {
      expect(weak.length).toBeGreaterThanOrEqual(16); // 證明長度檢查擋不住
      process.env.APP_SECRET = weak;
      expect(() => encryptSecret("x", "apikey")).toThrow(/預設值/);
    }
  });
});

// 迴歸測試：安全稽核 M-1（domain separation）。
// session token 與 users.anthropicApiKeyEnc 原本共用同一把 AES key 且密文格式
// 相同、無型別標籤，兩者可互換。一旦有「設定我的 API key」端點且密文會回傳給
// 使用者，攻擊者即可把偽造的 session payload 當成 key 存入、取回密文、貼進
// cookie → 任意帳號登入（encryption-oracle confused deputy）。
describe("金鑰用途隔離（M-1）", () => {
  it("不同用途以不同子金鑰加密：跨用途解密必定失敗", () => {
    const sessionToken = encryptSecret('{"userId":"victim","exp":9999999999999}', "session");

    // 把 session 密文當成 apikey 解 → GCM 驗證失敗
    expect(() => decryptSecret(sessionToken, "apikey")).toThrow();
  });

  it("以 apikey 子金鑰加密的密文，無法被當作 session 解開（阻斷 oracle 攻擊）", () => {
    const forged = encryptSecret('{"userId":"victim","exp":9999999999999}', "apikey");

    expect(() => decryptSecret(forged, "session")).toThrow();
  });

  it("同用途仍可正常 round-trip", () => {
    const payload = '{"userId":"me","exp":123}';
    expect(decryptSecret(encryptSecret(payload, "session"), "session")).toBe(payload);
  });
});
