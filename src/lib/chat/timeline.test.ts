import { describe, it, expect } from "vitest";
import { advanceCursor, mergeById, type TimelineMessage } from "./timeline";

function msg(id: string, createdAtMs: number): TimelineMessage {
  return { id, conversationId: "c1", senderId: "u1", text: id, createdAtMs };
}

describe("mergeById", () => {
  it("依 id 去重，重複的 incoming 不會產生第二筆", () => {
    const existing = [msg("a", 100), msg("b", 200)];
    const merged = mergeById(existing, [msg("b", 200), msg("c", 300)]);
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("合併後依 createdAtMs 升冪排序", () => {
    const merged = mergeById([msg("b", 200)], [msg("a", 100), msg("c", 300)]);
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("不修改輸入陣列（不可變）", () => {
    const existing = [msg("a", 100)];
    mergeById(existing, [msg("b", 200)]);
    expect(existing).toHaveLength(1);
  });
});

describe("advanceCursor", () => {
  it("初次載入：游標取已抓取訊息的最大時間", () => {
    expect(advanceCursor(undefined, [msg("a", 100), msg("b", 300)])).toBe(300);
  });

  it("沒有新訊息時游標不動", () => {
    expect(advanceCursor(300, [])).toBe(300);
    expect(advanceCursor(undefined, [])).toBeUndefined();
  });

  it("游標單調遞增，不會被較舊的訊息拉回", () => {
    expect(advanceCursor(300, [msg("old", 100)])).toBe(300);
  });

  // 迴歸測試：本次修復的核心缺陷。
  // 舊實作把游標同步為「畫面上最後一則訊息」的時間，而自己送出的訊息會透過
  // POST 回應直接併入畫面 —— 游標因此跳過了「上次輪詢後、我送出前」抵達但
  // 尚未輪詢到的對方訊息，該訊息之後永遠不會再被拉回。
  it("自己送出的訊息不得推進游標，否則會跳過尚未輪詢到的對方訊息", () => {
    // t=0：初次載入，只有一則舊訊息
    let messages = [msg("old", 0)];
    let cursor = advanceCursor(undefined, messages);
    expect(cursor).toBe(0);

    // t=500：對方送出訊息 M（此時輪詢尚未跑）
    const incomingFromCounterpart = msg("M", 500);

    // t=1000：我送出訊息 S，POST 回應直接併入畫面（樂觀更新）
    const sent = msg("S", 1000);
    messages = mergeById(messages, [sent]);
    // 關鍵：送出不推進游標（游標只由伺服器輪詢結果推進）
    expect(cursor).toBe(0);

    // t=2000：輪詢 ?after=0 → 伺服器回傳 M 與 S
    const polled = [incomingFromCounterpart, sent].filter((m) => m.createdAtMs > cursor!);
    messages = mergeById(messages, polled);
    cursor = advanceCursor(cursor, polled);

    // 對方的訊息必須出現在畫面上，且不能有重複的 S
    expect(messages.map((m) => m.id)).toEqual(["old", "M", "S"]);
    expect(cursor).toBe(1000);
  });
});