import { config } from "./config.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

const PROBABILITY_DISCLAIMER =
  "upsideProbability/downsideRisk/confidenceは統計的に校正された確率ではなく、AIによる定性的な評価値です。";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 1リクエスト=1銘柄が絶対条件。この関数は常に「単一の銘柄」のデータだけを整形する
 * （複数銘柄をまとめて渡す経路は本ファイルのどこにも存在しない）。
 * nameを渡せる場合は、Geminiが出力に企業名を含める際の突き合わせ材料として使う。
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

function buildPrompt(feature) {
  // Geminiに渡すのは cutoffDate 以前のデータから計算した数値特徴量・財務情報・市場データのみ。
  // 未来の株価・ニュース・未公開の決算情報等は一切渡さない（データリーク防止）。
  const data = buildGeminiInputData(feature);
  return `あなたは日本株の短期売買（数日〜1週間程度の保有）を支援するアシスタントです。

【重要・厳守事項】
このリクエストは銘柄コード ${feature.code} 1社のみを対象にしています。他の銘柄の情報は一切含まれていません。
- 以下の「データ」セクションに含まれる数値・情報だけを分析の主要な事実情報として扱ってください。
- 「データ」セクションに存在しない具体的な数値・事実（他の類似企業の実績、一般的な業界平均、記憶に基づく過去の株価等）を
  勝手に補完・創作して評価の根拠に使わないでください。分からない場合は「データ不足」として保守的に評価してください。
- あなた自身の外部知識や記憶にある別の企業・別の銘柄コードの情報を、この銘柄の分析に混同させないでください。
- 出力する"code"は、必ず下記データの"code"の値をそのまま一字一句変更せずに返してください。

以下の数値データ（株価テクニカル指標・財務情報・市場全体との相対強度）だけをもとに、
「この銘柄を今買った場合、今後数日〜1週間程度（目安5営業日前後、長くても10営業日程度）で
上昇する可能性がどの程度あるか」を評価してください。
長期的に良い会社かどうかではなく、短期的な値動きの観点で評価することを重視してください。
このデータは特定時点（cutoffDate = ${feature.cutoffDate ?? "不明"}）までに公開されていた情報のみです。
あなたは株価を直接予言する魔法のモデルではありません。断定的な投資助言（「必ず上がる」等）や
利益の保証をする表現は絶対に使わず、あくまで傾向・リスクの定性的評価として答えてください。
upsideProbability/expectedReturn等は統計的に校正された確率・保証された数値ではなく、
あなたの定性的な見通しとして出力してください。
financialsがnullの場合は、直近で開示されたデータが無い（または未検証のため取得できていない）ことを意味します。

データ（銘柄コード ${feature.code} のみ）:
${JSON.stringify(data, null, 2)}

以下のJSON形式で、JSON以外の文字を一切含めずに回答してください:
{
  "code": "<上記データのcodeと完全に同一の値>",
  "score": <0-100の総合スコア。短期的な上昇候補としての魅力度>,
  "rating": "BUY" | "HOLD" | "SELL",
  "expectedReturn": <想定される数日〜1週間程度での上昇率(%)。下落見込みなら負の数>,
  "expectedHoldingDays": <想定保有日数の目安。1〜10程度の整数>,
  "risk": "LOW" | "MEDIUM" | "HIGH",
  "upsideProbability": <0-100の上昇期待度（定性評価）>,
  "downsideRisk": <0-100の下落リスク（定性評価）>,
  "stance": "positive" | "neutral" | "negative",
  "reasoning": "<なぜその評価に至ったかの判断理由。2〜3文。上記データに基づく根拠のみを述べること>",
  "summary": "<日本語で1〜2文の要約>",
  "positiveFactors": ["<ポジティブ要因>", ...],
  "negativeFactors": ["<ネガティブ要因>", ...],
  "confidence": <0-100の信頼度（定性評価）>
}`;
}

/**
 * ratingを正規化する。Geminiが"rating"を返さなかった場合は、
 * 既存の"stance"から変換する（後方互換のため）。
 * 想定外の値は安全側に倒して"HOLD"にする。
 * （既存の評価基準そのものは変更していない）
 */
export function normalizeRating(parsed) {
  const raw = String(parsed?.rating ?? "").toUpperCase();
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
 * 検証に落ちた場合は理由の配列を返す（空配列 = 検証OK）。
 * rating/riskそのものの正規化ロジック(normalizeRating/normalizeRisk)は変更せず、
 * ここでは「明らかに壊れている・別銘柄が混入している」ケースだけを弾く。
 */
export function validateGeminiOutput(parsed, feature) {
  const errors = [];

  if (!parsed || typeof parsed !== "object") {
    errors.push("JSONとして解釈できない、または空の応答");
    return errors;
  }

  // 銘柄コード: 返ってきた場合は、必ずリクエストしたコードと完全一致していること。
  // 一致しない場合は、別銘柄のデータが混入した疑いがあるため正常分析として扱わない。
  if (parsed.code !== undefined && parsed.code !== null && String(parsed.code) !== String(feature.code)) {
    errors.push(`銘柄コード不一致: 要求=${feature.code} 応答=${parsed.code}`);
  }

  // スコア: 数値かつ0-100の範囲内であること（既存仕様の範囲を維持）。
  if (typeof parsed.score !== "number" || Number.isNaN(parsed.score) || parsed.score < 0 || parsed.score > 100) {
    errors.push(`scoreが不正: ${JSON.stringify(parsed.score)}`);
  }

  // rating: 値が明示的に返ってきている場合のみ検証する。
  // 未指定(undefined)はnormalizeRatingが既存仕様通りstance等から補完するため許容する。
  if (parsed.rating !== undefined && parsed.rating !== null) {
    const raw = String(parsed.rating).toUpperCase();
    if (!["BUY", "HOLD", "SELL"].includes(raw)) {
      errors.push(`ratingが不正: ${JSON.stringify(parsed.rating)}`);
    }
  }

  // 要約・判断理由のいずれも無ければ、実質的に中身のない応答とみなす。
  if (!parsed.summary && !parsed.reasoning) {
    errors.push("summary/reasoningが両方とも欠落");
  }

  return errors;
}

/**
 * 入力データの企業名(name)と、Gemini出力に含まれるnameが明らかに矛盾していないかを確認する。
 * 表記ゆれ（全角/半角・法人格の有無等）に弱いため、これは"明らかな矛盾"だけを検出する
 * ゆるいチェックとし、これ単体では分析結果を不正扱いにしない（警告ログのみ）。
 */
function checkNameConsistency(parsed, feature) {
  if (!feature.name || !parsed?.name) return true; // 突き合わせ材料が無ければスキップ
  const normalize = (s) =>
    String(s)
      .replace(/[\s　株式会社㈱]/g, "")
      .toLowerCase();
  const a = normalize(feature.name);
  const b = normalize(parsed.name);
  if (!a || !b) return true;
  return a.includes(b) || b.includes(a);
}

/**
 * quota/レート制限・一時的エラーに起因するステータスかどうかを判定する。
 */
function isRetryableStatus(status) {
  return status === 429 || status === 503;
}

function isQuotaOrRateLimitError(status, bodyText) {
  if (status === 429) return true;
  if (status === 403 && /quota|exceed/i.test(bodyText || "")) return true;
  return false;
}

/**
 * Retry-Afterヘッダ（秒数、またはHTTP-date）があればそれを優先し、無ければ
 * 試行回数に応じた指数バックオフ(retryBackoffBaseMs × 2^(attempt-1))を使う。
 */
function computeBackoffMs(attempt, retryAfterHeader) {
  if (retryAfterHeader) {
    const asSeconds = Number(retryAfterHeader);
    if (Number.isFinite(asSeconds) && asSeconds > 0) {
      return Math.round(asSeconds * 1000);
    }
    const asDate = Date.parse(retryAfterHeader);
    if (!Number.isNaN(asDate)) {
      const diff = asDate - Date.now();
      if (diff > 0) return diff;
    }
  }
  return config.GEMINI.retryBackoffBaseMs * 2 ** (attempt - 1);
}

/**
 * 1銘柄分の特徴量をGeminiに渡し、AI評価を取得する（1リクエスト=1銘柄。絶対に複数銘柄をまとめない）。
 *
 * 429/503等の一時的エラーは config.GEMINI.maxRetries を上限に、バックオフを挟んでリトライする
 * （無限リトライはしない。上限に達したらその銘柄は失敗として扱う）。
 * quota超過(429)でリトライ上限に達した場合も、有料モデルへの自動フォールバックは行わない。
 *
 * @param {string} apiKey
 * @param {object} feature - cutoffDate, predictionExecutedAt, (可能なら)name を含む特徴量オブジェクト
 * @returns {{
 *   result: object|null,       // 成功時のみ非null（既存のD1保存等が期待する形）
 *   success: boolean,
 *   code: string,
 *   attempts: number,          // 実際に行われたHTTPリクエスト回数
 *   statusCounts: {status429: number, status503: number, otherError: number},
 *   lastError: {status:number, message:string}|null,
 *   validationErrors: string[],
 *   nameConsistent: boolean,
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
        if (res.status === 429) statusCounts.status429++;
        else if (res.status === 503) statusCounts.status503++;
        else statusCounts.otherError++;
        lastError = { status: res.status, message: errText.slice(0, 500) };

        const retryable = isRetryableStatus(res.status);
        if (!retryable) {
          // 429/503以外のエラーはリトライ対象外として即座に失敗扱いにする
          console.warn(`[gemini] APIエラー ${res.status} code=${feature.code} ${errText}`);
          return {
            result: null,
            success: false,
            code: feature.code,
            attempts,
            statusCounts,
            lastError,
            validationErrors: [],
            nameConsistent: true,
          };
        }

        if (attempt >= maxAttempts) {
          console.warn(
            `[gemini] ${res.status} code=${feature.code} attempt=${attempt}/${maxAttempts} — リトライ上限に達したため失敗扱い`
          );
          return {
            result: null,
            success: false,
            code: feature.code,
            attempts,
            statusCounts,
            lastError,
            validationErrors: [],
            nameConsistent: true,
          };
        }

        const backoffMs = computeBackoffMs(attempt, res.headers.get("retry-after"));
        console.warn(
          `[gemini] ${res.status} code=${feature.code} attempt=${attempt}/${maxAttempts} — ${backoffMs}ms待機して再試行`
        );
        await sleep(backoffMs);
        continue;
      }

      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      const parsed = safeParseJson(text);

      const validationErrors = validateGeminiOutput(parsed, feature);
      const nameConsistent = checkNameConsistency(parsed, feature);
      if (!nameConsistent) {
        console.warn(
          `[gemini] 企業名の不一致(参考情報のみ、失敗扱いにはしない) code=${feature.code} 入力=${feature.name} 応答=${parsed?.name}`
        );
      }

      if (validationErrors.length > 0) {
        console.warn(`[gemini] 出力検証エラー code=${feature.code}: ${validationErrors.join(" / ")}`);
        return {
          result: null,
          success: false,
          code: feature.code,
          attempts,
          statusCounts,
          lastError: { status: res.status, message: validationErrors.join(" / ") },
          validationErrors,
          nameConsistent,
        };
      }

      // 検証を通過した結果を組み立てる。
      // 【重要】code/price/cutoffDate/dataAsOf/predictionExecutedAtは、Geminiの応答内容に関わらず
      // 必ずこちらが渡した信頼できる値で上書きする（...parsedを先に展開し、後から上書きする順序にすることで、
      // 仮にGeminiがこれらのキーを勝手に含めて返してきても、他銘柄の値混入や改変を防ぐ）。
      const result = {
        ...parsed,
        code: feature.code,
        cutoffDate: feature.cutoffDate,
        dataAsOf: feature.dataAsOf,
        predictionExecutedAt: feature.predictionExecutedAt,
        price: feature.price, // バックテスト評価(30営業日後との比較)の起点となる、予測時点の終値
        rating: normalizeRating(parsed),
        risk: normalizeRisk(parsed),
        expectedReturn: typeof parsed.expectedReturn === "number" ? parsed.expectedReturn : null,
        expectedHoldingDays: typeof parsed.expectedHoldingDays === "number" ? parsed.expectedHoldingDays : null,
        disclaimer: PROBABILITY_DISCLAIMER,
        // 後から「どの時点で、どんな情報を使って、何を予測したのか」を完全に再現できるよう、
        // Geminiに実際に渡した入力データをそのまま保存する。
        usedFeatures: buildGeminiInputData(feature),
      };

      return {
        result,
        success: true,
        code: feature.code,
        attempts,
        statusCounts,
        lastError: null,
        validationErrors: [],
        nameConsistent,
      };
    } catch (err) {
      statusCounts.otherError++;
      lastError = { status: null, message: err.message };
      // タイムアウト・ネットワークエラーはリトライ対象に含める（無制限にはしない）。
      if (attempt >= maxAttempts) {
        console.warn(`[gemini] 呼び出し失敗 code=${feature.code}: ${err.message}`);
        return {
          result: null,
          success: false,
          code: feature.code,
          attempts,
          statusCounts,
          lastError,
          validationErrors: [],
          nameConsistent: true,
        };
      }
      const backoffMs = computeBackoffMs(attempt, null);
      console.warn(
        `[gemini] 呼び出し失敗 code=${feature.code} attempt=${attempt}/${maxAttempts}: ${err.message} — ${backoffMs}ms待機して再試行`
      );
      await sleep(backoffMs);
      continue;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ここには到達しないはずだが、念のため安全側のフォールバックを返す。
  return {
    result: null,
    success: false,
    code: feature.code,
    attempts,
    statusCounts,
    lastError,
    validationErrors: [],
    nameConsistent: true,
  };
}

/**
 * 複数銘柄を、必ず「1リクエスト=1銘柄」で順番にGemini分析する。
 * 複数銘柄を1回のリクエストにまとめることは絶対に行わない。
 *
 * - 銘柄間には config.GEMINI.requestIntervalMs の待機を挟む（最後の銘柄の後は待機しない）。
 * - config.GEMINI.dailyRequestLimit（通常分析+リトライの合計リクエスト数）に達したら、
 *   残りの銘柄の分析には着手せず安全に打ち切る（パイプライン自体は継続する）。
 * - 1銘柄の失敗（検証エラー含む）で処理全体を中断しない。
 * - onCandidateComplete が渡された場合、各銘柄の処理結果（成功/失敗問わず）を都度通知する
 *   （呼び出し側でD1のerror_logsへの記録や、成功結果の即時D1保存に使うためのフック）。
 *
 * @param {string} apiKey
 * @param {Array<object>} candidates - selectGeminiCandidates() 等の結果
 * @param {{ cutoffDate: string, predictionExecutedAt: string }} context
 * @param {{ onCandidateComplete?: (outcome: object) => (void|Promise<void>) }} [hooks]
 * @returns {Promise<Array<object>>} 成功した分析結果の配列（既存の呼び出し側と同じ戻り値の形）
 */
export async function analyzeCandidates(apiKey, candidates, context, hooks = {}) {
  const { onCandidateComplete } = hooks;
  const startedAt = Date.now();
  const total = candidates.length;

  const results = [];
  let successCount = 0;
  let failedCount = 0;
  let retriedCount = 0;
  let status429Total = 0;
  let status503Total = 0;
  let totalRequestsMade = 0;
  let stoppedEarlyForDailyLimit = false;

  console.log(`[Gemini] total=${total} 件を1銘柄1リクエストで処理開始`);

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

    console.log(`[Gemini] ${index}/${total} code=${feature.code} start`);
    const outcome = await analyzeWithGemini(apiKey, feature);

    totalRequestsMade += outcome.attempts;
    status429Total += outcome.statusCounts.status429;
    status503Total += outcome.statusCounts.status503;
    if (outcome.attempts > 1) retriedCount++;

    if (outcome.success) {
      successCount++;
      results.push(outcome.result);
      console.log(`[Gemini] ${index}/${total} code=${feature.code} success`);
    } else {
      failedCount++;
      console.log(
        `[Gemini] ${index}/${total} code=${feature.code} failed (attempts=${outcome.attempts}, ` +
          `status=${outcome.lastError?.status ?? "n/a"})`
      );
    }

    if (onCandidateComplete) {
      try {
        await onCandidateComplete(outcome);
      } catch (err) {
        console.warn(`[Gemini] onCandidateCompleteフックでエラー code=${feature.code}: ${err.message}`);
      }
    }

    const isLast = i === candidates.length - 1;
    if (!isLast && totalRequestsMade < config.GEMINI.dailyRequestLimit) {
      console.log(`[Gemini] waiting ${Math.round(config.GEMINI.requestIntervalMs / 1000)}s`);
      await sleep(config.GEMINI.requestIntervalMs);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[Gemini] total=${total} success=${successCount} failed=${failedCount} retried=${retriedCount} ` +
      `429=${status429Total} 503=${status503Total} requestsMade=${totalRequestsMade} ` +
      `dailyLimitReached=${stoppedEarlyForDailyLimit} elapsed=${Math.round(elapsedMs / 1000)}s`
  );

  return results;
}
