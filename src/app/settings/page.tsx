// 設定頁（server component）：session 守門 + 初始資料，互動交給 SettingsApp。
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { openSession } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/cookie";
import { listCorpora } from "@/lib/corpus/corpus";
import { listConversations } from "@/lib/chat/queries";
import SettingsApp from "./SettingsApp";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const userId = token ? openSession(token) : null;
  if (!userId) redirect("/login");

  return (
    <SettingsApp
      initialCorpora={listCorpora(db, userId)}
      counterpartNames={listConversations(db, userId).map((c) => c.counterpartName)}
    />
  );
}
