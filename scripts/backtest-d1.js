// D1に蓄積したAI評価と全銘柄の日足から、評価の後の値動きを測るバックテスト(読み取り専用)。
// 計算の本体は src/backtestD1.js(純粋関数)。このスクリプトは、D1からの読み込みと、結果の出力だけを行う。
//
// 使い方:
//   必要な環境変数: CF_ACCOUNT_ID, CF_D1_DATABASE_ID, CF_API_TOKEN(D1の読み取りだけを行う)
//   node scripts/backtest-d1.js [--from 2026-10-05] [--horizons 1,3,5] [--cost-pct 0.3] [--top 10] [--bands 3]
//   (環境変数 BACKTEST_FROM / BACKTEST_HORIZONS / BACKTEST_COST_PCT / BACKTEST_TOP / BACKTEST_BANDS でも指定できる。引数が優先)
//
// D1には SELECT しか実行しない(書き込み・マイグレーションは一切しない)。
import { appendFile } from "node:fs/promises";
import { config } from "../src/config.js";
import { D1Client } from "../src/d1.js";
import { writeArtifact } from "../src/artifacts.js";
import { DEFAULT_HORIZONS, buildBacktestRows, formatBacktestReport, summarizeBacktest } from "../src/backtestD1.js";

const CODE_CHUNK = 90; // D1のバインド変数は1文につき100個まで(日付の1個を足しても超えない)

function parseArgs(argv, env) {
  const get = (name, envName) => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
    return env[envName] ?? "";
  };
  const fromRaw = String(get("from", "BACKTEST_FROM")).trim();
  const horizonsRaw = String(get("horizons", "BACKTEST_HORIZONS")).trim();
  const costRaw = String(get("cost-pct", "BACKTEST_COST_PCT")).trim();
  const topRaw = String(get("top", "BACKTEST_TOP")).trim();
  const bandsRaw = String(get("bands", "BACKTEST_BANDS")).trim();

  if (fromRaw && !/^\d{4}-\d{2}-\d{2}$/.test(fromRaw)) throw new Error(`--from は YYYY-MM-DD 形式で指定してください: ${fromRaw}`);
  const horizons = horizonsRaw ? horizonsRaw.split(",").map((s) => Number(s.trim())) : DEFAULT_HORIZONS;
  if (horizons.some((h) => !Number.isInteger(h) || h < 1 || h > 30)) throw new Error(`--horizons は1〜30の整数をカンマ区切りで指定してください: ${horizonsRaw}`);
  const costPct = costRaw ? Number(costRaw) : 0;
  if (!Number.isFinite(costPct) || costPct < 0 || costPct > 5) throw new Error(`--cost-pct は0〜5(%)で指定してください: ${costRaw}`);
  const topN = topRaw ? Number(topRaw) : 10;
  if (!Number.isInteger(topN) || topN < 1 || topN > 100) throw new Error(`--top は1〜100の整数で指定してください: ${topRaw}`);
  const bands = bandsRaw ? Number(bandsRaw) : 3;
  if (!Number.isInteger(bands) || bands < 1 || bands > 10) throw new Error(`--bands は1〜10の整数で指定してください: ${bandsRaw}`);
  return { from: fromRaw || null, horizons: [...new Set(horizons)].sort((a, b) => a - b), costPct, topN, bands };
}

/** 読み取り専用の問い合わせ。SELECT以外は実行しない。 */
async function select(d1, sql, params = []) {
  if (!/^\s*select\b/i.test(sql)) throw new Error("読み取り専用のため、SELECT以外は実行しません");
  return d1.query(sql, params);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), process.env);
  const d1 = new D1Client({
    accountId: process.env.CF_ACCOUNT_ID,
    databaseId: process.env.CF_D1_DATABASE_ID,
    apiToken: process.env.CF_API_TOKEN,
  });
  console.log(`[backtest-d1] 開始: horizons=${args.horizons.join(",")} / costPct=${args.costPct} / top=${args.topN} / bands=${args.bands} / from=${args.from ?? "(最初の評価から)"}`);

  // 1) AI評価(新規候補のpipeline由来だけ。保有銘柄の再評価は、選び方が違うので含めない)
  const evaluations = await select(
    d1,
    "SELECT code, data_as_of_date, generated_at, score, rating FROM ai_evaluations WHERE source = 'pipeline' AND score IS NOT NULL AND data_as_of_date >= ?",
    [args.from ?? "1970-01-01"]
  );
  if (evaluations.length === 0) {
    console.log("[backtest-d1] 対象のAI評価がありません。");
    return;
  }
  const signalDates = evaluations.map((e) => e.data_as_of_date).sort();
  const signalDateMin = signalDates[0];
  const signalDateMax = signalDates[signalDates.length - 1];

  // 2) 営業日カレンダー: 全銘柄の蓄積が完了した日付(price_sync_dates)
  const tradingDays = (await select(d1, "SELECT date FROM price_sync_dates WHERE date >= ? ORDER BY date", [signalDateMin])).map((r) => r.date);

  // 3) 評価した銘柄の始値・終値(評価の基準日以降)
  const codes = [...new Set(evaluations.map((e) => e.code))];
  const pricesByCode = new Map();
  for (let i = 0; i < codes.length; i += CODE_CHUNK) {
    const chunk = codes.slice(i, i + CODE_CHUNK);
    const rows = await select(
      d1,
      `SELECT code, date, open, close FROM stock_prices WHERE date >= ? AND code IN (${chunk.map(() => "?").join(",")})`,
      [signalDateMin, ...chunk]
    );
    for (const r of rows) {
      if (!pricesByCode.has(r.code)) pricesByCode.set(r.code, new Map());
      pricesByCode.get(r.code).set(r.date, { open: r.open, close: r.close });
    }
  }

  // 4) TOPIX(比較の基準。無くても動く)
  const topixByDate = new Map();
  try {
    const topix = await select(d1, "SELECT date, open, close FROM index_prices WHERE index_code = ? AND date >= ?", [config.MARKET.indexCode, signalDateMin]);
    for (const r of topix) topixByDate.set(r.date, { open: r.open, close: r.close });
  } catch (err) {
    console.warn(`[backtest-d1] TOPIXを読めなかったため、TOPIXとの比較は省略します: ${err.message}`);
  }

  const built = buildBacktestRows({ evaluations, pricesByCode, tradingDays, topixByDate, horizons: args.horizons, costPct: args.costPct });
  const evaluationsUnique = new Set(evaluations.map((e) => `${e.code}|${e.data_as_of_date}`)).size;
  const results = {};
  for (const h of args.horizons) {
    results[h] = {
      summary: summarizeBacktest(built[h].rows, { topN: args.topN, bands: args.bands }),
      skipped: built[h].skipped,
      delayedEntry: built[h].delayedEntry,
    };
  }
  const meta = {
    generatedAt: new Date().toISOString(),
    evaluationsRaw: evaluations.length,
    evaluationsUnique,
    signalDateMin,
    signalDateMax,
    tradingDayCount: tradingDays.length,
    horizons: args.horizons,
    costPct: args.costPct,
    topN: args.topN,
    bands: args.bands,
    d1: d1.stats,
  };

  const report = formatBacktestReport({ meta, results });
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  // 行ごとの結果も保存する(後で別の切り口で分析できるように)
  await writeArtifact("backtest-d1.json", { meta, results, rows: Object.fromEntries(args.horizons.map((h) => [h, built[h].rows])) });
}

main().catch((err) => {
  console.error(`[backtest-d1] 失敗: ${err.stack || err.message}`);
  process.exitCode = 1;
});
