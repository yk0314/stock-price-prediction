// テクニカル指標の計算モジュール。
// すべて「既にcutoffDateでフィルタ済みの価格データ」から計算するため、
// 追加のAPI呼び出しも未来情報混入のリスクも発生しない。
//
// 採用理由（予測精度への寄与可能性 / 計算コスト / データ取得可能性 / リーク耐性 の観点で選定）:
// - SMA/EMA: トレンド系の基本指標。計算コストが低く、他の指標の土台にもなる
// - RSI: 過熱感・売られすぎを定量化でき、Geminiへの追加シグナルとして有用
// - MACD: トレンド転換のタイミングを捉える定番指標
// - ボリンジャーバンド: ボラティリティに応じた価格の相対位置を示す
// - ATR: ボラティリティそのものの絶対値指標（リスク評価に有用）
// いずれも計算コストはO(N)程度で軽量。J-Quants未提供の指標（出来高加重平均等）は
// 現時点では優先度が低いと判断し見送っている。

/**
 * 単純移動平均
 * @param {Array<number>} values 昇順（古い→新しい）
 * @param {number} period
 * @returns {number|null}
 */
export function sma(values, period) {
  if (values.length < period) return null;
  const window = values.slice(-period);
  return window.reduce((sum, v) => sum + v, 0) / period;
}

/**
 * 指数移動平均（最新の1点のみ返す）
 */
export function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  // 初期値は先頭period件の単純移動平均から開始する一般的な実装
  let emaValue = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < values.length; i++) {
    emaValue = values[i] * k + emaValue * (1 - k);
  }
  return emaValue;
}

/**
 * RSI (Relative Strength Index)
 */
export function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const window = closes.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < window.length; i++) {
    const diff = window[i] - window[i - 1];
    if (diff >= 0) gains += diff;
    else losses += -diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * MACD (12,26,9がデフォルト)。シグナル線を出すためには
 * 実質 slow + signalPeriod 分以上のデータ点が必要。
 * @returns {{macd: number, signal: number, histogram: number}|null}
 */
export function macd(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (closes.length < slowPeriod + signalPeriod) return null;

  // MACDライン(=fastEMA-slowEMA)の時系列をsignalPeriod分作り、そのEMAをシグナル線とする
  const macdSeries = [];
  for (let end = slowPeriod; end <= closes.length; end++) {
    const slice = closes.slice(0, end);
    const fastEma = ema(slice, fastPeriod);
    const slowEma = ema(slice, slowPeriod);
    if (fastEma === null || slowEma === null) continue;
    macdSeries.push(fastEma - slowEma);
  }
  if (macdSeries.length < signalPeriod) return null;

  const signal = ema(macdSeries, signalPeriod);
  const macdValue = macdSeries[macdSeries.length - 1];
  if (signal === null) return null;

  return { macd: macdValue, signal, histogram: macdValue - signal };
}

/**
 * ボリンジャーバンド
 */
export function bollingerBands(closes, period = 20, stdDevMult = 2) {
  if (closes.length < period) return null;
  const window = closes.slice(-period);
  const mean = window.reduce((s, v) => s + v, 0) / period;
  const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);
  return {
    upper: mean + stdDevMult * stdDev,
    middle: mean,
    lower: mean - stdDevMult * stdDev,
  };
}

/**
 * ATR (Average True Range)。
 * high/lowが取得できない場合は、終値の日次変動幅で簡易近似する
 * （近似であることをフィールド名に明示すること）。
 */
export function atr(rows, period = 14) {
  if (rows.length < period + 1) return null;
  const trueRanges = [];
  for (let i = 1; i < rows.length; i++) {
    const cur = rows[i];
    const prev = rows[i - 1];
    if (cur.high != null && cur.low != null) {
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close)
      );
      trueRanges.push(tr);
    } else {
      // high/low が無い場合の簡易近似（終値の日次変動幅の絶対値）
      trueRanges.push(Math.abs(cur.close - prev.close));
    }
  }
  return sma(trueRanges, period);
}

/**
 * ボラティリティ（日次リターンの標準偏差、%表記）
 */
export function volatility(closes, period = 20) {
  if (closes.length < period + 1) return null;
  const window = closes.slice(-(period + 1));
  const returns = [];
  for (let i = 1; i < window.length; i++) {
    returns.push((window[i] - window[i - 1]) / window[i - 1]);
  }
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const variance =
    returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * 100;
}

/**
 * 直近期間の高値・安値からの乖離率(%)
 */
export function highLowDeviation(rows, period = 20) {
  const window = rows.slice(-period);
  if (window.length < period) return null;
  const highs = window.map((r) => r.high).filter((v) => v != null);
  const lows = window.map((r) => r.low).filter((v) => v != null);
  if (highs.length === 0 || lows.length === 0) return null;
  const periodHigh = Math.max(...highs);
  const periodLow = Math.min(...lows);
  const latestClose = window[window.length - 1].close;
  return {
    fromHighPct: ((latestClose - periodHigh) / periodHigh) * 100,
    fromLowPct: ((latestClose - periodLow) / periodLow) * 100,
  };
}

/**
 * 1銘柄分の正規化済み日足データ(rowsSortedAsc: {date,close,high,low,volume})から
 * テクニカル指標一式をまとめて計算する。
 */
export function computeIndicators(rowsSortedAsc) {
  const closes = rowsSortedAsc.map((r) => r.close);
  const volumes = rowsSortedAsc.map((r) => r.volume).filter((v) => Number.isFinite(v));

  const macdResult = macd(closes);
  const bb = bollingerBands(closes, 20, 2);
  const hld = highLowDeviation(rowsSortedAsc, 20);

  return {
    sma5: sma(closes, 5),
    sma20: sma(closes, 20),
    ema12: ema(closes, 12),
    ema26: ema(closes, 26),
    rsi14: rsi(closes, 14),
    macd: macdResult?.macd ?? null,
    macdSignal: macdResult?.signal ?? null,
    macdHistogram: macdResult?.histogram ?? null,
    bbUpper: bb?.upper ?? null,
    bbMiddle: bb?.middle ?? null,
    bbLower: bb?.lower ?? null,
    atr14: atr(rowsSortedAsc, 14),
    volumeSma20: sma(volumes, 20),
    volatility20: volatility(closes, 20),
    fromHigh20dPct: hld?.fromHighPct ?? null,
    fromLow20dPct: hld?.fromLowPct ?? null,
  };
}
