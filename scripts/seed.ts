// 種子資料 — 課堂 Demo 用的預建帳號與示範對話
// 執行：npm run db:seed（會先清空再重建，可重複執行）

import bcrypt from "bcryptjs";
import { db, tables } from "../src/lib/db";

async function main() {
  // 清空（順序：先子後父，避免外鍵衝突）
  db.delete(tables.draftSessions).run();
  db.delete(tables.styleSamples).run();
  db.delete(tables.styleCorpora).run();
  db.delete(tables.messages).run();
  db.delete(tables.conversations).run();
  db.delete(tables.users).run();

  const passwordHash = await bcrypt.hash("demo1234", 10);

  const [me] = db
    .insert(tables.users)
    .values({ username: "tingyu", passwordHash, displayName: "賴庭右" })
    .returning()
    .all();
  const [boss] = db
    .insert(tables.users)
    .values({ username: "boss", passwordHash, displayName: "王主管" })
    .returning()
    .all();

  const [conversation] = db
    .insert(tables.conversations)
    .values({ userAId: me.id, userBId: boss.id })
    .returning()
    .all();

  // 示範對話：最後一則是「休假時收到的工作訊息」→ Demo 的 AI 協助入口
  const script: Array<{ senderId: string; text: string }> = [
    { senderId: boss.id, text: "庭右，下週一的提案簡報進度如何？" },
    { senderId: me.id, text: "初稿完成八成了，剩下數據圖表的部分，週五前會給您看第一版" },
    { senderId: boss.id, text: "好，記得把客戶上次提的預算限制放進去" },
    { senderId: me.id, text: "了解，我會加一頁成本比較" },
    { senderId: boss.id, text: "另外週六方便的話，幫我看一下合約附件有沒有問題，急" },
  ];
  const base = Date.now() - script.length * 60_000;
  db.insert(tables.messages)
    .values(
      script.map((m, i) => ({
        conversationId: conversation.id,
        senderId: m.senderId,
        text: m.text,
        createdAt: new Date(base + i * 60_000),
      }))
    )
    .run();

  // 初始風格語料（正式資料由 Week 6 的上傳流程經 lineParser 產生）
  const [corpus] = db
    .insert(tables.styleCorpora)
    .values({ ownerId: me.id, sourceName: "王主管" })
    .returning()
    .all();

  const samples = [
    "好的，我今晚整理完寄給您",
    "了解，這部分我週三前處理好",
    "收到，我先確認一下細節再回覆您",
    "不好意思稍微晚回，剛剛在開會",
    "這個需求我想分兩階段：先做核心流程，報表之後補",
    "辛苦了，明天見",
  ];
  db.insert(tables.styleSamples)
    .values(samples.map((text) => ({ corpusId: corpus.id, text })))
    .run();

  console.log("Seed 完成：");
  console.log("  帳號 tingyu / demo1234（賴庭右）");
  console.log("  帳號 boss   / demo1234（王主管）");
  console.log(`  對話 1 筆、訊息 ${script.length} 筆、風格語料 ${samples.length} 句`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
