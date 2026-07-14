import { describe, it, expect, beforeAll } from "vitest";
import { encryptSecret } from "../crypto";
import { sealSession, openSession, SESSION_TTL_MS } from "./session";

beforeAll(() => {
  process.env.APP_SECRET = "test-secret-for-unit-tests-only";
});

const USER_ID = "user-abc-123";

describe("sealSession / openSession", () => {
  it("封裝後可還原 userId（round-trip）", () => {
    const token = sealSession(USER_ID);
    expect(openSession(token)).toBe(USER_ID);
  });

  it("已過期的 token 回 null", () => {
    const past = Date.now() - SESSION_TTL_MS - 1000;
    const token = sealSession(USER_ID, { now: past });
    expect(openSession(token)).toBeNull();
  });

  it("尚未過期時（以固定 now 判定）回傳 userId", () => {
    const base = 1_000_000_000_000;
    const token = sealSession(USER_ID, { now: base });
    expect(openSession(token, { now: base + 1000 })).toBe(USER_ID);
  });

  it("被竄改的 token 回 null（不丟例外）", () => {
    const token = sealSession(USER_ID);
    const buf = Buffer.from(token, "base64");
    buf[buf.length - 1] ^= 0xff;
    expect(openSession(buf.toString("base64"))).toBeNull();
  });

  it("有效加密但非 session 結構（缺 userId）回 null", () => {
    const bogus = encryptSecret(JSON.stringify({ foo: "bar", exp: Date.now() + 10000 }), "session");
    expect(openSession(bogus)).toBeNull();
  });

  it("垃圾字串回 null", () => {
    expect(openSession("not-a-valid-token")).toBeNull();
    expect(openSession("")).toBeNull();
  });

  it("預設 TTL 為 7 天", () => {
    expect(SESSION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
