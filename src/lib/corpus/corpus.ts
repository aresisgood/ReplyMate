// 語料匯入與查詢（架構 §3 F2）：LINE 匯出檔 → styleCorpora + styleSamples。
//
// 我方名字推導：1 對 1 匯出檔只有兩位發言者——標頭的 contactName 是對方，
// 其餘發言者中訊息數最多者即「我方」。不依賴 app displayName 與 LINE 名字一致。
//
// 重傳語意：同 (ownerId, sourceName) 整組取代——transaction 內明刪 samples 與
// corpus 後重建（不依賴連線的 foreign_keys pragma）。原始檔文字不落地（§8 隱私）。

import { and, count, eq } from "drizzle-orm";
import { styleCorpora, styleSamples } from "../db/schema";
import type { AppDatabase } from "../db/types";
import {
  extractStyleSamples,
  parseLineExport,
  type ParsedMessage,
  type ParseResult,
} from "../parser/lineParser";
import { ValidationError } from "../chat/queries";

// better-sqlite3 單句參數上限 999；每列 3 欄，100 列/批留足餘裕。
const INSERT_BATCH_SIZE = 100;

export interface ImportCorpusParams {
  ownerId: string;
  fileText: string;
  contactLabel: string;
}

export interface ImportCorpusResult {
  corpusId: string;
  sourceName: string;
  contactLabel: string;
  sampleCount: number;
  replaced: boolean;
}

function deriveOwnerName(result: ParseResult): string | null {
  const counts = new Map<string, number>();
  for (const m of result.messages) {
    if (m.sender === result.contactName) continue;
    counts.set(m.sender, (counts.get(m.sender) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [name, c] of counts) {
    if (c > bestCount) {
      best = name;
      bestCount = c;
    }
  }
  return best;
}

function toSentAt(m: ParsedMessage): Date {
  // "2026/05/20" + "15:24" → 當地時間 Date；ISO 連字號格式避免引擎差異
  return new Date(`${m.date.replace(/\//g, "-")}T${m.time}:00`);
}

export function importLineCorpus(
  db: AppDatabase,
  { ownerId, fileText, contactLabel }: ImportCorpusParams
): ImportCorpusResult {
  const parsed = parseLineExport(fileText);
  if (!parsed.contactName) throw new ValidationError("無法辨識的 LINE 匯出格式");

  const ownerName = deriveOwnerName(parsed);
  const samples = ownerName ? extractStyleSamples(parsed, ownerName) : [];
  if (samples.length === 0) throw new ValidationError("檔案中沒有可用的風格樣本");

  const sourceName = parsed.contactName;

  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(styleCorpora)
      .where(and(eq(styleCorpora.ownerId, ownerId), eq(styleCorpora.sourceName, sourceName)))
      .get();
    if (existing) {
      tx.delete(styleSamples).where(eq(styleSamples.corpusId, existing.id)).run();
      tx.delete(styleCorpora).where(eq(styleCorpora.id, existing.id)).run();
    }

    const corpus = tx
      .insert(styleCorpora)
      .values({ ownerId, contactLabel, sourceName })
      .returning()
      .get();

    for (let i = 0; i < samples.length; i += INSERT_BATCH_SIZE) {
      const batch = samples.slice(i, i + INSERT_BATCH_SIZE);
      tx.insert(styleSamples)
        .values(batch.map((m) => ({ corpusId: corpus.id, text: m.text, sentAt: toSentAt(m) })))
        .run();
    }

    return {
      corpusId: corpus.id,
      sourceName,
      contactLabel,
      sampleCount: samples.length,
      replaced: Boolean(existing),
    };
  });
}

export interface CorpusSummary {
  id: string;
  contactLabel: string;
  sourceName: string;
  sampleCount: number;
  createdAtMs: number;
}

export function listCorpora(db: AppDatabase, ownerId: string): CorpusSummary[] {
  return db
    .select({
      id: styleCorpora.id,
      contactLabel: styleCorpora.contactLabel,
      sourceName: styleCorpora.sourceName,
      createdAt: styleCorpora.createdAt,
      sampleCount: count(styleSamples.id),
    })
    .from(styleCorpora)
    .leftJoin(styleSamples, eq(styleSamples.corpusId, styleCorpora.id))
    .where(eq(styleCorpora.ownerId, ownerId))
    .groupBy(styleCorpora.id)
    .all()
    .map((r) => ({
      id: r.id,
      contactLabel: r.contactLabel,
      sourceName: r.sourceName,
      sampleCount: r.sampleCount,
      createdAtMs: r.createdAt!.getTime(),
    }));
}
