// 簡易固定視窗限流器（安全稽核 H-2）
//
// 單機 Demo 規模用 in-memory Map 即足夠：付費 LLM 端點與登入需擋濫用/爆破。
// now 可注入以測視窗邊界；正式環境跨多實例才需改用 Redis 之類的共享儲存。

export interface RateLimiterOptions {
  limit: number; // 每視窗允許次數
  windowMs: number; // 視窗長度（毫秒）
}

export interface RateLimiter {
  /** 記一次並回傳是否允許（未超過上限）。 */
  check(key: string, now?: number): boolean;
  /** 歸還一次額度——用於「已扣額但該次操作未實際發生」（例如上游呼叫失敗）。 */
  release(key: string, now?: number): void;
  reset(): void;
}

// key 數量硬上限。限流的 key 來自外部輸入（登入用的 username），若無上限，
// 攻擊者送出大量互異的 key 就能讓這個 Map 無限成長 → 記憶體耗盡。
const MAX_KEYS = 10_000;

export function createRateLimiter({ limit, windowMs }: RateLimiterOptions): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  // 只在要新增 key 時做，攤提成本；不需要背景 timer。
  function makeRoom(now: number): void {
    if (buckets.size < MAX_KEYS) return;

    for (const [key, bucket] of buckets) {
      if (now >= bucket.resetAt) buckets.delete(key);
    }

    // 全部都還在視窗內（正被灌爆）：淘汰最舊的 key。Map 保有插入順序，
    // 故 keys() 的第一個即最早建立者。此時限流已退化為盡力而為——寧可
    // 放過個別請求，也不能讓記憶體無界成長。
    while (buckets.size >= MAX_KEYS) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
  }

  return {
    check(key, now = Date.now()) {
      const bucket = buckets.get(key);
      if (!bucket || now >= bucket.resetAt) {
        makeRoom(now);
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      // 不可變性：以新物件取代既有 bucket，不就地遞增（coding-style 鐵律）
      const nextCount = bucket.count + 1;
      buckets.set(key, { count: nextCount, resetAt: bucket.resetAt });
      return nextCount <= limit;
    },
    release(key, now = Date.now()) {
      const bucket = buckets.get(key);
      if (!bucket || now >= bucket.resetAt) return; // 視窗已過，無額度可還

      const nextCount = bucket.count - 1;
      if (nextCount <= 0) {
        buckets.delete(key);
        return;
      }
      buckets.set(key, { count: nextCount, resetAt: bucket.resetAt });
    },
    reset() {
      buckets.clear();
    },
  };
}

// 全域限流器實例（各端點共用；測試以 resetRateLimiters 清空）
export const draftRateLimiter = createRateLimiter({ limit: 5, windowMs: 60_000 });
export const autoReplyRateLimiter = createRateLimiter({ limit: 1, windowMs: 10_000 });

// 登入採雙層限流：
// - 依帳號：擋單一帳號的密碼爆破。成功登入會歸還額度，正常使用者不會因為
//   自己頻繁登入而被鎖；但這仍讓知道帳號的人能持續打錯密碼把該帳號擋住，
//   這是「防爆破」無可避免的取捨。
// - 依來源 IP：擋「輪換大量帳號」的密碼噴灑——那種攻擊每個帳號只試一兩次，
//   永遠碰不到帳號層的上限，只有 IP 層攔得住。
export const loginRateLimiter = createRateLimiter({ limit: 5, windowMs: 60_000 });
export const loginIpRateLimiter = createRateLimiter({ limit: 20, windowMs: 60_000 });

export function resetRateLimiters(): void {
  draftRateLimiter.reset();
  loginRateLimiter.reset();
  loginIpRateLimiter.reset();
  autoReplyRateLimiter.reset();
}
