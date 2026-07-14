// @vitest-environment jsdom
// SettingsApp smoke：清單渲染、sourceName 不匹配警示、上傳前置條件。
import { describe, expect, it, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import SettingsApp from "./SettingsApp";

afterEach(() => cleanup());

const CORPORA = [
  {
    id: "c1",
    contactLabel: "主管",
    sourceName: "王主管",
    sampleCount: 48,
    createdAtMs: 1_700_000_000_000,
  },
  {
    id: "c2",
    contactLabel: "朋友",
    sourceName: "陳小美",
    sampleCount: 12,
    createdAtMs: 1_700_000_000_000,
  },
];

describe("SettingsApp", () => {
  it("渲染語料清單（標籤、來源、句數）", () => {
    render(<SettingsApp initialCorpora={CORPORA} counterpartNames={["王主管"]} />);
    expect(screen.getByText("主管")).toBeInTheDocument();
    expect(screen.getByText(/王主管/)).toBeInTheDocument();
    expect(screen.getByText(/48 句/)).toBeInTheDocument();
  });

  it("sourceName 與既有對話對象不符時顯示警示", () => {
    render(<SettingsApp initialCorpora={CORPORA} counterpartNames={["王主管"]} />);
    // 陳小美不在對話對象中 → 警示；王主管有 → 無警示
    expect(screen.getAllByText(/沒有名為/)).toHaveLength(1);
  });

  it("未選擇檔案時上傳按鈕 disabled", () => {
    render(<SettingsApp initialCorpora={[]} counterpartNames={[]} />);
    expect(screen.getByRole("button", { name: "上傳" })).toBeDisabled();
  });

  it("無語料時顯示空狀態", () => {
    render(<SettingsApp initialCorpora={[]} counterpartNames={[]} />);
    expect(screen.getByText(/尚未上傳/)).toBeInTheDocument();
  });
});
