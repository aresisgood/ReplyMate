// Session cookie 的名稱與讀取 helper（route handlers 共用）。
import type { NextRequest } from "next/server";
import { openSession } from "./session";

export const SESSION_COOKIE = "rm_session";

// 從請求 cookie 解出已登入的 userId；未登入/無效/過期回 null。
export function getSessionUserId(request: NextRequest): string | null {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return openSession(token);
}
