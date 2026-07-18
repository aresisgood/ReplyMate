// PUT /api/categories/:id — 重新命名自訂分類
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, mapChatError } from "@/lib/http";
import { renameCategory } from "@/lib/corpus/categories";
import { categoryRateLimiter } from "@/lib/rateLimit";

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, { params }: RouteContext) {
  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;

  // 與 POST /api/categories 共用限流器（皆為分類寫入），且在 ownership 查找前生效
  if (!categoryRateLimiter.check(auth)) {
    return NextResponse.json({ error: "操作過於頻繁，請稍後再試" }, { status: 429 });
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "請求格式錯誤" }, { status: 400 });
  }
  const { name } = (body ?? {}) as { name?: unknown };
  if (typeof name !== "string") {
    return NextResponse.json({ error: "缺少 name" }, { status: 400 });
  }
  try {
    return NextResponse.json(renameCategory(db, auth, id, name));
  } catch (e) {
    return mapChatError(e, "PUT categories/[id]");
  }
}
