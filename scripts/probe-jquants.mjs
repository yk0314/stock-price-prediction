// J-Quantsの「契約プランで実際に使えるAPI・データ範囲」を実測する調査スクリプト。
// 読み取り専用(GETのみ)。D1・KV・Gitには一切触れない。APIキーは出力しない。
//
// 使い方(リポジトリのルートで):
//   Git Bash : JQUANTS_API_KEY=あなたのキー node scripts/probe-jquants.mjs
//   PowerShell: $env:JQUANTS_API_KEY="あなたのキー"; node scripts/probe-jquants.mjs
// 所要時間は約1分(リクエスト間隔を1.2秒空ける)。出力をそのままチャットに貼ってください。

const BASE = "https://api.jquants.com/v2";
const KEY = process.env.JQUANTS_API_KEY;
if (!KEY) {
  console.error("JQUANTS_API_KEY を環境変数に設定してください。");
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let res;
  try {
    res = await fetch(url, { headers: { "x-api-key": KEY } });
  } catch (e) {
    await sleep(1200);
    return { status: "NETWORK_ERROR", message: e.message };
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* JSONでない応答 */
  }
  const rate = {};
  for (const [name, value] of res.headers) if (/rate|retry|limit/i.test(name)) rate[name] = value;
  await sleep(1200);
  return { status: res.status, json, text: text.slice(0, 240), rate };
}

const ymd = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
function nearestWeekday(d) {
  const x = new Date(d);
  while ([0, 6].includes(x.getUTCDay())) x.setUTCDate(x.getUTCDate() - 1);
  return ymd(x);
}
const brief = (r) =>
  r.status === 200
    ? `200 / ${r.json?.data?.length ?? 0}件${r.json?.pagination_key ? " (pagination_keyあり)" : ""}`
    : `${r.status} ${r.json?.message ?? r.text ?? r.message ?? ""}`.slice(0, 200);

const out = { today: ymd(new Date()) };
console.log(`== J-Quants 実測(${out.today}) ==`);

// 1) 上場銘柄一覧: 件数と市場区分の内訳(ETF/REIT等を除外すべきかの判断材料)
{
  const r = await get("/equities/master");
  console.log("\n[1] /equities/master:", brief(r));
  if (r.status === 200 && r.json?.data?.length) {
    const rows = r.json.data;
    console.log("  項目名:", Object.keys(rows[0]).join(", "));
    const count = (pick) => {
      const m = {};
      for (const row of rows) m[pick(row) ?? "(なし)"] = (m[pick(row) ?? "(なし)"] ?? 0) + 1;
      return JSON.stringify(m);
    };
    const mktKey = Object.keys(rows[0]).find((k) => /^MktNm$|^MarketCodeName$|^MktName$/i.test(k)) ?? "MktNm";
    const s33Key = Object.keys(rows[0]).find((k) => /^S33Nm$|^Sector33CodeName$/i.test(k)) ?? "S33Nm";
    console.log(`  市場区分(${mktKey})の内訳:`, count((x) => x[mktKey]));
    console.log(`  33業種(${s33Key})の件数上位:`, JSON.stringify(Object.entries(JSON.parse(count((x) => x[s33Key]))).sort((a, b) => b[1] - a[1]).slice(0, 6)));
    console.log("  先頭1件:", JSON.stringify(rows[0]).slice(0, 300));
  }
}

// 2) 株価(全銘柄・日付指定): 直近の取得可能日(休日・まだ更新前の日は0件)
{
  console.log("\n[2] /equities/bars/daily?date= (直近10日。最初に件数が出る日が「取得可能な最新日」)");
  let first = null;
  for (let i = 0; i < 10; i++) {
    const d = daysAgo(i);
    if ([0, 6].includes(d.getUTCDay())) continue;
    const r = await get("/equities/bars/daily", { date: ymd(d) });
    console.log(`  ${ymd(d)}: ${brief(r)}`);
    if (!first && r.status === 200 && r.json?.data?.length) {
      first = ymd(d);
      console.log("  項目名:", Object.keys(r.json.data[0]).join(", "));
      console.log("  レート関連ヘッダー:", JSON.stringify(r.rate));
    }
  }
  console.log("  → 取得可能な最新日:", first ?? "見つかりませんでした");
}

// 3) 過去データの深さ(プランの期間: Light=5年 / Standard=10年 / Premium=20年)
{
  console.log("\n[3] 過去データの深さ");
  for (const years of [1, 2, 4.5, 6, 9.5, 11]) {
    const date = nearestWeekday(daysAgo(Math.round(years * 365)));
    const r = await get("/equities/bars/daily", { date });
    console.log(`  約${years}年前(${date}): ${brief(r)}`);
  }
}

// 4) TOPIX・指数・取引カレンダー・決算発表予定日
{
  console.log("\n[4] 市場データ・その他のエンドポイント");
  const from = ymd(daysAgo(14)).replaceAll("-", "");
  const to = ymd(new Date()).replaceAll("-", "");
  const t = await get("/indices/bars/daily/topix", { from, to });
  console.log("  /indices/bars/daily/topix:", brief(t));
  if (t.status === 200 && t.json?.data?.length) console.log("    項目名:", Object.keys(t.json.data[0]).join(", "), "/ 最新:", JSON.stringify(t.json.data.at(-1)));
  const c = await get("/markets/calendar", { from: ymd(daysAgo(14)), to: ymd(new Date()) });
  console.log("  /markets/calendar:", brief(c), c.status === 200 ? JSON.stringify(c.json?.data?.slice(0, 2)) : "");
  const e = await get("/equities/earnings-calendar");
  console.log("  /equities/earnings-calendar:", brief(e));
}

// 5) 財務情報(トヨタ)。look-ahead対策に使う開示日・開示時刻の項目を確認
{
  const r = await get("/fins/summary", { code: "72030" });
  console.log("\n[5] /fins/summary?code=72030:", brief(r));
  if (r.status === 200 && r.json?.data?.length) {
    const rows = r.json.data;
    console.log("  項目名:", Object.keys(rows[0]).join(", "));
    for (const row of rows.slice(-3)) {
      const pick = Object.fromEntries(Object.entries(row).filter(([k]) => /Disc|Type|Per|Cur|Doc/i.test(k)));
      console.log("  末尾:", JSON.stringify(pick));
    }
  }
}

console.log("\n== 完了。この出力を全部コピーして貼ってください ==");
