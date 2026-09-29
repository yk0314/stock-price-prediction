import { config } from "./config.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 1リクエスト=1銘柄が絶対条件。この関数は常に「単一の銘柄」のデータだけを整形する
 * （複数銘柄をまとめて渡す経路は本ファイルのどこにも存在しない）。
 * ここに含める項目は、Gemini自身に計算させる必要がない「既に自システム側で計算済みの数値」
 * だけに絞っている（生の株価系列そのものは渡さない）。
 */
function buildGeminiInputData(feature) {
  return {
    code: feature.code,
    name: feature.name ?? null,
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

const COMMON_RULES = (feature) => `
【重要・厳守事項】
このリクエストは銘柄コード ${feature.code} 1社のみを対象にしています。他の銘柄の情報は一切含まれていません。
- 以下の「データ」セクションに含まれる数値・情報だけを分析の主要な事実情報として扱ってください。
- 「データ」セクションに存在しない具体的な数値・事実（他の類似企業の実績、一般的な業界平均、記憶に基づく過去の株価等）を
  勝手に補完・創作して評価の根拠に使わないでください。分からない場合は保守的に評価してください。
- あなた自身の外部知識や記憶にある別の企業・別の銘柄コードの情報を、この銘柄の分析に混同させないでください。
- 出力する"code"は、必ず下記データの"code"の値をそのまま一字一句変更せずに返してください。
- 出力は指定されたJSON形式のみとし、説明文・前置き・Markdown装飾などは一切含めないでください。
  長い文章による理由説明は不要です（要求されたフィールドのみを返してください）。
- 断定的な投資助言（「必ず上がる」等）や利益の保証をする表現は使わないでください。
  expectedReturn/upsideProbability等は保証された数値ではなく、あなたの定性的な見通しとして出力してください。
`;

/**
 * 新規候補(保有していない銘柄)向けのプロンプト。
 * 「買う価値があるか」を最初に判定させ、価値が無ければ最小限の出力だけで済ませることで、
 * 不要な長文出力・不要なトークン消費を避ける。
 */
function buildNewCandidatePrompt(feature) {
  const data = buildGeminiInputData(feature);
  return `あなたは日本株の短期売買（数日〜1週間程度の保有）を支援するアシスタントです。
${COMMON_RULES(feature)}
この銘柄はまだ保有していません。以下の数値データだけをもとに、
「今後数日〜1週間程度（目安5営業日前後、長くても10営業日程度）で新規に買う価値があるか」を判定してください。
長期的に良い会社かどうかではなく、短期的な値動きの観点で判定してください。
このデータは特定時点（cutoffDate = ${feature.cutoffDate ?? "不明"}）までの情報のみです。
financialsがnullの場合は、直近で開示されたデータが無いことを意味します。

データ（銘柄コード ${feature.code} のみ）:
${JSON.stringify(data, null, 2)}

以下のJSON形式で回答してください（JSON以外の文字は一切含めないこと）。

買う価値が無いと判断した場合は、これだけを返してください:
{
  "code": "<上記データのcodeと完全に同一の値>",
  "tradeable": false
}

買う価値があると判断した場合は、これを返してください（tradeableな場合、decisionは常に"BUY"にしてください。
まだ保有していない銘柄なので"HOLD"や"SELL"は使わないでください）:
{
  "code": "<上記データのcodeと完全に同一の値>",
  "tradeable": true,
  "decision": "BUY",
  "score": <0-100の総合スコア。短期的な上昇候補としての魅力度>,
  "risk": "LOW" | "MEDIUM" | "HIGH",
  "expectedReturn": <想定される数日〜1週間程度での上昇率(%)>,
  "expectedHoldingDays": <想定保有日数の目安。1〜10程度の整数>,
  "upsideProbability": <0-100の上昇期待度（定性評価）>,
  "downsideRisk": <0-100の下落リスク（定性評価）>,
  "confidence": <0-100の信頼度（定性評価）>
}`;
}

/**
 * 保有銘柄の再評価向けのプロンプト。
 * 通常のスクリーニング結果に関わらず必ず評価されるため、「買う価値があるか」の足切りは行わず、
 * 常にBUY(増し玉検討)/HOLD(様子見)/SELL(売却検討)のいずれかで評価する。
 */
function buildHeldCandidatePrompt(feature) {
  const data = buildGeminiInputData(feature);
  return `あなたは日本株の短期売買（数日〜1週間程度の保有）を支援するアシスタントです。
${COMMON_RULES(feature)}
この銘柄は既に保有中です。以下の数値データだけをもとに、今後数日〜1週間程度の見通しで
「このまま保有を続けるべきか(HOLD)、増し玉を検討してよいか(BUY)、売却を検討すべきか(SELL)」を評価してください。
このデータは特定時点（cutoffDate = ${feature.cutoffDate ?? "不明"}）までの情報のみです。
financialsがnullの場合は、直近で開示されたデータが無いことを意味します。

データ（銘柄コード ${feature.code} のみ）:
${JSON.stringify(data, null, 2)}

以下のJSON形式で、JSON以外の文字を一切含めずに回答してください:
{
  "code": "<上記データのcodeと完全に同一の値>",
  "decision": "BUY" | "HOLD" | "SELL",
  "score": <0-100の総合スコア>,
  "risk": "LOW" | "MEDIUM" | "HIGH",
  "expectedReturn": <想定される数日〜1週間程度での騰落率(%)。下落見込みなら負の数>,
  "expectedHoldingDays": <想定される追加保有日数の目安。1〜10程度の整数>,
  "upsideProbability": <0-100の上昇期待度（定性評価）>,
  "downsideRisk": <0-100の下落リスク（定性評価）>,
  "confidence": <0-100の信頼度（定性評価）>
}`;
}

function buildPrompt(feature) {
  return feature.isHeld ? buildHeldCandidatePrompt(feature) : buildNewCandidatePrompt(feature);
}

/**
 * decision(またはrating)を正規化する。"decision"を優先して読み、無ければ後方互換で
 * "rating"、さらに古い"stance"の順に見る。想定外の値は安全側に倒してHOLDにする。
 * （既存の評価基準そのものは変更していない）
 */
export function normalizeRating(parsed) {
  const raw = String(parsed?.decision ?? parsed?.rating ?? "").toUpperCase();
  if (raw === "BUY" || raw === "HOLD" || raw === "SELL") return raw;

  const stance = String(parsed?.stance ?? "").toLowerCase();
  if (stance === "positive") return "BUY";
  if (stance === "negative") return "SELL";
  if (stance === "neutral") return "HOLD";
  return "HOLD";
}

/**
 * riskを正規化する。Geminiが"risk"を返さなかった場合は、
 * downsideRisk(0-100)の値から3段階に変換する。
 * （既存の評価基準そのものは変更していない）
 */
export function normalizeRisk(parsed) {
  const raw = String(parsed?.risk ?? "").toUpperCase();
  if (raw === "LOW" || raw === "MEDIUM" || raw === "HIGH") return raw;

  const downside = parsed?.downsideRisk;
  if (typeof downside === "number") {
    if (downside >= 60) return "HIGH";
    if (downside >= 35) return "MEDIUM";
    return "LOW";
  }
  return "MEDIUM";
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
 * Geminiの出力が「この銘柄についての、壊れていない分析結果」と言えるかを機械的に検証する。
 * ここでの目的は「予測が当たっているか」ではなく「要求した銘柄のデータを正しく分析できているか」。
 *
 * @returns {{ errors: string[], excluded: boolean }}
 *   errors: 空配列なら検証OK。1件以上あれば不正な出力として扱い、D1へは保存しない。
 *   excluded: true の場合、新規候補が「買う価値なし(tradeable:false)」と判定されたことを示す。
 *             これはエラーではなく正常な判定結果だが、通常の分析結果としてD1へは保存しない。
 */
export function validateGeminiOutput(parsed, feature) {
  const errors = [];

  if (!parsed || typeof parsed !== "object") {
    errors.push("JSONとして解釈できない、または空の応答");
    return { errors, excluded: false };
  }

  // 銘柄コード: 返ってきた場合は、必ずリクエストしたコードと完全一致していること。
  if (parsed.code !== undefined && parsed.code !== null && String(parsed.code) !== String(feature.code)) {
    errors.push(`銘柄コード不一致: 要求=${feature.code} 応答=${parsed.code}`);
    return { errors, excluded: false };
  }

  // 保有していない新規候補は「買う価値があるか」の判定を先に見る。
  if (!feature.isHeld) {
    if (parsed.tradeable === false) {
      // 買う価値なし: これ以上の項目チェックは不要。正常な除外として扱う。
      return { errors: [], excluded: true };
    }
    if (parsed.tradeable !== true) {
      errors.push(`tradeableが不正または未指定: ${JSON.stringify(parsed.tradeable)}`);
      return { errors, excluded: false };
    }
  }

  // スコア: 数値かつ0-100の範囲内であること（既存仕様の範囲を維持）。
  if (typeof parsed.score !== "number" || Number.isNaN(parsed.score) || parsed.score < 0 || parsed.score > 100) {
    errors.push(`scoreが不正: ${JSON.stringify(parsed.score)}`);
  }

  // decision/rating: BUY/HOLD/SELLのいずれかであること。
  const rawDecision = String(parsed.decision ?? parsed.rating ?? "").toUpperCase();
  if (!["BUY", "HOLD", "SELL"].includes(rawDecision)) {
    errors.push(`decision(rating)が不正: ${JSON.stringify(parsed.decision ?? parsed.rating)}`);
  }
  // 新規候補(保有していない)でtradeable:trueの場合は、意味的にBUY以外はおかしい
  // (保有していないものをHOLD/SELLするのは意味が曖昧なため)。壊れているとまでは言えないので
  // エラーにはせず、BUYへ寄せて扱う(normalizeRating側でも最終的にBUY/HOLD/SELLへ丸める)。

  return { errors, excluded: false };
}

function isRetryableStatus(status) {
  return status === 429 || status === 503;
}

/**
 * 429応答のbody(JSON文字列)から、可能な範囲でクォータ関連の情報を抽出する。
 * 取得できない項目は無理に推測せずnullのままにする。
 * APIキー等の機密情報はここでは一切扱わない(bodyにも含まれない)。
 */
function extractQuotaDetails(errText) {
  try {
    const parsed = JSON.parse(errText);
    const status = parsed?.error?.status ?? null;
    const message = parsed?.error?.message ?? null;
    const details = Array.isArray(parsed?.error?.details) ? parsed.error.details : [];
    const quotaFailure = details.find((d) => typeof d?.["@type"] === "string" && d["@type"].includes("QuotaFailure"));
    const violations = quotaFailure?.violations?.map((v) => ({
      quotaMetric: v.quotaMetric ?? null,
      quotaId: v.quotaId ?? null,
    })) ?? [];
    return { status, message, violations: violations.length > 0 ? violations : null };
  } catch {
    return null;
  }
}

/**
 * Retry-Afterヘッダ（秒数、またはHTTP-date）をmsに変換する。取得できなければnull。
 */
function parseRetryAfterMs(retryAfterHeader) {
  if (!retryAfterHeader) return null;
  const asSeconds = Number(retryAfterHeader);
  if (Number.isFinite(asSeconds) && asSeconds > 0) return Math.round(asSeconds * 1000);
  const asDate = Date.parse(retryAfterHeader);
  if (!Number.isNaN(asDate)) {
    const diff = asDate - Date.now();
    if (diff > 0) return diff;
  }
  return null;
}

/**
 * 429用のバックオフ時間を決める。Retry-Afterがあれば最優先、無ければ
 * config.GEMINI.backoff429Ms(固定値)を使う。503のような指数的な増加はしない
 * （429はレート制限であり、時間経過そのものが解消条件のため、試行回数に応じて
 *  無制限に伸ばす必要はないという判断。ただしRetry-Afterがあれば必ずそちらに従う）。
 */
function compute429BackoffMs(retryAfterHeader) {
  return parseRetryAfterMs(retryAfterHeader) ?? config.GEMINI.backoff429Ms;
}

/**
 * 503用のバックオフ時間を決める。Retry-Afterがあればそれを優先し、無ければ
 * 試行回数に応じた指数バックオフ(retryBackoffBaseMs × 2^(attempt-1))を使う。
 */
function compute503BackoffMs(attempt, retryAfterHeader) {
  return parseRetryAfterMs(retryAfterHeader) ?? config.GEMINI.retryBackoffBaseMs * 2 ** (attempt - 1);
}

/**
 * 1銘柄分の特徴量をGeminiに渡し、AI評価を取得する（1リクエスト=1銘柄。絶対に複数銘柄をまとめない）。
 *
 * 429と503は別々の統計・別々のバックオフ方式で扱う:
 * - 429: Retry-Afterがあればそれを優先、無ければconfig.GEMINI.backoff429Ms(固定値)
 * - 503: Retry-Afterがあればそれを優先、無ければ指数バックオフ(retryBackoffBaseMs基準)
 * どちらもconfig.GEMINI.maxRetriesを上限に、無限リトライはしない。
 * 429/503以外のHTTPエラーはリトライ対象外として即座に失敗扱いにする。
 *
 * @param {string} apiKey
 * @param {object} feature - cutoffDate, predictionExecutedAt, isHeld, (可能なら)name を含む特徴量オブジェクト
 * @returns {{
 *   result: object|null,
 *   success: boolean,
 *   excluded: boolean,        // 新規候補が"買う価値なし"と判定された場合true(エラーではない)
 *   code: string,
 *   attempts: number,
 *   statusCounts: {status429: number, status503: number, otherError: number},
 *   lastError: {status:number|null, message:string, quotaDetails?:object|null}|null,
 *   validationErrors: string[],
 * }}
 */
export async function analyzeWithGemini(apiKey, feature) {
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY が設定されていません");
  }

  const maxAttempts = 1 + Math.max(0, config.GEMINI.maxRetries);
  const statusCounts = { status429: 0, status503: 0, otherError: 0 };
  let attempts = 0;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    const requestStartedAt = new Date().toISOString();

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
        const retryAfterHeader = res.headers.get("retry-after");
        const quotaDetails = res.status === 429 ? extractQuotaDetails(errText) : null;

        if (res.status === 429) statusCounts.status429++;
        else if (res.status === 503) statusCounts.status503++;
        else statusCounts.otherError++;
        lastError = { status: res.status, message: errText.slice(0, 500), quotaDetails };

        // APIキーは絶対にログへ出さない(url自体をログに出さないことで担保する)。
        console.warn(
          `[gemini] HTTP ${res.status} code=${feature.code} model=${config.GEMINI.model} ` +
            `attempt=${attempt}/${maxAttempts} at=${requestStartedAt} retryAfter=${retryAfterHeader ?? "-"} ` +
            `quota=${quotaDetails ? JSON.stringify(quotaDetails) : "-"}`
        );

        const retryable = isRetryableStatus(res.status);
        if (!retryable || attempt >= maxAttempts) {
          console.warn(
            `[gemini] code=${feature.code} — ${retryable ? "リトライ上限に達した" : "リトライ対象外"}ため失敗扱い`
          );
          return {
            result: null,
            success: false,
            excluded: false,
            code: feature.code,
            attempts,
            statusCounts,
            lastError,
            validationErrors: [],
          };
        }

        const backoffMs =
          res.status === 429 ? compute429BackoffMs(retryAfterHeader) : compute503BackoffMs(attempt, retryAfterHeader);
        console.warn(`[gemini] code=${feature.code} — ${backoffMs}ms待機して再試行(${res.status})`);
        await sleep(backoffMs);
        continue;
      }

      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      const parsed = safeParseJson(text);
      // 取得できる場合のみ、入出力トークン数を記録する(429/TPM関連の原因調査用)。無ければnullのまま。
      const usage = {
        promptTokens: json?.usageMetadata?.promptTokenCount ?? null,
        outputTokens: json?.usageMetadata?.candidatesTokenCount ?? null,
      };

      const { errors: validationErrors, excluded } = validateGeminiOutput(parsed, feature);

      if (excluded) {
        console.log(`[gemini] code=${feature.code} tradeable=false（買う価値なしと判定、D1には保存しない）`);
        return {
          result: null,
          success: false,
          excluded: true,
          code: feature.code,
          attempts,
          statusCounts,
          lastError: null,
          validationErrors: [],
          usage,
        };
      }

      if (validationErrors.length > 0) {
        console.warn(`[gemini] 出力検証エラー code=${feature.code}: ${validationErrors.join(" / ")}`);
        return {
          result: null,
          success: false,
          excluded: false,
          code: feature.code,
          attempts,
          statusCounts,
          lastError: { status: res.status, message: validationErrors.join(" / ") },
          validationErrors,
        };
      }

      // 検証を通過した結果を組み立てる。
      // 【重要】code/price/cutoffDate/dataAsOf/predictionExecutedAtは、Geminiの応答内容に関わらず
      // 必ずこちらが渡した信頼できる値で上書きする（...parsedを先に展開し、後から上書きする順序にすることで、
      // 仮にGeminiがこれらのキーを勝手に含めて返してきても、他銘柄の値混入や改変を防ぐ）。
      // 長文のsummary/reasoning/positiveFactors/negativeFactorsはもう要求していないため、
      // 応答に含まれていなければ既存のD1カラム/UI表示は従来通りnull/空配列のまま(後方互換)。
      const result = {
        ...parsed,
        code: feature.code,
        cutoffDate: feature.cutoffDate,
        dataAsOf: feature.dataAsOf,
        predictionExecutedAt: feature.predictionExecutedAt,
        price: feature.price,
        rating: normalizeRating(parsed),
        risk: normalizeRisk(parsed),
        expectedReturn: typeof parsed.expectedReturn === "number" ? parsed.expectedReturn : null,
        expectedHoldingDays: typeof parsed.expectedHoldingDays === "number" ? parsed.expectedHoldingDays : null,
        summary: null,
        reasoning: null,
        positiveFactors: [],
        negativeFactors: [],
        usedFeatures: buildGeminiInputData(feature),
      };

      return {
        result,
        success: true,
        excluded: false,
        code: feature.code,
        attempts,
        statusCounts,
        lastError: null,
        validationErrors: [],
        usage,
      };
    } catch (err) {
      statusCounts.otherError++;
      lastError = { status: null, message: err.message };
      if (attempt >= maxAttempts) {
        console.warn(`[gemini] 呼び出し失敗 code=${feature.code}: ${err.message}`);
        return {
          result: null,
          success: false,
          excluded: false,
          code: feature.code,
          attempts,
          statusCounts,
          lastError,
          validationErrors: [],
        };
      }
      const backoffMs = config.GEMINI.retryBackoffBaseMs * 2 ** (attempt - 1);
      console.warn(`[gemini] 呼び出し失敗 code=${feature.code} attempt=${attempt}/${maxAttempts}: ${err.message} — ${backoffMs}ms待機して再試行`);
      await sleep(backoffMs);
      continue;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    result: null,
    success: false,
    excluded: false,
    code: feature.code,
    attempts,
    statusCounts,
    lastError,
    validationErrors: [],
  };
}

/**
 * 複数銘柄を、必ず「1リクエスト=1銘柄」で順番にGemini分析する。
 * 複数銘柄を1回のリクエストにまとめることは絶対に行わない。
 *
 * - candidatesは呼び出し側(pipeline.js)で「保有銘柄が先、新規候補が後」の順に並べ、
 *   かつ重複が無いようにしてから渡すこと（この関数自体は渡された順番通りに処理するだけ）。
 * - 銘柄間には config.GEMINI.requestIntervalMs の待機を挟む（最後の銘柄の後は待機しない）。
 * - config.GEMINI.dailyRequestLimit（通常分析+リトライの合計リクエスト数）に達したら、
 *   残りの銘柄の分析には着手せず安全に打ち切る。
 * - 429が config.GEMINI.consecutive429Limit 回連続したら、"Gemini rate limit detected,
 *   stopping safely" のログを出してその回のGemini処理を安全停止する。成功(または買う価値なし
 *   判定による除外)があれば連続カウントは0に戻る。単発の429では停止しない。
 * - 1銘柄の失敗（検証エラー・除外含む）で処理全体を中断しない。
 * - onCandidateComplete が渡された場合、各銘柄の処理結果を都度通知する
 *   （呼び出し側でD1のerror_logsへの記録や、成功結果の即時D1保存に使うためのフック）。
 *
 * @returns {Promise<Array<object>>} 成功した分析結果の配列（tradeable:falseの除外分は含まない）
 */
export async function analyzeCandidates(apiKey, candidates, context, hooks = {}) {
  const { onCandidateComplete } = hooks;
  const startedAt = Date.now();
  const total = candidates.length;

  const results = [];
  let successCount = 0;
  let failedCount = 0;
  let excludedCount = 0;
  let retriedCount = 0;
  let status429Total = 0;
  let status503Total = 0;
  let totalRequestsMade = 0;
  let consecutive429Count = 0;
  let stoppedForConsecutive429 = false;
  let stoppedEarlyForDailyLimit = false;

  console.log(`[Gemini] total=${total} 件を1銘柄1リクエストで処理開始（保有銘柄優先の順で渡されている前提）`);

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const index = i + 1;

    if (totalRequestsMade >= config.GEMINI.dailyRequestLimit) {
      stoppedEarlyForDailyLimit = true;
      console.warn(
        `[Gemini] 1日のリクエスト上限(${config.GEMINI.dailyRequestLimit}件)に達したため、残り${total - i}銘柄の分析を打ち切ります`
      );
      break;
    }

    const feature = {
      ...candidate,
      cutoffDate: context.cutoffDate,
      predictionExecutedAt: context.predictionExecutedAt,
    };

    console.log(`[Gemini] ${index}/${total} code=${feature.code} isHeld=${!!feature.isHeld} start`);
    const outcome = await analyzeWithGemini(apiKey, feature);

    totalRequestsMade += outcome.attempts;
    status429Total += outcome.statusCounts.status429;
    status503Total += outcome.statusCounts.status503;
    if (outcome.attempts > 1) retriedCount++;

    // 連続429カウンタ更新: 429が起きた分だけ加算。成功または除外(=正常応答)ならリセット。
    consecutive429Count += outcome.statusCounts.status429;
    if (outcome.success || outcome.excluded) {
      consecutive429Count = 0;
    }

    if (outcome.excluded) {
      excludedCount++;
      console.log(
        `[Gemini] ${index}/${total} code=${feature.code} excluded (tradeable=false)` +
          (outcome.usage?.promptTokens != null ? ` tokens(in=${outcome.usage.promptTokens}, out=${outcome.usage.outputTokens})` : "")
      );
    } else if (outcome.success) {
      successCount++;
      results.push(outcome.result);
      console.log(
        `[Gemini] ${index}/${total} code=${feature.code} success` +
          (outcome.usage?.promptTokens != null ? ` tokens(in=${outcome.usage.promptTokens}, out=${outcome.usage.outputTokens})` : "")
      );
    } else {
      failedCount++;
      console.log(
        `[Gemini] ${index}/${total} code=${feature.code} failed (attempts=${outcome.attempts}, status=${outcome.lastError?.status ?? "n/a"})`
      );
    }

    if (onCandidateComplete) {
      try {
        await onCandidateComplete(outcome);
      } catch (err) {
        console.warn(`[Gemini] onCandidateCompleteフックでエラー code=${feature.code}: ${err.message}`);
      }
    }

    if (consecutive429Count >= config.GEMINI.consecutive429Limit) {
      stoppedForConsecutive429 = true;
      console.warn(
        `[Gemini] Gemini rate limit detected, stopping safely (連続429=${consecutive429Count}回、上限=${config.GEMINI.consecutive429Limit})`
      );
      break;
    }

    const isLast = i === candidates.length - 1;
    if (!isLast && totalRequestsMade < config.GEMINI.dailyRequestLimit) {
      console.log(`[Gemini] waiting ${Math.round(config.GEMINI.requestIntervalMs / 1000)}s`);
      await sleep(config.GEMINI.requestIntervalMs);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[Gemini] total=${total} success=${successCount} failed=${failedCount} excluded=${excludedCount} ` +
      `retried=${retriedCount} 429=${status429Total} 503=${status503Total} requestsMade=${totalRequestsMade} ` +
      `consecutive429Stop=${stoppedForConsecutive429} dailyLimitReached=${stoppedEarlyForDailyLimit} ` +
      `elapsed=${Math.round(elapsedMs / 1000)}s`
  );

  return results;
}
