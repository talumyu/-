import OpenAI from "openai";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import crypto from "node:crypto";

function getOpenAIClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

const AnswerSchema = z.object({
  word: z.string(),
  bopomofo: z.array(z.string()).min(2).max(3),
  clue: z.string(),
  relevance: z.number().int(),
  commonness: z.number().int(),
});

const QuestionSchema = z.object({
  zhuyin: z.array(z.string()).min(2).max(3),
  answers: z.array(AnswerSchema).min(3).max(5),
});

const GeneratedTopicSchema = z.object({
  topic: z.string(),
  questions: z.array(QuestionSchema).min(1).max(28),
});

const ZHUYIN_CHAR = /^[\u3105-\u3129]$/u;
const ZHUYIN_SYLLABLE = /^[\u3105-\u3129]+[ˊˇˋ˙]?$/u;
const HAN_CHAR = /^\p{Script=Han}$/u;

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

function getHanChars(word) {
  return Array.from(word).filter((ch) => HAN_CHAR.test(ch));
}

function firstZhuyin(syllable) {
  const chars = Array.from(String(syllable).trim());
  return chars.find((ch) => ZHUYIN_CHAR.test(ch)) || "";
}

function validateAndNormalizeQuestion(question, { mode, difficulty, usedWords }) {
  if (!question || !Array.isArray(question.zhuyin) || !Array.isArray(question.answers)) return null;

  const target = question.zhuyin.map((v) => cleanPlainText(v, 1));
  if (target.length < 2 || target.length > 3 || !target.every((v) => ZHUYIN_CHAR.test(v))) return null;
  if (difficulty === "easy" && target.length !== 2) return null;

  const localWords = new Set();
  const validAnswers = [];

  for (const rawAnswer of question.answers) {
    const word = cleanPlainText(rawAnswer.word, 8).replace(/\s/g, "");
    const clue = cleanPlainText(rawAnswer.clue, 100);
    const bopomofo = Array.isArray(rawAnswer.bopomofo)
      ? rawAnswer.bopomofo.map((s) => cleanPlainText(s, 10))
      : [];

    const chars = Array.from(word);
    const hanChars = getHanChars(word);
    if (chars.length !== hanChars.length) continue;
    if (chars.length !== target.length || bopomofo.length !== target.length) continue;
    if (!bopomofo.every((s) => ZHUYIN_SYLLABLE.test(s))) continue;
    if (!target.every((initial, idx) => firstZhuyin(bopomofo[idx]) === initial)) continue;
    if (word.length < 2 || clue.length < 6) continue;
    if (clue.includes(word)) continue;
    if (localWords.has(word) || usedWords.has(word)) continue;

    const relevance = Number(rawAnswer.relevance) || 0;
    const commonness = Number(rawAnswer.commonness) || 0;
    if (relevance < 0 || relevance > 100 || commonness < 0 || commonness > 100) continue;
    if (difficulty === "easy" && commonness < 72) continue;
    if (difficulty === "standard" && commonness < 55) continue;
    if (difficulty === "challenge" && commonness < 35) continue;

    validAnswers.push({ word, clue, bopomofo, relevance, commonness });
    localWords.add(word);
  }

  if (validAnswers.length < 3) return null;
  validAnswers.sort((a, b) => (b.relevance * 0.62 + b.commonness * 0.38) - (a.relevance * 0.62 + a.commonness * 0.38));

  let chosen = validAnswers.slice(0, 3);
  if (mode === "strict") {
    const strictAnswers = validAnswers.filter((a) => a.relevance >= 70);
    if (strictAnswers.length < 3) return null;
    chosen = strictAnswers.slice(0, 3);
  } else {
    const hasCore = validAnswers.some((a) => a.relevance >= 82);
    const averageTop3 = chosen.reduce((sum, a) => sum + a.relevance, 0) / chosen.length;
    if (!hasCore || averageTop3 < 38) return null;
  }

  chosen.forEach((a) => usedWords.add(a.word));

  return {
    zhuyin: target,
    answers: chosen.map((a) => ({
      word: `${a.word} (${a.bopomofo.join(" ")})`,
      clue: a.clue,
    })),
  };
}

function extractSources(response) {
  const found = new Map();
  for (const item of response?.output || []) {
    if (item?.type !== "web_search_call") continue;
    const sources = item?.action?.sources || [];
    for (const source of sources) {
      const url = source?.url;
      if (!url || found.has(url)) continue;
      found.set(url, {
        title: cleanPlainText(source?.title || source?.name || "網路來源", 120),
        url,
      });
    }
  }
  return Array.from(found.values()).slice(0, 12);
}

function buildPrompt({ topic, difficulty, mode, candidateCount, excludedSignatures }) {
  const difficultyRules = {
    easy: "簡單：只產生 2 字詞；以國小到國中常見詞為主，避免專有名詞與冷僻詞；提示要直接好懂。",
    standard: "標準：以 2 字詞為主，可有少量 3 字詞；使用一般成人與高中生熟悉的詞彙，可包含常見主題術語。",
    challenge: "挑戰：2 到 3 字詞皆可，提高 3 字詞與主題專有詞比例，但仍禁止生造詞、極冷僻詞與只有少數專家知道的詞。",
  }[difficulty];

  const modeRules = mode === "strict"
    ? "嚴格主題：每一題的三個參考答案都必須直接與主題相關；若湊不到，不要硬造詞。"
    : "智慧延伸：每題至少一個答案必須直接與主題高度相關；其餘答案可為常見合法中文詞，只要注音規則完全相同。";

  const exclusions = excludedSignatures.length
    ? `不要再產生這些已使用的注音組合：${excludedSignatures.join("、")}`
    : "";

  return `
你正在為台灣團康遊戲「注音急轉彎」即時建立題庫。請先使用網路搜尋，蒐集與「${topic}」有關的常見繁體中文詞彙、術語、人物、地點、物件、動作等，再建立可玩的題目。

遊戲規則（必須嚴格遵守）：
1. 每題 zhuyin 是 2 或 3 個「注音符號開頭」，例如 ["ㄊ","ㄕ"]。
2. 每題提供 3～5 個候選答案；同一題所有答案的中文字數必須等於 zhuyin 長度。
3. 每個答案 bopomofo 必須逐字列出完整注音，例如「投手」=> ["ㄊㄡˊ","ㄕㄡˇ"]。
4. 每個 bopomofo 音節的第一個注音符號，必須逐一與該題 zhuyin 完全相同。
5. 只使用台灣常見的繁體中文字詞；禁止簡體字、生造詞、英文、數字、符號、過度冷僻詞。
6. 避免破音字或讀音高度有爭議的詞；不確定就不要使用。
7. clue 是主持人提示，不能直接出現完整答案文字，但必須能合理讓玩家聯想到答案。
8. relevance：0～100，表示該詞與「${topic}」的直接相關程度。
9. commonness：0～100，表示一般台灣玩家對該詞的熟悉程度。
10. 需要產生約 ${candidateCount} 組候選題，寧可多產生可驗證的候選，也不要為了湊數違反規則。

難度：${difficultyRules}
主題模式：${modeRules}
${exclusions}

題目會再由程式逐題驗證，因此請把完整 bopomofo、relevance、commonness 填準確。輸出只需符合指定結構，不要加額外說明。`;
}

async function generateCandidateBatch({ topic, difficulty, mode, candidateCount, excludedSignatures }) {
  const openai = getOpenAIClient();
  const response = await openai.responses.parse({
    model: process.env.OPENAI_MODEL || "gpt-5.6",
    reasoning: { effort: "low" },
    tools: [{ type: "web_search" }],
    tool_choice: "required",
    include: ["web_search_call.action.sources"],
    input: [
      {
        role: "system",
        content: "你是台灣繁體中文團康遊戲的專業題庫編輯。你會先搜尋資料，再嚴格遵守注音與字數規則，不會為了湊題數捏造詞語。",
      },
      {
        role: "user",
        content: buildPrompt({ topic, difficulty, mode, candidateCount, excludedSignatures }),
      },
    ],
    text: {
      format: zodTextFormat(GeneratedTopicSchema, "zhuyin_rush_topic"),
    },
  });

  if (!response.output_parsed) {
    throw new Error("模型沒有回傳可解析的題庫資料。可能是內容被拒絕或輸出中斷。");
  }

  return { parsed: response.output_parsed, sources: extractSources(response) };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "只接受 POST 請求。" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "伺服器尚未設定 OPENAI_API_KEY。請到部署平台加入環境變數。" });
  }

  const configuredCode = process.env.APP_ACCESS_CODE;
  if (configuredCode && !safeEqual(req.body?.accessCode, configuredCode)) {
    return res.status(401).json({ error: "連線密碼不正確。" });
  }

  const topic = cleanPlainText(req.body?.topic, 40);
  const difficulty = ["easy", "standard", "challenge"].includes(req.body?.difficulty)
    ? req.body.difficulty
    : "standard";
  const mode = ["smart", "strict"].includes(req.body?.mode) ? req.body.mode : "smart";
  const count = Math.max(5, Math.min(Number.parseInt(req.body?.count, 10) || 10, 20));

  if (!topic) {
    return res.status(400).json({ error: "請輸入主題。" });
  }

  try {
    const finalQuestions = [];
    const usedWords = new Set();
    const usedSignatures = new Set();
    const allSources = new Map();
    const maxAttempts = 2;

    for (let attempt = 0; attempt < maxAttempts && finalQuestions.length < count; attempt++) {
      const remaining = count - finalQuestions.length;
      const candidateCount = Math.min(24, remaining + (attempt === 0 ? 8 : 6));
      const { parsed, sources } = await generateCandidateBatch({
        topic,
        difficulty,
        mode,
        candidateCount,
        excludedSignatures: Array.from(usedSignatures),
      });

      sources.forEach((s) => allSources.set(s.url, s));

      for (const candidate of parsed.questions || []) {
        if (finalQuestions.length >= count) break;
        const signature = (candidate.zhuyin || []).join("");
        if (!signature || usedSignatures.has(signature)) continue;

        const normalized = validateAndNormalizeQuestion(candidate, {
          mode,
          difficulty,
          usedWords,
        });
        if (!normalized) continue;

        usedSignatures.add(signature);
        finalQuestions.push(normalized);
      }
    }

    if (finalQuestions.length < 3) {
      return res.status(422).json({
        error: mode === "strict"
          ? "這個主題在嚴格模式下找不到足夠的合法注音題。建議改用「智慧延伸」或換一個較廣的主題。"
          : "搜尋後仍找不到足夠的合法注音題。請換一個較廣的主題再試。",
      });
    }

    return res.status(200).json({
      topic,
      difficulty,
      mode,
      requestedCount: count,
      generatedCount: finalQuestions.length,
      partial: finalQuestions.length < count,
      questions: finalQuestions,
      sources: Array.from(allSources.values()).slice(0, 12),
    });
  } catch (error) {
    console.error("AI topic generation failed:", error);
    const message = String(error?.message || "未知錯誤");

    if (/rate limit|429/i.test(message)) {
      return res.status(429).json({ error: "OpenAI API 暫時達到速率限制，請稍後再試。" });
    }
    if (/billing|quota|insufficient_quota/i.test(message)) {
      return res.status(402).json({ error: "OpenAI API 額度或付款設定不足，請檢查 API 平台的 Billing / Usage。" });
    }
    if (/api key|authentication|401/i.test(message)) {
      return res.status(500).json({ error: "OPENAI_API_KEY 無效或權限不足，請檢查部署平台的環境變數。" });
    }

    return res.status(500).json({
      error: "AI 題庫建立時發生錯誤。請檢查部署設定、API 額度或稍後重試。",
    });
  }
}
