// readJsonWithLimit：在讀取 body 之前/期間就把大小卡死的邊界測試。
// 重點不只是「回 413」，而是「超量的位元組不會被讀進記憶體」——
// 故同時驗證宣告的 content-length 與實際串流長度兩條防線。
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { PayloadTooLargeError, readJsonWithLimit } from "./http";

const LIMIT = 1024; // 測試用小上限

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// 沒有 content-length 的串流請求（chunked）——攻擊者可藉此繞過標頭檢查。
function streamRequest(chunks: string[]): NextRequest {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return new NextRequest("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    duplex: "half", // undici 對串流 body 的要求
  });
}

describe("readJsonWithLimit", () => {
  it("小於上限：正常解析出 JSON", async () => {
    const body = await readJsonWithLimit(jsonRequest({ hello: "世界" }), LIMIT);
    expect(body).toEqual({ hello: "世界" });
  });

  it("content-length 宣告超過上限：拋 PayloadTooLargeError", async () => {
    const request = jsonRequest({ blob: "a".repeat(LIMIT * 2) });
    await expect(readJsonWithLimit(request, LIMIT)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("無 content-length 的串流 body 超過上限：讀到超量即中止並拋錯", async () => {
    // 每塊 400 bytes，第三塊起就超過 1024 上限
    const request = streamRequest(['{"blob":"', "a".repeat(400), "a".repeat(400), "a".repeat(400)]);
    await expect(readJsonWithLimit(request, LIMIT)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("以位元組而非字元計量：中文字（UTF-8 3 bytes）不會低估體積", async () => {
    // 500 個中文字 = 1500 bytes > 1024 上限，但字元數只有 500
    const request = streamRequest(['{"blob":"', "字".repeat(500), '"}']);
    await expect(readJsonWithLimit(request, LIMIT)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("body 不是合法 JSON：拋 SyntaxError（由呼叫端映射為 400）", async () => {
    const request = streamRequest(["not json"]);
    await expect(readJsonWithLimit(request, LIMIT)).rejects.toBeInstanceOf(SyntaxError);
  });
});
