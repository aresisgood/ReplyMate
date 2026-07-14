// Route handler 共用的 HTTP helper（審查 M-2）——收斂重複的 session 檢查與
// 型別化錯誤映射，確保所有 route 的行為一致，並讓新 route 少寫樣板。

import { NextResponse, after, type NextRequest } from "next/server";
import { getSessionUserId } from "./auth/cookie";
import { ForbiddenError, NotFoundError, ValidationError } from "./chat/queries";

// 取出登入 userId；未登入回 401 response。呼叫端樣式：
//   const auth = requireUser(request);
//   if (auth instanceof NextResponse) return auth;
//   const userId = auth;
export function requireUser(request: NextRequest): string | NextResponse {
  const userId = getSessionUserId(request);
  if (!userId) return NextResponse.json({ error: "未登入" }, { status: 401 });
  return userId;
}

// 型別化聊天錯誤 → HTTP status。使用者可修正的錯誤回其訊息；未知內部錯誤
// 只記 log（name: message）並回泛用 500，避免內部細節外洩（併入 M-3/L-4）。
export function mapChatError(e: unknown, context: string): NextResponse {
  if (e instanceof NotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
  if (e instanceof ForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
  if (e instanceof ValidationError) return NextResponse.json({ error: e.message }, { status: 400 });

  const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  console.error(`[${context}] 內部錯誤：`, detail);
  return NextResponse.json({ error: "伺服器錯誤，請稍後再試" }, { status: 500 });
}

// 把慢工作（自動回覆的 LLM 呼叫）移到回應送出之後，但仍保證它跑得完。
//
// 為什麼不用裸的 void：在 serverless 上，回應一 return，函式就可能被凍結或
// 回收，飛在半空中的工作會被砍——可能砍在 DB 寫入的正中間。Next 的 after()
// 會讓 runtime 撐到工作結束。
//
// 為什麼包 try/catch：after() 需要 request scope，單元測試直接呼叫 route
// handler 時沒有這個 scope 而會拋錯。那種環境本來就沒有會被凍結的 runtime，
// 退化為 fire-and-forget 即可。
export function afterResponse(work: Promise<unknown>, context: string): void {
  // 背景工作無人 catch —— 漏出去的 rejection 在 Node 15+ 會直接終止程序。
  // 這是最後一道防線，呼叫端仍應自行處理自己的錯誤。
  const guarded = work.catch((e: unknown) => {
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(`[${context}] 背景工作失敗：`, detail);
  });

  try {
    after(guarded);
  } catch {
    void guarded; // 無 request scope（例如單元測試）
  }
}
