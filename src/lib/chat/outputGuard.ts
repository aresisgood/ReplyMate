// 自動回覆的輸出側防護（安全稽核 C-1 的第二道防線）
//
// prompt 加固能降低模型被說服的機率，但不保證。自動模式下草稿未經人工審核就
// 送出，因此在送出前用「不依賴模型是否被說服」的規則再擋一次：
//   1. 輸出逐字重現了私人語料（整句，或連續一大段）→ 疑似語料外洩，攔下。
//   2. 輸出異常長 → 多為被操縱吐出大量內容，攔下。
// 失敗一律安全側（不送出）——最壞情況只是這一輪不自動回覆，人仍會看到來訊。

const MIN_VERBATIM_SAMPLE = 8; // 整句逐字重現的最短判定長度（中文字）
const MIN_LEAK_RUN = 20; // 連續重現語料的字元數門檻

export const MAX_AUTO_REPLY_LENGTH = 200; // 架構 §6：草稿短、max_tokens 300

// 輸出是否疑似洩露了風格語料。
export function containsStyleLeak(output: string, samples: readonly string[]): boolean {
  const text = output.trim();
  if (!text) return false;

  for (const raw of samples) {
    const sample = raw.trim();
    if (!sample) continue;

    // 整句逐字重現（語料本身夠長時）
    if (sample.length >= MIN_VERBATIM_SAMPLE && text.includes(sample)) {
      return true;
    }

    // 重現長語料的連續一大段：滑動視窗比對
    const chars = [...sample];
    if (chars.length >= MIN_LEAK_RUN) {
      for (let i = 0; i + MIN_LEAK_RUN <= chars.length; i++) {
        const window = chars.slice(i, i + MIN_LEAK_RUN).join("");
        if (text.includes(window)) return true;
      }
    }
  }

  return false;
}

// 自動送出前的總體安全判定。
export function isSafeAutoReply(output: string, samples: readonly string[]): boolean {
  const text = output.trim();
  if (!text) return false;
  if ([...text].length > MAX_AUTO_REPLY_LENGTH) return false;
  if (containsStyleLeak(text, samples)) return false;
  return true;
}
