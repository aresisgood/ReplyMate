// GET /api/corpus — 我的風格語料清單（含句數）
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/http";
import { listCorpora } from "@/lib/corpus/corpus";

export async function GET(request: NextRequest) {
  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json({ corpora: listCorpora(db, auth) });
}
