// 採用率判定（成功指標 2 的量測核心，見架構文件 §4.5）
//
// 規則：normalized_edit_distance(aiDraft, finalText) <= 0.1 → adopted。
// 亦即使用者「幾乎原封不動」送出 AI 草稿才算採用；大幅改寫不計。
//
// 實作決策：
// - 以 Unicode 字元（[...str] 展開，非 UTF-16 code unit）計距離。中文一字算一個
//   編輯單位；若用 .length 會把 emoji 之類的代理對算成兩個，扭曲比例。
// - 正規化除以 max(len)，讓結果恆落在 0..1 且對稱。
// - Levenshtein 用滾動陣列，空間 O(min(m,n))。草稿 <= 300 tokens，效能無虞。

export const ADOPTION_THRESHOLD = 0.1;

// Levenshtein 距離（插入/刪除/替換各計 1）。
function levenshtein(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // 讓 b 為較短的一方，滾動陣列長度取 min
  if (b.length > a.length) [a, b] = [b, a];

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = current[j - 1] + 1;
      const deletion = previous[j] + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    previous = current;
  }

  return previous[b.length];
}

// 正規化編輯距離，0（完全相同）～ 1（完全不同）。
export function normalizedEditDistance(a: string, b: string): number {
  const charsA = [...a];
  const charsB = [...b];

  const longest = Math.max(charsA.length, charsB.length);
  if (longest === 0) return 0; // 兩者皆空 → 無差異

  return levenshtein(charsA, charsB) / longest;
}

// 使用者是否「採用」了 AI 草稿。
// 比對前修剪前後空白——純空白差異不代表使用者改寫了內容。
export function isAdopted(aiDraft: string, finalText: string): boolean {
  const draft = aiDraft.trim();
  const final = finalText.trim();

  // 兩者皆空：沒有實質內容，不計為採用（避免灌水指標）
  if (!draft || !final) return false;

  return normalizedEditDistance(draft, final) <= ADOPTION_THRESHOLD;
}