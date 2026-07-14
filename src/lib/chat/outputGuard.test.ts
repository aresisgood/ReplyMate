import { describe, it, expect } from "vitest";
import { containsStyleLeak, MAX_AUTO_REPLY_LENGTH, isSafeAutoReply } from "./outputGuard";

const SAMPLES = [
  "好的，我今晚整理完寄給您",
  "這個需求我想分兩階段：先做核心流程，報表之後補",
  "辛苦了，明天見",
];

describe("containsStyleLeak", () => {
  it("正常回覆（未逐字重現語料）不算外洩", () => {
    expect(containsStyleLeak("好，我看一下再回你", SAMPLES)).toBe(false);
  });

  it("整句逐字重現某個語料 → 判定外洩", () => {
    expect(containsStyleLeak("好的，我今晚整理完寄給您", SAMPLES)).toBe(true);
  });

  it("把語料夾在其他文字中一起吐出 → 判定外洩", () => {
    const dump = "當然可以，例如：這個需求我想分兩階段：先做核心流程，報表之後補";
    expect(containsStyleLeak(dump, SAMPLES)).toBe(true);
  });

  it("重現長語料的一大段（連續 20+ 字）→ 判定外洩", () => {
    // 含語料前 20 字的連續片段（未含整句），測滑動視窗那條路
    const partial = "這個需求我想分兩階段：先做核心流程，報表怎麼呈現我再想";
    expect(containsStyleLeak(partial, SAMPLES)).toBe(true);
  });

  it("與語料只有短偶合（未達門檻）不算外洩", () => {
    // 「明天見」只有 3 字，屬正常用語，不應誤判
    expect(containsStyleLeak("那就明天見囉", SAMPLES)).toBe(false);
  });

  it("空語料時一律不外洩（無可洩露之物）", () => {
    expect(containsStyleLeak("任何內容", [])).toBe(false);
  });
});

describe("isSafeAutoReply", () => {
  it("正常長度且無外洩 → 安全", () => {
    expect(isSafeAutoReply("好，我看一下再回你", SAMPLES)).toBe(true);
  });

  it("外洩語料 → 不安全", () => {
    // 用夠長且獨特的語料——短的通用語（如「明天見」）刻意不判外洩以免誤傷正常回覆
    expect(isSafeAutoReply("好的，我今晚整理完寄給您", SAMPLES)).toBe(false);
  });

  it("超過長度上限 → 不安全（異常長輸出多為被操縱）", () => {
    const long = "好".repeat(MAX_AUTO_REPLY_LENGTH + 1);
    expect(isSafeAutoReply(long, SAMPLES)).toBe(false);
  });

  it("空白輸出 → 不安全", () => {
    expect(isSafeAutoReply("   ", SAMPLES)).toBe(false);
  });
});
