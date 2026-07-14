import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // 自動 JSX runtime，元件測試無需在 scope 內 import React
  esbuild: { jsx: "automatic" },
  resolve: {
    // 與 tsconfig paths 對齊，讓測試可匯入使用 "@/..." 的 route 模組
    alias: { "@": path.resolve(__dirname, "src") },
  },
  // 預設 node 環境；元件測試以檔內 `// @vitest-environment jsdom` docblock 覆蓋。
  test: { environment: "node", include: ["src/**/*.test.{ts,tsx}"] },
});
