// 草稿引擎 — Anthropic 呼叫（few-shot prompting，見架構文件 §6）
//
// 組合 A1–A3：解析 BYOK key → 組裝 prompt → 呼叫 Anthropic Haiku → 取出草稿文字。
//
// 設計決策：
// - 模型固定 claude-haiku-4-5、max_tokens 300——架構 ADR 與 brief 約束 2 的成本
//   控制要求；不用 Opus/Sonnet。回覆草稿短、Haiku 足夠且便宜。
// - 本函式**不碰 DB**：只回傳 aiDraft 與 keySource，draft_sessions 的寫入由
//   Week 5 的 /api/drafts route 負責。維持引擎與聊天系統解耦（架構 §2）。
// - Anthropic client 以 factory 注入，讓單元測試以假 client 驗證而不打真 API。

import Anthropic from "@anthropic-ai/sdk";
import { buildPrompt, type BuildPromptInput } from "./prompt";
import { resolveApiKey, type ApiKeySource } from "./keyResolver";

export const DRAFT_MODEL = "claude-haiku-4-5";
export const DRAFT_MAX_TOKENS = 300;

// 逾時：自動回覆是在回應送出後的背景工作，掛住的請求會一直佔著 runtime。
// 300 tokens 的 Haiku 呼叫正常在數秒內完成，20 秒已是很寬鬆的上限。
export const DRAFT_TIMEOUT_MS = 20_000;

// 只描述本模組實際用到的 SDK 介面，方便測試注入。
export interface MessageCreateParams {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: "user"; content: string }>;
}

export interface MessageResponse {
  content: Array<{ type: string; text?: string }>;
  stop_reason?: string | null;
}

export interface AnthropicClient {
  messages: { create(params: MessageCreateParams): Promise<MessageResponse> };
}

export type AnthropicFactory = (apiKey: string) => AnthropicClient;

const defaultFactory: AnthropicFactory = (apiKey) =>
  new Anthropic({ apiKey, timeout: DRAFT_TIMEOUT_MS }) as unknown as AnthropicClient;

export interface GenerateDraftParams {
  prompt: BuildPromptInput;
  /** users.anthropicApiKeyEnc（加密）；null/空代表未設定。 */
  encryptedUserKey?: string | null;
  /** .env 的 ANTHROPIC_API_KEY，由呼叫端注入。 */
  envFallback?: string | null;
  /** 測試注入用；預設建立真實 Anthropic client。 */
  createClient?: AnthropicFactory;
}

export interface GeneratedDraft {
  aiDraft: string;
  keySource: ApiKeySource;
}

export async function generateDraft(params: GenerateDraftParams): Promise<GeneratedDraft> {
  const { key, source } = resolveApiKey({
    encryptedUserKey: params.encryptedUserKey,
    envFallback: params.envFallback,
  });

  const { system, user } = buildPrompt(params.prompt);
  const client = (params.createClient ?? defaultFactory)(key);

  const response = await client.messages.create({
    model: DRAFT_MODEL,
    max_tokens: DRAFT_MAX_TOKENS,
    system,
    messages: [{ role: "user", content: user }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("模型基於安全考量拒絕生成回覆草稿");
  }

  // 撞到 max_tokens 代表草稿被硬切在半句話（「好的，我明天會把報告」）。
  // 手動模式下讓使用者收到 502 重試，好過把殘句塞進編輯框；自動模式下
  // maybeAutoReply 會接住這個錯誤而不送出——兩邊都是安全的方向。
  if (response.stop_reason === "max_tokens") {
    throw new Error("草稿超出長度上限而被截斷");
  }

  const aiDraft = response.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!aiDraft) {
    throw new Error("模型未回傳任何草稿內容");
  }

  return { aiDraft, keySource: source };
}
