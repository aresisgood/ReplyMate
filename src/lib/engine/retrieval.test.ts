import { describe, it, expect } from "vitest";
import { selectStyleSamples, type StyleSample } from "./retrieval";

// 決定性 RNG（線性同餘），讓洗牌結果可重現，避免測試 flaky。
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// 產生指定數量、指定文字長度的樣本（以索引後綴確保不重複）。
function makeSamples(count: number, textLen: number, tag = "s"): StyleSample[] {
  return Array.from({ length: count }, (_, i) => {
    const suffix = `#${tag}${i}`;
    return { text: "x".repeat(Math.max(1, textLen - suffix.length)) + suffix };
  });
}

describe("selectStyleSamples", () => {
  it("樣本數不足上限時全數回傳", () => {
    const samples = makeSamples(5, 10);
    const picked = selectStyleSamples(samples, { count: 15 });
    expect(picked).toHaveLength(5);
    expect(new Set(picked.map((s) => s.text))).toEqual(
      new Set(samples.map((s) => s.text))
    );
  });

  it("樣本數超過上限時回傳恰好指定數量", () => {
    const picked = selectStyleSamples(makeSamples(30, 10), { count: 15 });
    expect(picked).toHaveLength(15);
  });

  it("未指定 count 時預設上限為 15", () => {
    expect(selectStyleSamples(makeSamples(30, 10))).toHaveLength(15);
  });

  it("保留長短分布：短句與長句 2:1 時抽樣後仍近似 2:1", () => {
    const short = makeSamples(60, 6, "short");
    const long = makeSamples(30, 60, "long");
    const picked = selectStyleSamples([...short, ...long], {
      count: 15,
      rng: seededRng(1),
    });
    const shortCount = picked.filter((s) => s.text.length < 20).length;
    const longCount = picked.filter((s) => s.text.length >= 20).length;
    expect(shortCount + longCount).toBe(15);
    expect(shortCount).toBe(10);
    expect(longCount).toBe(5);
  });

  it("相同 rng 種子產生相同結果（決定性）", () => {
    const samples = makeSamples(30, 10);
    const a = selectStyleSamples(samples, { count: 15, rng: seededRng(42) });
    const b = selectStyleSamples(samples, { count: 15, rng: seededRng(42) });
    expect(a).toEqual(b);
  });

  it("不修改輸入陣列（不可變）", () => {
    const samples = makeSamples(30, 10);
    const snapshot = samples.map((s) => s.text);
    selectStyleSamples(samples, { count: 15, rng: seededRng(7) });
    expect(samples.map((s) => s.text)).toEqual(snapshot);
  });

  it("回傳樣本皆來自輸入且不重複（無捏造、無複製）", () => {
    const samples = makeSamples(30, 10);
    const inputSet = new Set(samples.map((s) => s.text));
    const picked = selectStyleSamples(samples, { count: 15, rng: seededRng(9) });
    expect(picked.every((s) => inputSet.has(s.text))).toBe(true);
    expect(new Set(picked.map((s) => s.text)).size).toBe(picked.length);
  });

  it("空陣列回傳空陣列", () => {
    expect(selectStyleSamples([])).toEqual([]);
  });
});
