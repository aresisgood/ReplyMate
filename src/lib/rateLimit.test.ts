import { describe, it, expect } from "vitest";
import { createRateLimiter } from "./rateLimit";

describe("createRateLimiter（固定視窗）", () => {
  it("視窗內允許到上限，超過即拒絕", () => {
    const rl = createRateLimiter({ limit: 3, windowMs: 1000 });
    expect(rl.check("u1", 0)).toBe(true);
    expect(rl.check("u1", 100)).toBe(true);
    expect(rl.check("u1", 200)).toBe(true);
    expect(rl.check("u1", 300)).toBe(false); // 第 4 次
  });

  it("不同 key 各自獨立計數", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000 });
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("b", 0)).toBe(true); // b 不受 a 影響
    expect(rl.check("a", 0)).toBe(false);
  });

  it("視窗過後計數重置", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000 });
    expect(rl.check("u1", 0)).toBe(true);
    expect(rl.check("u1", 500)).toBe(false); // 同視窗內
    expect(rl.check("u1", 1000)).toBe(true); // 視窗已過，重置
  });

  it("reset() 清空所有計數", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000 });
    expect(rl.check("u1", 0)).toBe(true);
    expect(rl.check("u1", 0)).toBe(false);
    rl.reset();
    expect(rl.check("u1", 0)).toBe(true);
  });
});

describe("release()（歸還額度）", () => {
  // 真實路徑：check() 放行 → 去做事 → 事情失敗 → 把額度還回來。
  it("歸還後可再次通過——用於「已扣額但操作未實際發生」", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000 });
    expect(rl.check("u1", 0)).toBe(true); // 扣額，準備呼叫上游

    rl.release("u1", 50); // 上游失敗，這次沒有真的用掉額度

    expect(rl.check("u1", 100)).toBe(true); // 同一視窗內，但額度已歸還
    expect(rl.check("u1", 150)).toBe(false); // 這次沒還 → 額度確實用盡
  });

  it("不會把計數還成負數（多還無效，不會累積成額外額度）", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000 });
    expect(rl.check("u1", 0)).toBe(true);

    rl.release("u1", 0);
    rl.release("u1", 0); // 多還一次
    rl.release("u1", 0);

    expect(rl.check("u1", 0)).toBe(true);
    expect(rl.check("u1", 0)).toBe(false); // 仍只有 limit=1 的額度
  });

  it("視窗已過時 release 無作用（不影響新視窗的計數）", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000 });
    expect(rl.check("u1", 0)).toBe(true);

    rl.release("u1", 2000); // 視窗早已過期
    expect(rl.check("u1", 2000)).toBe(true); // 新視窗第 1 次
    expect(rl.check("u1", 2000)).toBe(false); // 新視窗第 2 次：擋下
  });

  it("未知 key 的 release 不會建立 bucket", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000 });
    rl.release("never-seen", 0);
    expect(rl.check("never-seen", 0)).toBe(true);
  });
});

describe("key 數量上限（防記憶體耗盡）", () => {
  // 限流 key 來自外部輸入（登入的 username）。若 Map 無上限，攻擊者送出大量
  // 互異 key 就能撐爆記憶體。超過上限時最舊的 key 會被淘汰。
  it("大量互異 key 湧入時，最舊的 key 會被淘汰而非無限成長", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000 });

    expect(rl.check("victim", 0)).toBe(true);
    expect(rl.check("victim", 0)).toBe(false); // 額度已用盡，且仍在視窗內

    // 灌入超過上限（10_000）的互異 key，全都在同一個視窗內
    for (let i = 0; i < 10_001; i++) {
      rl.check(`flood-${i}`, 0);
    }

    // victim 是最早建立的 key，已被淘汰 → 重新取得額度。
    // 限流在被灌爆時退化為盡力而為，但記憶體有界。
    expect(rl.check("victim", 0)).toBe(true);
  });
});
