// 値動き・出来高の数字そのものに、その後の成績を順位づける力があるかを、D1の長い日足(全銘柄)で測る(読み取り専用)。
// 計算の本体は src/featureStudy.js(純粋関数)。このスクリプトは、D1からの読み込みと、結果の出力だけを行う。
//
// 使い方(バックテストと同じ環境変数。D1の読み取りだけを行うトークン):
//   必要な環境変数: CF_ACCOUNT_ID, CF_D1_DATABASE_ID, CF_API_TOKEN
//   node scripts/analyze-features.js [--holdout-from 2026-03-02] [--cost-pct 0.3] [--min-turnover-oku 1] [--from 2024-10-04] [--chunk-codes 50] [--max-rows 2500000]
//
// D1には SELECT しか実行しない(書き込み・マイグレーションは一切しない)。読むのは、stocks(銘柄の一覧)と、stock_prices(日足)だけ。
// 読み取り行数に注意: D1は「走査した行数」で数える。stock_prices は code 始まりの主キーしか無いので、必ず「code IN (...)」で絞って読む
// (日付だけで絞ると、1回ごとに全表を走査し、無料枠の1日の読み取り上限500万行を使い切る)。この方法なら、全体で約120万行(日足の件数と同じ)。
// それでも1日に何度も実行しない。--max-rows(既定250万行)を超えたら、中止する。
import { appendFile } from "node:fs/promises";
import { writeArtifact } from "../src/artifacts.js";
import { D1Client } from "../src/d1.js";
import { DEFAULTS, addRows, createPanel, deriveTradingDays, formatFeatureReport, runStudy, summarizeStudy } from "../src/featureStudy.js";

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
    chunkCodes: Math.round(number("chunk-codes", "FEATURES_CHUNK_CODES", 50, 1, 90)), // D1のバインド変数は1文につき100個まで
    maxRows: Math.round(number("max-rows", "FEATURES_MAX_ROWS", 2_500_000, 1000, 50_000_000)),
  };
}

/** 読み取り専用の問い合わせ。SELECT以外は実行しない。 */
async function select(d1, sql, params = []) {
  if (!/^\s*select\b/i.test(sql)) throw new Error("読み取り専用のため、SELECT以外は実行しません");
  return d1.query(sql, params);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), process.env);
  const cfg = { ...DEFAULTS, holdoutFrom: args.holdoutFrom, costPct: args.costPct, minTurnoverYen: args.minTurnoverOku * 100_000_000 };
  const d1 = new D1Client({
    accountId: process.env.CF_ACCOUNT_ID,
    databaseId: process.env.CF_D1_DATABASE_ID,
    apiToken: process.env.CF_API_TOKEN,
  });
  console.log(`[features] 開始: 確認期間=${cfg.holdoutFrom}以降 / コスト=${cfg.costPct}% / 売買代金の足切り=${args.minTurnoverOku}億円 / from=${args.from ?? "(最初から)"} / 読み取り行数の上限=${args.maxRows}`);

  // 1) 銘柄の一覧(小さなテーブル)
  const codes = (await select(d1, "SELECT code FROM stocks ORDER BY code")).map((r) => r.code);
  if (codes.length < 1000) throw new Error(`stocks の銘柄数が少なすぎます(${codes.length}件)。全銘柄の検証には、約4000件以上が必要です。`);
  console.log(`[features] 銘柄の一覧: ${codes.length}件(stocks)`);

  // 2) 日足を、銘柄(code)ごとにまとめて読む。code 始まりの主キーが使えるので、読み取り行数は、読んだ行数とほぼ同じ
  const since = args.from ?? "1970-01-01";
  const allRows = [];
  const countsByDate = new Map();
  const startedAt = Date.now();
  let chunks = 0;
  for (let i = 0; i < codes.length; i += args.chunkCodes) {
    const chunk = codes.slice(i, i + args.chunkCodes);
    const rows = await select(
      d1,
      `SELECT code, date, open, high, low, close, volume FROM stock_prices WHERE code IN (${chunk.map(() => "?").join(",")}) AND date >= ?`,
      [...chunk, since]
    );
    for (const r of rows) {
      allRows.push(r);
      countsByDate.set(r.date, (countsByDate.get(r.date) ?? 0) + 1);
    }
    if (allRows.length > args.maxRows) throw new Error(`読み取り行数が上限(${args.maxRows}行)を超えたため、中止します。--max-rows を確認してください。`);
    chunks++;
    if (chunks % 20 === 0) console.log(`[features] 読み込み ${Math.min(i + args.chunkCodes, codes.length)}/${codes.length}銘柄 / ${allRows.length}行 (${Math.round((Date.now() - startedAt) / 1000)}秒)`);
  }
  console.log(`[features] 読み込み完了: ${allRows.length}行 / D1: ${JSON.stringify(d1.stats)}`);

  // 3) 営業日は、読んだ日足の件数から決める(銘柄数が極端に少ない日は除く)
  const { days: tradingDays, dropped, medianCount } = deriveTradingDays(countsByDate);
  if (tradingDays.length < 150) throw new Error(`営業日が少なすぎます(${tradingDays.length}日)。検証には、約150営業日以上が必要です。`);
  console.log(`[features] 営業日: ${tradingDays.length}日(${tradingDays[0]} 〜 ${tradingDays[tradingDays.length - 1]}) / 1日の件数の中央値 ${medianCount} / 除外した日 ${dropped.length}日`);

  const panel = createPanel(tradingDays);
  addRows(panel, allRows);
  allRows.length = 0;

  const study = runStudy(panel, cfg);
  console.log(`[features] 検証: ${study.days.length}日分`);
  const summary = summarizeStudy(study, cfg);
  const meta = {
    firstDay: tradingDays[0],
    lastDay: tradingDays[tradingDays.length - 1],
    coverage: study.coverage,
    masterCodes: codes.length,
    droppedDays: dropped,
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
