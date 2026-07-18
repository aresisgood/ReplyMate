// 聊天首頁（server component）：session 守門 + 初始資料，互動交給 ChatApp。
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, tables } from "@/lib/db";
import { openSession } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/cookie";
import { listConversations } from "@/lib/chat/queries";
import { listConversationSettings } from "@/lib/chat/settings";
import ChatApp from "./chat/ChatApp";

export const dynamic = "force-dynamic";

export default async function Home() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const userId = token ? openSession(token) : null;
  if (!userId) redirect("/login");

  const me = db.select().from(tables.users).where(eq(tables.users.id, userId)).get();
  if (!me) redirect("/login");

  // 帶上每個對話的 autoReply 狀態與語料分類，UI 才能正確顯示開關、警示與分類選擇器。
  // 設定以單次查詢批次取回（避免每對話 2 次查詢的 N+1）；無設定列則用預設值。
  const settingsMap = listConversationSettings(db, userId);
  const conversations = listConversations(db, userId).map((c) => {
    const s = settingsMap.get(c.conversationId);
    return {
      ...c,
      autoReply: s?.autoReply ?? false,
      styleCategoryId: s?.styleCategoryId ?? null,
      styleCategoryName: s?.styleCategoryName ?? null,
    };
  });

  return (
    <ChatApp
      me={{ id: me.id, displayName: me.displayName }}
      initialConversations={conversations}
    />
  );
}