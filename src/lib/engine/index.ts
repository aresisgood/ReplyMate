// 草稿引擎公開介面（Week 5 /api/drafts 由此消費）。
export { selectStyleSamples, type StyleSample, type SelectOptions } from "./retrieval";
export { buildPrompt, type BuildPromptInput, type PromptPayload, type ConversationTurn } from "./prompt";
export { resolveApiKey, type ApiKeySource, type ResolvedKey } from "./keyResolver";
export { generateDraft, DRAFT_MODEL, DRAFT_MAX_TOKENS, type GenerateDraftParams, type GeneratedDraft } from "./generate";
