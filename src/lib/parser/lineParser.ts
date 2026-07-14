// LINE 聊天記錄匯出檔（.txt）parser
//
// LINE 官方匯出格式（繁中，行動版）：
//   [LINE] 與王小明的聊天記錄
//   儲存日期： 2026/06/01 12:34
//   （空行）
//   2026/05/20（三）
//   下午3:24\t賴庭右\t好的沒問題
//   下午3:25\t王小明\t"多行訊息第一行
//   第二行
//   第三行"
//   下午3:26\t王小明\t[貼圖]
//
// 設計決策：
// - 純函式、不碰 DB —— 上傳流程（Week 6 UI）負責把結果寫入 StyleCorpus。
// - 時間一律正規化為 24 小時制，消除「上午/下午 vs 24h 匯出設定」的特殊情況。
// - 多行訊息：LINE 以雙引號包裹，據此累積後續行。

export interface ParsedMessage {
  date: string; // YYYY/MM/DD
  time: string; // HH:mm（24 小時制）
  sender: string;
  text: string;
}

export interface ParseResult {
  contactName: string | null; // 匯出檔標頭中的對話對象名稱
  messages: ParsedMessage[];
}

const HEADER_RE = /^\[LINE\]\s*與(.+?)的聊天記錄\s*$/;
const SAVE_DATE_RE = /^儲存日期[：:]/;
const DATE_LINE_RE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})（.）\s*$/;
// 群組1: 上午|下午（24h 匯出設定時為空）  群組2-3: 時:分  群組4: 傳送者  群組5: 內容
const MESSAGE_RE = /^(上午|下午)?(\d{1,2}):(\d{2})\t([^\t]+)\t([\s\S]*)$/;

// 不具風格價值的內容（貼圖、媒體、系統事件）
const NON_TEXT_RE =
  /^(\[(貼圖|照片|影片|檔案|相簿|語音訊息|連絡資訊|位置訊息)\]|☎|已收回訊息$|你已收回訊息$)/;

function normalizeTime(period: string | undefined, hourRaw: string, minute: string): string {
  let hour = parseInt(hourRaw, 10);
  if (period === "上午" && hour === 12) hour = 0;
  if (period === "下午" && hour !== 12) hour += 12;
  return `${String(hour).padStart(2, "0")}:${minute}`;
}

function pad(n: string): string {
  return n.padStart(2, "0");
}

export function parseLineExport(raw: string): ParseResult {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const messages: ParsedMessage[] = [];
  let contactName: string | null = null;
  let currentDate: string | null = null;
  let openMultiline: ParsedMessage | null = null; // 引號未閉合的訊息

  for (const line of lines) {
    // 多行訊息累積中：吃到閉合引號為止
    if (openMultiline) {
      if (line.endsWith('"')) {
        openMultiline.text += "\n" + line.slice(0, -1);
        openMultiline = null;
      } else {
        openMultiline.text += "\n" + line;
      }
      continue;
    }

    const header = line.match(HEADER_RE);
    if (header) {
      contactName = header[1];
      continue;
    }
    if (SAVE_DATE_RE.test(line)) continue;

    const dateLine = line.match(DATE_LINE_RE);
    if (dateLine) {
      currentDate = `${dateLine[1]}/${pad(dateLine[2])}/${pad(dateLine[3])}`;
      continue;
    }

    const msg = line.match(MESSAGE_RE);
    if (!msg || !currentDate) continue; // 無法辨識的行（含空行）直接略過

    const [, period, hour, minute, sender, rawText] = msg;
    const parsed: ParsedMessage = {
      date: currentDate,
      time: normalizeTime(period, hour, minute),
      sender: sender.trim(),
      text: rawText,
    };

    // 引號包裹的多行訊息
    if (rawText.startsWith('"') && !(rawText.length > 1 && rawText.endsWith('"'))) {
      parsed.text = rawText.slice(1);
      openMultiline = parsed;
    } else if (rawText.startsWith('"') && rawText.endsWith('"') && rawText.length > 1) {
      parsed.text = rawText.slice(1, -1);
    }

    messages.push(parsed);
  }

  return { contactName, messages };
}

// 從解析結果萃取「我方發言」作為風格語料。
// 過濾規則：非文字訊息、過短（<2 字）、過長（>200 字，多為轉貼）、純網址。
export function extractStyleSamples(result: ParseResult, ownerName: string): ParsedMessage[] {
  return result.messages.filter((m) => {
    if (m.sender !== ownerName) return false;
    if (NON_TEXT_RE.test(m.text)) return false;

    const text = m.text.trim();
    if (text.length < 2 || text.length > 200) return false;
    if (/^https?:\/\/\S+$/.test(text)) return false;
    return true;
  });
}
