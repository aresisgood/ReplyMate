// 聊天時間軸的純邏輯（輪詢游標與訊息合併），與 React 無關以便單元測試。
//
// 游標語意（關鍵）：游標代表「已從伺服器**查詢**到的最新訊息時間」，
// 而非「畫面上最新訊息的時間」。兩者不同 —— 自己送出的訊息會透過 POST 回應
// 直接併入畫面，若讓它推進游標，就會跳過「上次輪詢後、我送出前」抵達但尚未
// 被輪詢到的對方訊息，該訊息之後永遠拉不回來（游標只增不減）。
// 因此游標只由 fetch/輪詢的結果推進，送出訊息不動它 —— 下一次輪詢會連同自己
// 的訊息一起撈回，再由 mergeById 依 id 去重。

export interface TimelineMessage {
  id: string;
  conversationId: string;
  senderId: string;
  text: string;
  createdAtMs: number;
}

// 併入新訊息：依 id 去重、依時間升冪排序，不修改輸入陣列。
export function mergeById(
  existing: readonly TimelineMessage[],
  incoming: readonly TimelineMessage[]
): TimelineMessage[] {
  if (incoming.length === 0) return [...existing];

  const seen = new Set(existing.map((m) => m.id));
  const fresh = incoming.filter((m) => !seen.has(m.id));
  if (fresh.length === 0) return [...existing];

  return [...existing, ...fresh].sort((a, b) => a.createdAtMs - b.createdAtMs);
}

// 依「伺服器查詢結果」推進游標；單調遞增，不會被較舊的訊息拉回。
export function advanceCursor(
  current: number | undefined,
  fetched: readonly TimelineMessage[]
): number | undefined {
  if (fetched.length === 0) return current;

  const newest = fetched.reduce((max, m) => Math.max(max, m.createdAtMs), -Infinity);
  return current === undefined ? newest : Math.max(current, newest);
}