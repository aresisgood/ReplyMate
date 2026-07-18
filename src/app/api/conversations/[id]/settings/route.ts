// PUT /api/conversations/:id/settings — 更新此對話的 autoReply 與/或
// styleCategoryId（架構 §4.2b、ADR #7）。兩者皆選填，但至少須提供一項。
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, mapChatError } from "@/lib/http";
import { assertParticipant } from "@/lib/chat/queries";
import { setAutoReply, setStyleCategoryId } from "@/lib/chat/settings";

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

  const raw = (body ?? {}) as { autoReply?: unknown; styleCategoryId?: unknown };
  const hasAutoReply = "autoReply" in raw;
  const hasCategory = "styleCategoryId" in raw;
  if (!hasAutoReply && !hasCategory) {
    return NextResponse.json(
      { error: "至少需要 autoReply 或 styleCategoryId" },
      { status: 400 }
    );
  }
  if (hasAutoReply && typeof raw.autoReply !== "boolean") {
    return NextResponse.json({ error: "autoReply 必須是布林值" }, { status: 400 });
  }
  if (hasCategory && raw.styleCategoryId !== null && typeof raw.styleCategoryId !== "string") {
    return NextResponse.json(
      { error: "styleCategoryId 必須是字串或 null" },
      { status: 400 }
    );
  }

  try {
    const result: { autoReply?: boolean; styleCategoryId?: string | null } = {};
    if (hasAutoReply) {
      result.autoReply = setAutoReply(db, userId, id, raw.autoReply as boolean);
    }
    if (hasCategory) {
      const categoryId = raw.styleCategoryId as string | null;
      setStyleCategoryId(db, userId, id, categoryId);
      result.styleCategoryId = categoryId;
    }
    return NextResponse.json(result);
  } catch (e) {
    return mapChatError(e, "PUT settings");
  }
}
