import { config } from "./config.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

const PROBABILITY_DISCLAIMER =
  "upsideProbability/downsideRisk/confidenceは統計的に校正された確率ではなく、AIによる定性的な評価値です。";

function buildPrompt(feature) {
  // Geminiに渡すのは cutoffDate 以前のデータから計算した数値特徴量のみ。
  // 未来の株価・ニュース等は一切渡さない（データリーク防止）。
  return `あなたは日本株の銘柄評価を行うアシスタントです。
以下の数値データだけをもとに、この銘柄が「上昇候補としてどの程度魅力的か」を評価してください。
このデータは特定時点（cutoffDate = ${feature.cutoffDate ?? "不明"}）までの情報のみです。
断定的な投資助言（「必ず上がる」等）はせず、あくまで傾向・リスクの定性的評価として答えてください。
upsideProbability等は統計的に校正された確率ではなく、あなたの定性的な評価値として出力してください。

データ:
${JSON.stringify(
  {
    code: feature.code,
    dataAsOf: feature.dataAsOf,
    price: feature.price,
    priceChange1d: feature.priceChange1d,
    priceChange5d: feature.priceChange5d,
    priceChange20d: feature.priceChange20d,
    volumeChange20d: feature.volumeChange20d,
  },
  null,
  2
)}

以下のJSON形式で、JSON以外の文字を一切含めずに回答してください:
{
  "score": <0-100の総合スコア>,
  "upsideProbability": <0-100の上昇期待度（定性評価）>,
  "downsideRisk": <0-100の下落リスク（定性評価）>,
  "stance": "positive" | "neutral" | "negative",
  "summary": "<日本語で1〜2文の要約>",
  "positiveFactors": ["<ポジティブ要因>", ...],
  "negativeFactors": ["<ネガティブ要因>", ...],
  "confidence": <0-100の信頼度（定性評価）>
}`;
}

/**
 * Geminiの応答テキストから安全にJSONを取り出す。
 * コードブロック(```json ... ```)で囲まれているケースにも対応する。
 */
function safeParseJson(text) {
  if (!text) return null;
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/**
 * quota/レート制限に起因するエラーかどうかを判定する。
 * これらのエラーでは絶対にリトライ・モデル切替を行わない。
 */
function isQuotaOrRateLimitError(status, bodyText) {
  if (status === 429) return true;
  if (status === 403 && /quota|exceed/i.test(bodyText || "")) return true;
  return false;
}

/**
 * 1銘柄分の特徴量をGeminiに渡し、AI評価を取得する。
 *
 * 絶対条件:
 * - 429 / quota exceeded の場合は即座にその銘柄をスキップする（リトライしない）
 * - 有料モデルへの自動フォールバックは行わない
 * - 未来データは一切入力しない（cutoffDate以前の特徴量のみを渡す）
 *
 * @param {string} apiKey
 * @param {object} feature - cutoffDate, predictionExecutedAt を含む特徴量オブジェクト
 * @returns {object|null} 失敗時は null（呼び出し側で「AI分析なし」として扱う）
 */
export async function analyzeWithGemini(apiKey, feature) {
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY が設定されていません");
  }

  const url = `${API_BASE}/models/${config.GEMINI.model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: buildPrompt(feature) }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.GEMINI.timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      if (isQuotaOrRateLimitError(res.status, errText)) {
        // 無料枠の上限に達した。リトライ・モデル切替は一切行わず、この銘柄をスキップする。
        console.warn(
          `[gemini] 無料枠上限/レート制限 (${res.status}) — code=${feature.code} をスキップします（リトライしません）`
        );
        return null;
      }
      console.warn(`[gemini] APIエラー ${res.status} code=${feature.code} ${errText}`);
      return null;
    }

    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = safeParseJson(text);

    if (!parsed) {
      console.warn(`[gemini] JSON不正のためスキップ code=${feature.code}`);
      return null;
    }

    return {
      code: feature.code,
      cutoffDate: feature.cutoffDate,
      dataAsOf: feature.dataAsOf,
      predictionExecutedAt: feature.predictionExecutedAt,
      ...parsed,
      disclaimer: PROBABILITY_DISCLAIMER,
    };
  } catch (err) {
    console.warn(`[gemini] 呼び出し失敗 code=${feature.code}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 複数銘柄を順番にGemini分析する（並列にしすぎるとレート制限に当たりやすいため直列実行）。
 * 失敗した銘柄はスキップし、成功した銘柄だけを返す。
 *
 * @param {string} apiKey
 * @param {Array<object>} candidates - selectGeminiCandidates() の結果
 * @param {{ cutoffDate: string, predictionExecutedAt: string }} context
 */
export async function analyzeCandidates(apiKey, candidates, context) {
  const results = [];
  for (const candidate of candidates) {
    const feature = {
      ...candidate,
      cutoffDate: context.cutoffDate,
      predictionExecutedAt: context.predictionExecutedAt,
    };
    const result = await analyzeWithGemini(apiKey, feature);
    if (result) results.push(result);
  }
  return results;
}
