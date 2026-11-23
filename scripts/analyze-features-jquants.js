// 長い期間(約5年)の日足を、J-Quantsから日付ごとに直接取って、値動き・出来高の数字そのものの順位づけの力を検証する(読み取り専用)。
// D1は使わない(読み取りも書き込みも無い。D1の無料枠の上限に影響しない)。J-Quantsには、GETしか送らない。
//
// 使い方:
//   必要な環境変数: JQUANTS_API_KEY(プランに合わせて JQUANTS_PLAN も。既定は light = 毎分60回)
//   node scripts/analyze-features-jquants.js [--from 2021-11-22] [--holdout-from 2024-07-01] [--cost-pct 0.3] [--min-turnover-oku 1] [--horizons 1,3,5,10,20]
//
// 取得量: 営業日ごとに1リクエスト。5年(約1,230営業日)で、毎分60回なら約26〜30分。
// 17:10 JST から始まる通常のパイプライン(約90分)と同時に動かさない(J-Quantsのレート制限は、APIキー単位で共有される)。
// 試しに短く動かすなら、--from に最近の日付(例: 2026-03-02)を指定する(約190営業日 → 約5分)。
import { appendFile } from "node:fs/promises";
import { writeArtifact } from "../src/artifacts.js";
import { jstDateString } from "../src/cutoff.js";
import { JQuantsClient } from "../src/jquants.js";
import { LONG_DEFAULTS, runLongStudy } from "../src/featureStudyLong.js";

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
  const horizonsRaw = String(get("horizons", "FEATURES_HORIZONS")).trim();
  const horizons = horizonsRaw ? horizonsRaw.split(",").map((x) => Number(x.trim())) : LONG_DEFAULTS.horizons;
  if (!horizons.length || horizons.some((h) => !Number.isInteger(h) || h < 1 || h > 60)) throw new Error(`--horizons は1〜60の整数をカンマ区切りで指定してください: ${horizonsRaw}`);
  return {
    // 契約の範囲(J-Quants Light: 2021-11-22 以降。scripts/probe-jquants.mjs で確認済み)
    from: date("from", "FEATURES_FROM", "2021-11-22"),
    to: date("to", "FEATURES_TO", jstDateString()),
    holdoutFrom: date("holdout-from", "FEATURES_HOLDOUT_FROM", LONG_DEFAULTS.holdoutFrom),
    costPct: number("cost-pct", "FEATURES_COST_PCT", LONG_DEFAULTS.costPct, 0, 5),
    minTurnoverOku: number("min-turnover-oku", "FEATURES_MIN_TURNOVER_OKU", LONG_DEFAULTS.minTurnoverYen / 100_000_000, 0, 1000),
    horizons,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), process.env);
  const client = new JQuantsClient(process.env.JQUANTS_API_KEY, {
    onEvent: (e) => console.log(`[jquants] ${e.type}: ${e.path ?? ""} ${e.status ?? ""} ${e.kind ?? ""}`.trim()),
  });
  console.log(
    `[features-long] 開始: 期間=${args.from}〜${args.to} / 確認期間=${args.holdoutFrom}以降 / コスト=${args.costPct}% / 売買代金の足切り=${args.minTurnoverOku}億円 / 保有日数=${args.horizons.join(",")}`
  );
  const startedAt = Date.now();
  const { report, meta, summary, cfg } = await runLongStudy({
    client,
    from: args.from,
    to: args.to,
    cfgOverrides: { holdoutFrom: args.holdoutFrom, costPct: args.costPct, minTurnoverYen: args.minTurnoverOku * 100_000_000, horizons: args.horizons },
    log: (m) => console.log(m),
  });
  console.log(`[features-long] 完了: ${Math.round((Date.now() - startedAt) / 1000)}秒 / J-Quants: ${JSON.stringify(client.stats)}`);
  console.log(`\n${report}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  await writeArtifact("feature-study-long.json", { meta, cfg: { ...cfg, regimeByDate: undefined }, summary });
}

main().catch((err) => {
  console.error(`[features-long] 失敗: ${err.stack || err.message}`);
  process.exitCode = 1;
});
