// ESLint flat config（ESLint 9）。
//
// 為什麼是 flat config 而非 .eslintrc：`next lint` 已於 Next 15 標為 deprecated、
// 將在 16 移除，官方路徑是直接用 ESLint CLI。以 FlatCompat 橋接 next 的
// eslintrc 格式預設集（next 尚未提供原生 flat 版本）。
//
// 規則集：
// - next/core-web-vitals：Next 的正確性規則 + Core Web Vitals 相關的效能規則
// - next/typescript：@typescript-eslint 推薦規則（含 no-explicit-any，
//   對應 coding-style.md「避免使用 any 型別」）
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

const config = [
  {
    // 產物與外部檔案不 lint：drizzle/ 是 migration 產生器的輸出（改它等於改
    // migration 歷史）；.claude/ 是本機的 Claude Code 個人環境（已在 .gitignore
    // 中排除，其中的 skill 腳本不受本專案規範約束）。
    ignores: [
      "node_modules/**",
      ".next/**",
      "coverage/**",
      "drizzle/**",
      ".claude/**",
      "next-env.d.ts",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default config;
