// 草稿引擎 — few-shot 檢索（v1 策略）
//
// 依對話對象的 contactLabel 已在上游取得該類型語料後，
// 本模組負責從中挑選 8–15 句作為 prompt few-shot 範例。
//
// 設計決策（見架構文件 §6 檢索策略 v1）：
// - v1 以「隨機取樣」為主，但刻意保留原始語料的『長短分布』——
//   直接純隨機會讓罕見的長訊息被稀釋，模仿出的語氣偏短。
//   故採分層抽樣：依文字長度排序後均分成數個桶，各桶按比例抽樣。
// - 亂數可注入（rng），讓行為在測試中具決定性、線上仍隨機。
// - 純函式、不碰 DB、不修改輸入陣列（專案不可變性鐵律）。

export interface StyleSample {
  text: string;
  sentAt?: number | null;
}

export interface SelectOptions {
  /** 目標句數上限，預設 15（架構文件 §6：8–15 句）。 */
  count?: number;
  /** 長度分層桶數，預設 3（短/中/長）。 */
  buckets?: number;
  /** 可注入亂數來源，預設 Math.random；測試時傳入種子化 RNG。 */
  rng?: () => number;
}

const DEFAULT_COUNT = 15;
const DEFAULT_BUCKETS = 3;

export function selectStyleSamples(
  samples: StyleSample[],
  options: SelectOptions = {}
): StyleSample[] {
  const count = options.count ?? DEFAULT_COUNT;
  const bucketCount = Math.max(1, options.buckets ?? DEFAULT_BUCKETS);
  const rng = options.rng ?? Math.random;

  // 樣本不足上限：全數回傳（回傳複本，維持不可變）。
  if (samples.length <= count) return [...samples];

  // 依文字長度排序（複本，不動原陣列）。
  const sorted = [...samples].sort((a, b) => a.text.length - b.text.length);
  const total = sorted.length;

  const result: StyleSample[] = [];
  let taken = 0;
  for (let b = 0; b < bucketCount; b++) {
    // 以索引均分成長度桶，天然保留長短分布。
    const start = Math.floor((b * total) / bucketCount);
    const end = Math.floor(((b + 1) * total) / bucketCount);
    const bucket = sorted.slice(start, end);

    // 各桶配額依大小佔比分配；最後一桶補足餘數，消除捨入誤差。
    const rawQuota =
      b === bucketCount - 1
        ? count - taken
        : Math.round((count * bucket.length) / total);
    const quota = Math.max(0, Math.min(rawQuota, bucket.length));

    result.push(...shuffle(bucket, rng).slice(0, quota));
    taken += quota;
  }
  return result;
}

// Fisher–Yates 洗牌（操作複本，不修改輸入）。
function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
