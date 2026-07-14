// 聊天首頁（server component）：session 守門 + 初始資料，互動交給 ChatApp。
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, tables } from "@/lib/db";
import { openSession } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/cookie";
import { listConversations } from "@/lib/chat/queries";
import { getAutoReply } from "@/lib/chat/settings";
import ChatApp from "./chat/ChatApp";

export const dynamic = "force-dynamic";

export default async function Home() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const userId = token ? openSession(token) : null;
  if (!userId) redirect("/login");

  const me = db.select().from(tables.users).where(eq(tables.users.id, userId)).get();
  if (!me) redirect("/login");

  // 帶上每個對話的 autoReply 狀態，UI 才能正確顯示開關與警示
  const conversations = listConversations(db, userId).map((c) => ({
    ...c,
    autoReply: getAutoReply(db, userId, c.conversationId),
  }));

  return (
    <ChatApp
      me={{ id: me.id, displayName: me.displayName }}
      initialConversations={conversations}
    />
  );
}