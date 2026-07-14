import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ReplyMate",
  description: "內建 AI 代筆的訊息軟體 — 讓休息真正成為休息",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
