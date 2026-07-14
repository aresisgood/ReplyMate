import { describe, it, expect } from "vitest";
import { normalizedEditDistance, isAdopted, ADOPTION_THRESHOLD } from "./editDistance";

describe("normalizedEditDistance", () => {
  it("完全相同回 0", () => {
    expect(normalizedEditDistance("好的，我今晚處理", "好的，我今晚處理")).toBe(0);
  });

  it("兩者皆空回 0（無差異）", () => {
    expect(normalizedEditDistance("", "")).toBe(0);
  });

  it("一方為空、另一方非空回 1（全改）", () => {
    expect(normalizedEditDistance("", "好的")).toBe(1);
    expect(normalizedEditDistance("好的", "")).toBe(1);
  });

  it("完全不同的等長字串回 1", () => {
    expect(normalizedEditDistance("abcd", "wxyz")).toBe(1);
  });

  it("以 max(len) 正規化：10 字改 1 字 = 0.1", () => {
    expect(normalizedEditDistance("abcdefghij", "abcdefghiX")).toBeCloseTo(0.1, 10);
  });

  it("中文以字元（非 byte）計距離", () => {
    // 10 個中文字改 1 個 → 0.1，若以 UTF-8 byte 計會得到不同結果
    expect(normalizedEditDistance("一二三四五六七八九十", "一二三四五六七八九零")).toBeCloseTo(0.1, 10);
  });

  it("插入與刪除也計入距離", () => {
    expect(normalizedEditDistance("abcde", "abcdef")).toBeCloseTo(1 / 6, 10);
    expect(normalizedEditDistance("abcdef", "abcde")).toBeCloseTo(1 / 6, 10);
  });

  it("對稱：交換參數結果相同", () => {
    const a = "好的，我今晚整理完寄給您";
    const b = "好的，我明早整理完寄給你";
    expect(normalizedEditDistance(a, b)).toBe(normalizedEditDistance(b, a));
  });

  it("結果恆落在 0..1", () => {
    const d = normalizedEditDistance("短", "這是一段長很多的文字內容");
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThanOrEqual(1);
  });
});

describe("isAdopted", () => {
  it("門檻為 0.1（架構 §4.5）", () => {
    expect(ADOPTION_THRESHOLD).toBe(0.1);
  });

  it("原封不動送出 → 採用", () => {
    const draft = "好的，我今晚整理完寄給您";
    expect(isAdopted(draft, draft)).toBe(true);
  });

  it("僅微調標點/一兩字 → 採用（距離 <= 0.1）", () => {
    // 12 字改 1 字 = 0.083 <= 0.1
    expect(isAdopted("好的，我今晚整理完寄給您", "好的，我今晚整理完寄給你")).toBe(true);
  });

  it("恰好等於門檻 0.1 → 採用（含等號）", () => {
    expect(isAdopted("abcdefghij", "abcdefghiX")).toBe(true);
  });

  it("略高於門檻 → 不採用", () => {
    // 10 字改 2 字 = 0.2 > 0.1
    expect(isAdopted("abcdefghij", "abcdefghXY")).toBe(false);
  });

  it("大幅改寫 → 不採用", () => {
    expect(isAdopted("好的，我今晚整理完寄給您", "抱歉這週我沒空，下週再說")).toBe(false);
  });

  it("整段刪掉重寫 → 不採用", () => {
    expect(isAdopted("好的，我今晚整理完寄給您", "OK")).toBe(false);
  });

  it("空草稿與空定稿視為未採用（無意義的採用不計入指標）", () => {
    expect(isAdopted("", "")).toBe(false);
  });

  it("比對前先修剪前後空白（純空白差異仍算採用）", () => {
    expect(isAdopted("好的，我今晚處理", "  好的，我今晚處理  ")).toBe(true);
  });
});