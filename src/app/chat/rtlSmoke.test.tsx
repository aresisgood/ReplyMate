// @vitest-environment jsdom
// 暫時性診斷：逐步加入 ChatApp 測試的依賴，找出 collection 卡住的來源。
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ChatApp from "./ChatApp";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

function Hello() {
  return <p>hello-rtl</p>;
}

describe("RTL 基建", () => {
  it("可渲染最小元件（ChatApp 已 import 但未渲染）", () => {
    expect(typeof ChatApp).toBe("function");
    render(<Hello />);
    expect(screen.getByText("hello-rtl")).toBeTruthy();
  });
});