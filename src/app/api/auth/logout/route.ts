// POST /api/auth/logout — 清除 session cookie（token 無狀態，清 cookie 即登出）
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/cookie";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}
