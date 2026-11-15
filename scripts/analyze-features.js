// 値動き・出来高の数字そのものに、その後の成績を順位づける力があるかを、D1の長い日足(全銘柄)で測る(読み取り専用)。
// 計算の本体は src/featureStudy.js(純粋関数)。このスクリプトは、D1からの読み込みと、結果の出力だけを行う。
//
// 使い方(バックテストと同じ環境変数。D1の読み取りだけを行うトークン):
//   必要な環境変数: CF_ACCOUNT_ID, CF_D1_DATABASE_ID, CF_API_TOKEN
//   node scripts/analyze-features.js [--holdout-from 2026-03-02] [--cost-pct 0.3] [--min-turnover-oku 1] [--from 2024-10-04] [--chunk-days 3]
//
// D1には SELECT しか実行しない(書き込み・マイグレーションは一切しない)。読むのは、price_sync_dates(営業日)と、stock_prices(日足)だけ。
// 全銘柄・全期間を1回読む(約120万行の読み取り)。1日に何度も実行しない。
import { appendFile } from "node:fs/promises";
import { writeArtifact } from "../src/artifacts.js";
import { D1Client } from "../src/d1.js";
import { DEFAULTS, addRows, createPanel, formatFeatureReport, runStudy, summarizeStudy } from "../src/featureStudy.js";

function parseArgs(argv, env) {
  const get = (name, envName) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : env[envName] ?? "";
  };
  const date = (name, envName, dflt) => {
    const raw = String(get(name, envName)).trim();
    if (!raw) return dflt;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error(`--${name} は YYYY-MM-DD 形式で指定してください: ${raw}`);
    return raw;
  };
  const number = (name, envName, dflt, min, max) => {
    const raw = String(get(name, envName)).trim();
    if (!raw) return dflt;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${name} は${min}〜${max}の数で指定してください: ${raw}`);
    return n;
  };
  return {
    from: date("from", "FEATURES_FROM", null),
    holdoutFrom: date("holdout-from", "FEATURES_HOLDOUT_FROM", DEFAULTS.holdoutFrom),
    costPct: number("cost-pct", "FEATURES_COST_PCT", DEFAULTS.costPct, 0, 5),
    minTurnoverOku: number("min-turnover-oku", "FEATURES_MIN_TURNOVER_OKU", DEFAULTS.minTurnoverYen / 100_000_000, 0, 1000),
    chunkDays: Math.round(number("chunk-days", "FEATURES_CHUNK_DAYS", 3, 1, 10)),
  };
}

/** 読み取り専用の問い合わせ。SELECT以外は実行しない。 */
async function select(d1, sql, params = []) {
  if (!/^\s*select\b/i.test(sql)) throw new Error("読み取り専用のため、SELECT以外は実行しません");
  return d1.query(sql, params);
}

async function loadTradingDays(d1, from) {
  const since = from ?? "1970-01-01";
  const synced = (await select(d1, "SELECT date FROM price_sync_dates WHERE date >= ? ORDER BY date", [since])).map((r) => r.date);
  if (synced.length >= 100) {
    console.log(`[features] 営業日: price_sync_dates から ${synced.length}日(${synced[0]} 〜 ${synced[synced.length - 1]})`);
    return synced;
  }
  // price_sync_dates に過去分が無い場合だけ、日足から営業日を求める(日足の全体を走査するので、読み取り行数が増える)
  console.warn(`[features] price_sync_dates が ${synced.length}日分しか無いため、stock_prices から営業日を求めます(読み取り行数が増えます)`);
  const days = (await select(d1, "SELECT DISTINCT date FROM stock_prices WHERE date >= ? ORDER BY date", [since])).map((r) => r.date);
  console.log(`[features] 営業日: stock_prices から ${days.length}日(${days[0]} 〜 ${days[days.length - 1]})`);
  return days;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), process.env);
  const cfg = { ...DEFAULTS, holdoutFrom: args.holdoutFrom, costPct: args.costPct, minTurnoverYen: args.minTurnoverOku * 100_000_000 };
  const d1 = new D1Client({
    accountId: process.env.CF_ACCOUNT_ID,
    databaseId: process.env.CF_D1_DATABASE_ID,
    apiToken: process.env.CF_API_TOKEN,
  });
  console.log(`[features] 開始: 確認期間=${cfg.holdoutFrom}以降 / コスト=${cfg.costPct}% / 売買代金の足切り=${args.minTurnoverOku}億円 / from=${args.from ?? "(最初から)"}`);

  const tradingDays = await loadTradingDays(d1, args.from);
  if (tradingDays.length < 150) throw new Error(`営業日が少なすぎます(${tradingDays.length}日)。検証には、約150営業日以上が必要です。`);

  // 日足を、数営業日ずつ読む(全銘柄)
  const panel = createPanel(tradingDays);
  const startedAt = Date.now();
  let chunks = 0;
  for (let i = 0; i < tradingDays.length; i += args.chunkDays) {
    const first = tradingDays[i];
    const last = tradingDays[Math.min(i + args.chunkDays, tradingDays.length) - 1];
    const rows = await select(d1, "SELECT code, date, open, high, low, close, volume FROM stock_prices WHERE date >= ? AND date <= ?", [first, last]);
    addRows(panel, rows);
    chunks++;
    if (chunks % 20 === 0) console.log(`[features] 読み込み ${Math.min(i + args.chunkDays, tradingDays.length)}/${tradingDays.length}日 (${Math.round((Date.now() - startedAt) / 1000)}秒)`);
  }
  console.log(`[features] 読み込み完了: ${panel.codes.length}銘柄 × ${tradingDays.length}日 / D1: ${JSON.stringify(d1.stats)}`);

  const study = runStudy(panel, cfg);
  console.log(`[features] 検証: ${study.days.length}日分`);
  const summary = summarizeStudy(study, cfg);
  const meta = {
    firstDay: tradingDays[0],
    lastDay: tradingDays[tradingDays.length - 1],
    coverage: study.coverage,
    minTurnoverYen: cfg.minTurnoverYen,
    costPct: cfg.costPct,
    quintileHorizon: cfg.quintileHorizon,
    upThresholds: cfg.upThresholds,
    flatPct: cfg.flatPct,
  };
  const report = formatFeatureReport({ meta, summary });
  console.log(`\n${report}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  await writeArtifact("feature-study.json", { meta, cfg, summary });
}

main().catch((err) => {
  console.error(`[features] 失敗: ${err.stack || err.message}`);
  process.exitCode = 1;
});
