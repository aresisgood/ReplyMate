// PUT /api/conversations/:id/settings — 切換此對話的 autoReply（架構 §4.2b、ADR #7）
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, mapChatError } from "@/lib/http";
import { assertParticipant } from "@/lib/chat/queries";
import { setAutoReply } from "@/lib/chat/settings";

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, { params }: RouteContext) {
  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;
  const userId = auth;

  const { id } = await params;
  try {
    assertParticipant(db, id, userId);
  } catch (e) {
    return mapChatError(e, "PUT settings");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "請求格式錯誤" }, { status: 400 });
  }

  const { autoReply } = (body ?? {}) as { autoReply?: unknown };
  if (typeof autoReply !== "boolean") {
    return NextResponse.json({ error: "autoReply 必須是布林值" }, { status: 400 });
  }

  return NextResponse.json({ autoReply: setAutoReply(db, userId, id, autoReply) });
}
