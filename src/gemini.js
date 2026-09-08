import { config } from "./config.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

const PROBABILITY_DISCLAIMER =
  "upsideProbability/downsideRisk/confidenceは統計的に校正された確率ではなく、AIによる定性的な評価値です。";

function buildPrompt(feature) {
  // Geminiに渡すのは cutoffDate 以前のデータから計算した数値特徴量・財務情報・市場データのみ。
  // 未来の株価・ニュース・未公開の決算情報等は一切渡さない（データリーク防止）。
  const data = buildGeminiInputData(feature);
  return `あなたは日本株の銘柄評価を行うアシスタントです。
以下の数値データ（株価テクニカル指標・財務情報・市場全体との相対強度）だけをもとに、
この銘柄が「今後30営業日程度で上昇する可能性がどの程度あるか」を評価してください。
このデータは特定時点（cutoffDate = ${feature.cutoffDate ?? "不明"}）までに公開されていた情報のみです。
あなたは株価を直接予言する魔法のモデルではありません。断定的な投資助言（「必ず上がる」等）はせず、
あくまで傾向・リスクの定性的評価として答えてください。
upsideProbability等は統計的に校正された確率ではなく、あなたの定性的な評価値として出力してください。
financialsがnullの場合は、直近で開示されたデータが無い（または未検証のため取得できていない）ことを意味します。

データ:
${JSON.stringify(data, null, 2)}

以下のJSON形式で、JSON以外の文字を一切含めずに回答してください:
{
  "score": <0-100の総合スコア>,
  "upsideProbability": <0-100の上昇期待度（定性評価）>,
  "downsideRisk": <0-100の下落リスク（定性評価）>,
  "stance": "positive" | "neutral" | "negative",
  "reasoning": "<なぜその評価に至ったかの判断理由。2〜3文>",
  "summary": "<日本語で1〜2文の要約>",
  "positiveFactors": ["<ポジティブ要因>", ...],
  "negativeFactors": ["<ネガティブ要因>", ...],
  "confidence": <0-100の信頼度（定性評価）>
}`;
}

/**
 * Geminiに渡す入力データを整形する。null値も含めて明示的に渡すことで、
 * 「データが無いこと」自体をGeminiが誤解しないようにする。
 */
function buildGeminiInputData(feature) {
  return {
    code: feature.code,
    dataAsOf: feature.dataAsOf,
    price: feature.price,
    priceChange1d: feature.priceChange1d,
    priceChange5d: feature.priceChange5d,
    priceChange20d: feature.priceChange20d,
    volumeChange20d: feature.volumeChange20d,
    technicalIndicators: {
      sma5: feature.sma5,
      sma20: feature.sma20,
      ema12: feature.ema12,
      ema26: feature.ema26,
      rsi14: feature.rsi14,
      macd: feature.macd,
      macdSignal: feature.macdSignal,
      macdHistogram: feature.macdHistogram,
      bbUpper: feature.bbUpper,
      bbMiddle: feature.bbMiddle,
      bbLower: feature.bbLower,
      atr14: feature.atr14,
      volumeSma20: feature.volumeSma20,
      volatility20: feature.volatility20,
      fromHigh20dPct: feature.fromHigh20dPct,
      fromLow20dPct: feature.fromLow20dPct,
    },
    marketRelative: {
      relativeStrength20d: feature.relativeStrength20d,
    },
    financials: feature.financials
      ? {
          discDate: feature.financials.discDate,
          netSales: feature.financials.netSales,
          operatingProfit: feature.financials.operatingProfit,
          ordinaryProfit: feature.financials.ordinaryProfit,
          profit: feature.financials.profit,
          eps: feature.financials.eps,
          bps: feature.financials.bps,
          equityToAssetRatio: feature.financials.equityToAssetRatio,
        }
      : null,
  };
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
      price: feature.price, // バックテスト評価(30営業日後との比較)の起点となる、予測時点の終値
      ...parsed,
      disclaimer: PROBABILITY_DISCLAIMER,
      // 後から「どの時点で、どんな情報を使って、何を予測したのか」を完全に再現できるよう、
      // Geminiに実際に渡した入力データをそのまま保存する。
      usedFeatures: buildGeminiInputData(feature),
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
