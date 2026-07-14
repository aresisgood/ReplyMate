// POST /api/auth/login — 帳密驗證 → 設定 session cookie
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyCredentials } from "@/lib/auth/password";
import { sealSession, SESSION_TTL_MS } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/cookie";
import { loginIpRateLimiter, loginRateLimiter } from "@/lib/rateLimit";

// 長度上限：username 會成為限流 Map 的 key，不設限等於讓外部輸入決定記憶體
// 用量。password 上限則避免拿超長字串去餵 bcrypt（bcrypt 本就只取前 72 bytes）。
const MAX_USERNAME_LENGTH = 64;
const MAX_PASSWORD_LENGTH = 200;

// 取用戶端 IP。反向代理後方以 x-forwarded-for 的第一段為準；取不到時退化為
// 單一固定 key——寧可讓所有匿名來源共用一個較寬鬆的桶，也不要完全不限流。
function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "請求格式錯誤" }, { status: 400 });
  }

  const { username, password } = (body ?? {}) as { username?: unknown; password?: unknown };
  if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
    return NextResponse.json({ error: "缺少帳號或密碼" }, { status: 400 });
  }
  if (username.length > MAX_USERNAME_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    return NextResponse.json({ error: "帳號或密碼錯誤" }, { status: 401 });
  }

  // 依 IP 限流：擋輪換帳號的密碼噴灑（帳號層上限對它無效）。
  if (!loginIpRateLimiter.check(clientIp(request))) {
    return NextResponse.json({ error: "登入嘗試過於頻繁，請稍後再試" }, { status: 429 });
  }

  // 依帳號限流：擋單一帳號的密碼暴力破解（安全稽核 H-2）
  if (!loginRateLimiter.check(username)) {
    return NextResponse.json({ error: "登入嘗試過於頻繁，請稍後再試" }, { status: 429 });
  }

  const user = await verifyCredentials(db, username, password);
  if (!user) {
    // 不區分「查無帳號」與「密碼錯誤」，避免帳號列舉
    return NextResponse.json({ error: "帳號或密碼錯誤" }, { status: 401 });
  }

  // 帳號層的額度只用來擋「失敗」的嘗試；登入成功即歸還，正常使用者反覆登入
  // 不會把自己的額度用光。
  loginRateLimiter.release(username);

  const response = NextResponse.json({ user });
  response.cookies.set(SESSION_COOKIE, sealSession(user.id), {
    httpOnly: true,
    sameSite: "lax",
    // 正式環境強制 HTTPS-only，避免降級請求以明文送出 session token（安全稽核 H-1）。
    // 本機開發走 http，故僅在 production 啟用。
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return response;
}
