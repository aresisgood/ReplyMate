// GET /api/conversations — 我的對話列表（含對方名稱與最後預覽）
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/http";
import { listConversations } from "@/lib/chat/queries";

export async function GET(request: NextRequest) {
  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json({ conversations: listConversations(db, auth) });
}
