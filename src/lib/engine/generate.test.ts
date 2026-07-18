import { describe, it, expect, beforeAll } from "vitest";
import { encryptSecret } from "../crypto";
import {
  generateDraft,
  DRAFT_MODEL,
  DRAFT_MAX_TOKENS,
  type AnthropicClient,
  type MessageCreateParams,
  type GenerateDraftParams,
} from "./generate";
import type { BuildPromptInput } from "./prompt";

beforeAll(() => {
  process.env.APP_SECRET = "test-secret-for-unit-tests-only";
});

const PROMPT_INPUT: BuildPromptInput = {
  displayName: "賴庭右",
  styleSamples: ["好的，我今晚整理完寄給您"],
  recentTurns: [{ sender: "王主管", text: "報告進度如何？", isSelf: false }],
  incomingText: "報告進度如何？",
};

// 假 Anthropic client：記錄呼叫參數與建立時用的 key，回傳可控回應。
function fakeClientFactory(response: {
  content: Array<{ type: string; text?: string }>;
  stop_reason?: string | null;
}) {
  const calls: { apiKey: string; params: MessageCreateParams }[] = [];
  const factory = (apiKey: string): AnthropicClient => ({
    messages: {
      create: async (params: MessageCreateParams) => {
        calls.push({ apiKey, params });
        return response;
      },
    },
  });
  return { factory, calls };
}

function baseParams(overrides: Partial<GenerateDraftParams> = {}): GenerateDraftParams {
  return { prompt: PROMPT_INPUT, envFallback: "sk-env-key", ...overrides };
}

describe("generateDraft", () => {
  it("呼叫 Anthropic 並回傳草稿文字", async () => {
    const { factory } = fakeClientFactory({ content: [{ type: "text", text: "進度正常，明天完成" }] });
    const result = await generateDraft(baseParams({ createClient: factory }));
    expect(result.aiDraft).toBe("進度正常，明天完成");
  });

  it("使用 Haiku 模型與 max_tokens 上限 300", async () => {
    const { factory, calls } = fakeClientFactory({ content: [{ type: "text", text: "ok" }] });
    await generateDraft(baseParams({ createClient: factory }));
    expect(calls[0].params.model).toBe(DRAFT_MODEL);
    expect(DRAFT_MODEL).toBe("claude-haiku-4-5");
    expect(calls[0].params.max_tokens).toBe(DRAFT_MAX_TOKENS);
    expect(DRAFT_MAX_TOKENS).toBeLessThanOrEqual(300);
  });

  it("system 與 user 由 buildPrompt 組裝", async () => {
    const { factory, calls } = fakeClientFactory({ content: [{ type: "text", text: "ok" }] });
    await generateDraft(baseParams({ createClient: factory }));
    expect(calls[0].params.system).toContain("賴庭右");
    expect(calls[0].params.system).toContain("好的，我今晚整理完寄給您");
    expect(calls[0].params.messages[0].content).toContain("報告進度如何？");
  });

  it("使用者個人 key 優先，並以解密後的 key 建立 client", async () => {
    const { factory, calls } = fakeClientFactory({ content: [{ type: "text", text: "ok" }] });
    const result = await generateDraft(
      baseParams({
        createClient: factory,
        encryptedUserKey: encryptSecret("sk-user-key", "apikey"),
      })
    );
    expect(result.keySource).toBe("user");
    expect(calls[0].apiKey).toBe("sk-user-key");
  });

  it("無使用者 key 時 fallback 到 env key，keySource 為 env", async () => {
    const { factory, calls } = fakeClientFactory({ content: [{ type: "text", text: "ok" }] });
    const result = await generateDraft(baseParams({ createClient: factory }));
    expect(result.keySource).toBe("env");
    expect(calls[0].apiKey).toBe("sk-env-key");
  });

  it("完全無可用 key 時丟錯", async () => {
    const { factory } = fakeClientFactory({ content: [{ type: "text", text: "ok" }] });
    await expect(
      generateDraft(baseParams({ createClient: factory, envFallback: null }))
    ).rejects.toThrow();
  });

  it("串接多個 text block，忽略非 text block", async () => {
    const { factory } = fakeClientFactory({
      content: [
        { type: "text", text: "第一段" },
        { type: "thinking" },
        { type: "text", text: "第二段" },
      ],
    });
    const result = await generateDraft(baseParams({ createClient: factory }));
    expect(result.aiDraft).toBe("第一段\n第二段");
  });

  it("stop_reason 為 refusal 時丟錯", async () => {
    const { factory } = fakeClientFactory({ content: [], stop_reason: "refusal" });
    await expect(generateDraft(baseParams({ createClient: factory }))).rejects.toThrow();
  });

  it("模型未回傳任何文字時丟錯", async () => {
    const { factory } = fakeClientFactory({ content: [{ type: "thinking" }] });
    await expect(generateDraft(baseParams({ createClient: factory }))).rejects.toThrow();
  });

  // 撞到 max_tokens 代表草稿被硬切在半句話。手動模式讓使用者重試，好過把殘句
  // 塞進編輯框；自動模式則由 maybeAutoReply 接住而不送出。
  it("stop_reason 為 max_tokens 時丟錯（不把截斷的殘句當成草稿）", async () => {
    const { factory } = fakeClientFactory({
      content: [{ type: "text", text: "好的，我明天會把報告" }],
      stop_reason: "max_tokens",
    });
    await expect(generateDraft(baseParams({ createClient: factory }))).rejects.toThrow(/截斷/);
  });
});
