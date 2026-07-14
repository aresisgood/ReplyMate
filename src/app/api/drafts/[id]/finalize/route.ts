// POST /api/drafts/:id/finalize — { finalText } → 判定 adopted、送出訊息（架構 §4.5）
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, mapChatError } from "@/lib/http";
import { finalizeDraft } from "@/lib/chat/drafts";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: RouteContext) {
  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;
  const userId = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "請求格式錯誤" }, { status: 400 });
  }

  const { finalText } = (body ?? {}) as { finalText?: unknown };
  if (typeof finalText !== "string") {
    return NextResponse.json({ error: "缺少 finalText" }, { status: 400 });
  }

  const { id } = await params;

  try {
    const { message, adopted } = finalizeDraft(db, { draftId: id, userId, finalText });
    return NextResponse.json({ message, adopted }, { status: 201 });
  } catch (e) {
    return mapChatError(e, "POST finalize");
  }
}
