// 引導頁（server component）：session 守門，互動交給 OnboardingApp。
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { openSession } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/cookie";
import OnboardingApp from "./OnboardingApp";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const userId = token ? openSession(token) : null;
  if (!userId) redirect("/login");

  return <OnboardingApp />;
}
