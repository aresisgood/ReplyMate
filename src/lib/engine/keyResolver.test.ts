import { describe, it, expect, beforeAll } from "vitest";
import { encryptSecret } from "../crypto";
import { resolveApiKey } from "./keyResolver";

beforeAll(() => {
  process.env.APP_SECRET = "test-secret-for-unit-tests-only";
});

const USER_KEY = "sk-ant-user-personal-key";
const ENV_KEY = "sk-ant-env-fallback-key";

describe("resolveApiKey (BYOK)", () => {
  it("使用者有個人 key 時解密並回傳，來源標記為 user", () => {
    const resolved = resolveApiKey({
      encryptedUserKey: encryptSecret(USER_KEY, "apikey"),
      envFallback: ENV_KEY,
    });
    expect(resolved).toEqual({ key: USER_KEY, source: "user" });
  });

  it("使用者無 key 時 fallback 到 env key，來源標記為 env", () => {
    const resolved = resolveApiKey({ encryptedUserKey: null, envFallback: ENV_KEY });
    expect(resolved).toEqual({ key: ENV_KEY, source: "env" });
  });

  it("使用者 key 優先於 env key", () => {
    const resolved = resolveApiKey({
      encryptedUserKey: encryptSecret(USER_KEY, "apikey"),
      envFallback: ENV_KEY,
    });
    expect(resolved.source).toBe("user");
  });

  it("空字串的使用者 key 視為未設定，fallback 到 env", () => {
    const resolved = resolveApiKey({ encryptedUserKey: "", envFallback: ENV_KEY });
    expect(resolved).toEqual({ key: ENV_KEY, source: "env" });
  });

  it("使用者與 env 皆無 key 時丟出錯誤", () => {
    expect(() => resolveApiKey({ encryptedUserKey: null, envFallback: null })).toThrow();
  });

  it("被竄改的使用者密文丟錯，不靜默 fallback 到 env（安全）", () => {
    const enc = encryptSecret(USER_KEY, "apikey");
    const buf = Buffer.from(enc, "base64");
    buf[buf.length - 1] ^= 0xff;
    expect(() =>
      resolveApiKey({ encryptedUserKey: buf.toString("base64"), envFallback: ENV_KEY })
    ).toThrow();
  });
});
