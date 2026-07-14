// /api/conversations/:id/messages — 訊息增量查詢（輪詢）與送出
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, mapChatError, afterResponse } from "@/lib/http";
import { assertParticipant, getMessagesAfter, postMessage } from "@/lib/chat/queries";
import { maybeAutoReply } from "@/lib/chat/autoReply";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: RouteContext) {
  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;
  const userId = auth;

  const { id } = await params;
  try {
    assertParticipant(db, id, userId);
  } catch (e) {
    return mapChatError(e, "GET messages");
  }

  const afterParam = request.nextUrl.searchParams.get("after");
  let afterMs: number | undefined;
  if (afterParam !== null) {
    afterMs = Number(afterParam);
    if (!Number.isFinite(afterMs)) {
      return NextResponse.json({ error: "after 參數必須是毫秒時間戳" }, { status: 400 });
    }
  }

  return NextResponse.json({ messages: getMessagesAfter(db, id, afterMs) });
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;
  const userId = auth;

  const { id } = await params;
  let conversation;
  try {
    conversation = assertParticipant(db, id, userId);
  } catch (e) {
    return mapChatError(e, "POST messages");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "請求格式錯誤" }, { status: 400 });
  }

  // 只做 route 邊界該做的型別檢查；「不可為空」與長度上限由 postMessage 統一
  // 把關（它是所有寫入路徑的共同入口，包括 autoReply 與 finalizeDraft），
  // 在此重複一份只會讓兩邊有機會分歧。
  const { text } = (body ?? {}) as { text?: unknown };
  if (typeof text !== "string") {
    return NextResponse.json({ error: "訊息不可為空" }, { status: 400 });
  }

  let message;
  try {
    message = postMessage(db, id, userId, text);
  } catch (e) {
    return mapChatError(e, "POST messages");
  }

  // F4 自動回覆：若「收訊方」對此對話開啟了 autoReply，以其身分生成並送出回覆。
  // LLM 呼叫需數秒，送訊者不該為此被阻塞，故移到回應之後執行（見 afterResponse）。
  const recipientId =
    conversation.userAId === userId ? conversation.userBId : conversation.userAId;

  afterResponse(
    maybeAutoReply(db, {
      conversationId: id,
      incomingMessageId: message.id,
      recipientId,
      envFallback: process.env.ANTHROPIC_API_KEY,
    }),
    "POST messages / autoReply"
  );

  return NextResponse.json({ message }, { status: 201 });
}
