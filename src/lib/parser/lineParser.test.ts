import { describe, it, expect } from "vitest";
import { parseLineExport, extractStyleSamples } from "./lineParser";

const FIXTURE = [
  "[LINE] 與王主管的聊天記錄",
  "儲存日期： 2026/06/01 12:34",
  "",
  "2026/05/20（三）",
  "上午9:05\t王主管\t明天的報告記得帶",
  "上午9:07\t賴庭右\t好的，我今晚整理完寄給您",
  "上午12:01\t賴庭右\t午安，檔案已寄出",
  "下午12:30\t王主管\t收到",
  "下午3:24\t賴庭右\t[貼圖]",
  '下午3:25\t賴庭右\t"這個需求我想分兩階段：',
  "第一階段先做核心流程",
  '第二階段再補報表"',
  "下午3:26\t王主管\t☎ 通話時間 3:21",
  "下午3:27\t王主管\t已收回訊息",
  "2026/05/21（四）",
  "下午11:59\t賴庭右\t辛苦了，明天見",
  "下午4:00\t賴庭右\thttps://example.com/spec",
].join("\n");

describe("parseLineExport", () => {
  const result = parseLineExport(FIXTURE);

  it("解析標頭的對話對象名稱", () => {
    expect(result.contactName).toBe("王主管");
  });

  it("解析出所有訊息行（含貼圖/通話/收回，過濾是下一層的事）", () => {
    expect(result.messages).toHaveLength(10);
  });

  it("上午/下午正確轉為 24 小時制（含 12 點邊界）", () => {
    const times = result.messages.map((m) => m.time);
    expect(times).toContain("09:05"); // 上午9:05
    expect(times).toContain("00:01"); // 上午12:01 → 午夜 00:01
    expect(times).toContain("12:30"); // 下午12:30 維持 12
    expect(times).toContain("15:24"); // 下午3:24
    expect(times).toContain("23:59"); // 下午11:59
  });

  it("上午12點 = 00 時（午夜邊界）", () => {
    const msg = result.messages.find((m) => m.text === "午安，檔案已寄出");
    expect(msg?.time).toBe("00:01");
  });

  it("引號包裹的多行訊息完整還原", () => {
    const multi = result.messages.find((m) => m.text.includes("分兩階段"));
    expect(multi?.text).toBe(
      "這個需求我想分兩階段：\n第一階段先做核心流程\n第二階段再補報表"
    );
  });

  it("跨日期區塊時 date 正確切換", () => {
    const lastDay = result.messages.filter((m) => m.date === "2026/05/21");
    expect(lastDay).toHaveLength(2);
  });
});

describe("extractStyleSamples", () => {
  const result = parseLineExport(FIXTURE);
  const samples = extractStyleSamples(result, "賴庭右");

  it("只留我方發言", () => {
    expect(samples.every((m) => m.sender === "賴庭右")).toBe(true);
  });

  it("過濾貼圖與純網址，保留文字與多行訊息", () => {
    const texts = samples.map((m) => m.text);
    expect(texts).toContain("好的，我今晚整理完寄給您");
    expect(texts).toContain("辛苦了，明天見");
    expect(texts.some((t) => t.includes("分兩階段"))).toBe(true);
    expect(texts).not.toContain("[貼圖]");
    expect(texts).not.toContain("https://example.com/spec");
  });

  it("對方發言不會混入語料", () => {
    const texts = samples.map((m) => m.text);
    expect(texts).not.toContain("明天的報告記得帶");
  });
});
