import { put, list, del } from "@vercel/blob";
import crypto from "node:crypto";

const PREFIX = "zhuyin-rush/shared-topics/";
const MAX_TOPICS = 100;

function safeEqual(a, b) {
  const aBuf = Buffer.from(String(a ?? ""));
  const bBuf = Buffer.from(String(b ?? ""));
  return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
}

function cleanPlainText(value, max = 100) {
  return String(value ?? "")
    .replace(/[<>]/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizeTopicName(value) {
  return cleanPlainText(value, 40).toLocaleLowerCase("zh-TW");
}

function sanitizeQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions)) return [];
  return rawQuestions
    .slice(0, 30)
    .map((q) => {
      const zhuyin = Array.isArray(q?.zhuyin)
        ? q.zhuyin.map((v) => cleanPlainText(v, 2)).filter(Boolean).slice(0, 3)
        : [];
      const answers = Array.isArray(q?.answers)
        ? q.answers.slice(0, 5).map((a) => ({
            word: cleanPlainText(a?.word, 40),
            clue: cleanPlainText(a?.clue, 120),
          })).filter((a) => a.word && a.clue)
        : [];
      if (zhuyin.length < 2 || answers.length < 3) return null;
      return { zhuyin, answers };
    })
    .filter(Boolean);
}

async function readAllEntries() {
  const { blobs } = await list({ prefix: PREFIX, limit: MAX_TOPICS });
  const entries = await Promise.all(
    (blobs || []).map(async (blob) => {
      try {
        const response = await fetch(blob.url, { cache: "no-store" });
        if (!response.ok) return null;
        const data = await response.json();
        const topic = cleanPlainText(data?.topic, 40);
        const questions = sanitizeQuestions(data?.questions);
        if (!topic || questions.length === 0) return null;
        return {
          id: cleanPlainText(data?.id, 80) || blob.pathname,
          topic,
          difficulty: cleanPlainText(data?.difficulty, 20) || "standard",
          mode: cleanPlainText(data?.mode, 20) || "smart",
          questions,
          createdAt: cleanPlainText(data?.createdAt, 40) || blob.uploadedAt || "",
          blobUrl: blob.url,
        };
      } catch (error) {
        console.warn("Shared topic read failed:", blob.pathname, error);
        return null;
      }
    })
  );

  const valid = entries.filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const deduped = new Map();
  for (const entry of valid) {
    const key = normalizeTopicName(entry.topic);
    if (!deduped.has(key)) deduped.set(key, entry);
  }
  return Array.from(deduped.values()).slice(0, MAX_TOPICS);
}

function requireAccessCode(req, res) {
  const configuredCode = process.env.APP_ACCESS_CODE;
  if (configuredCode && !safeEqual(req.body?.accessCode, configuredCode)) {
    res.status(401).json({ error: "連線密碼不正確。" });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  try {
    if (req.method === "GET") {
      const topics = await readAllEntries();
      return res.status(200).json({ topics });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "只接受 GET / POST 請求。" });
    }

    if (!requireAccessCode(req, res)) return;

    const action = req.body?.action || "save";
    if (action === "delete") {
      const targetTopic = normalizeTopicName(req.body?.topic);
      if (!targetTopic) return res.status(400).json({ error: "缺少要刪除的共享題庫名稱。" });

      const { blobs } = await list({ prefix: PREFIX, limit: MAX_TOPICS });
      const urlsToDelete = [];
      for (const blob of blobs || []) {
        try {
          const response = await fetch(blob.url, { cache: "no-store" });
          if (!response.ok) continue;
          const data = await response.json();
          if (normalizeTopicName(data?.topic) === targetTopic) urlsToDelete.push(blob.url);
        } catch {}
      }
      if (urlsToDelete.length) await del(urlsToDelete);
      return res.status(200).json({ ok: true, deleted: urlsToDelete.length });
    }

    const topic = cleanPlainText(req.body?.topic, 40);
    const questions = sanitizeQuestions(req.body?.questions);
    const difficulty = ["easy", "standard", "challenge"].includes(req.body?.difficulty)
      ? req.body.difficulty
      : "standard";
    const mode = ["smart", "strict"].includes(req.body?.mode) ? req.body.mode : "smart";

    if (!topic) return res.status(400).json({ error: "缺少共享題庫名稱。" });
    if (questions.length < 3) return res.status(400).json({ error: "共享題庫至少需要 3 題合法題目。" });

    // 同名題庫視為更新。先寫入新版本，成功後才清除舊版本；就算清理失敗，GET 也會只顯示最新一份。
    const existing = await readAllEntries();
    const sameTopic = existing.filter((item) => normalizeTopicName(item.topic) === normalizeTopicName(topic));

    const id = crypto.randomUUID();
    const payload = {
      id,
      topic,
      difficulty,
      mode,
      questions,
      createdAt: new Date().toISOString(),
    };

    const blob = await put(
      `${PREFIX}${id}.json`,
      JSON.stringify(payload),
      {
        access: "public",
        addRandomSuffix: true,
        contentType: "application/json",
      }
    );

    if (sameTopic.length) {
      try {
        await del(sameTopic.map((item) => item.blobUrl));
      } catch (cleanupError) {
        console.warn("Old shared topic cleanup failed; latest version is still available:", cleanupError);
      }
    }

    return res.status(200).json({
      ok: true,
      topic: {
        ...payload,
        blobUrl: blob.url,
      },
    });
  } catch (error) {
    console.error("Shared topics API failed:", error);
    const message = String(error?.message || "未知錯誤");
    if (/token|blob|store|oidc|access denied|unauthorized/i.test(message)) {
      return res.status(503).json({
        error: "共享題庫雲端儲存尚未連接。請先在 Vercel 專案建立並連接 Blob Storage，再重新部署。",
      });
    }
    return res.status(500).json({ error: "共享題庫讀寫失敗，請稍後再試。" });
  }
}
