// GET /api/categories — 本人分類清單；POST — 建立自訂分類
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, mapChatError } from "@/lib/http";
import { createCategory, listCategories } from "@/lib/corpus/categories";
import { categoryRateLimiter } from "@/lib/rateLimit";

export async function GET(request: NextRequest) {
  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json({ categories: listCategories(db, auth) });
}

export async function POST(request: NextRequest) {
  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;

  if (!categoryRateLimiter.check(auth)) {
    return NextResponse.json({ error: "操作過於頻繁，請稍後再試" }, { status: 429 });
  }

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
    return NextResponse.json(createCategory(db, auth, name));
  } catch (e) {
    return mapChatError(e, "POST categories");
  }
}
