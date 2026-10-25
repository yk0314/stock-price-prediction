// 「未完了取引の状況」(保有中・未売却の取引だけの集計・グラフ・一覧)のテスト。
// 集計とHTML生成は public/app.js の「OPEN-POSITIONS:BEGIN 〜 OPEN-POSITIONS:END」の間にある。
// 画面(ブラウザ)で実際に動くコードそのものを取り出してテストする(別ファイルのコピーはテストしない)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { buildHoldings } from "../worker/src/tradeLogic.mjs";

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const begin = appSource.indexOf("/* OPEN-POSITIONS:BEGIN");
const end = appSource.indexOf("/* OPEN-POSITIONS:END */");
assert.ok(begin >= 0 && end > begin, "app.js に OPEN-POSITIONS のブロックがありません");
const OpenPositions = vm.runInNewContext(`${appSource.slice(begin, end)}\n;OpenPositions`);
const { summarize, composition, shortLabel, render } = OpenPositions;

// 画面の整形関数(app.js)と同じ仕様の簡易版
const fmt = {
  esc: (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
  yen: (v) => (v === null || v === undefined ? "-" : `¥${Math.round(Number(v)).toLocaleString()}`),
  signedYen: (v) => {
    if (v === null || v === undefined) return "-";
    const r = Math.round(Number(v));
    return `${r > 0 ? "+" : r < 0 ? "-" : ""}¥${Math.abs(r).toLocaleString()}`;
  },
  pct: (v) => `${v > 0 ? "+" : ""}${(Math.round(v * 10) / 10).toFixed(1)}%`,
  cls: (v) => (v === null || v === undefined ? "" : v > 0 ? "positive" : v < 0 ? "negative" : ""),
};

const h = (code, quantity, avgCost, currentPrice, extra = {}) => ({
  code,
  name: `銘柄${code}`,
  quantity,
  avgCost,
  currentPrice,
  priceAsOf: "2026-10-16",
  ...extra,
});
const near = (a, b) => Math.abs(a - b) < 1e-6;
// vmの中で作られた配列は、このファイルの配列とは別の実行環境のものなので、比べる前に普通の値へ直す
const plain = (v) => JSON.parse(JSON.stringify(v));

test("集計: 利益の銘柄と損失の銘柄。購入金額・評価額・含み損益・損益率が合う", () => {
  const s = summarize([h("1111", 100, 1000, 1100), h("2222", 10, 5000, 4000)]);
  assert.equal(s.count, 2);
  assert.equal(s.quantity, 110);
  assert.ok(near(s.purchaseTotal, 100000 + 50000));
  assert.ok(near(s.valueTotal, 110000 + 40000));
  assert.ok(near(s.pnl, 10000 - 10000));
  assert.ok(near(s.pnlPct, 0));
  const [a, b] = s.rows;
  assert.ok(near(a.pnl, 10000) && near(a.pnlPct, 10)); // 利益: +10%
  assert.ok(near(b.pnl, -10000) && near(b.pnlPct, -20)); // 損失: -20%(購入金額に対する割合)
  assert.deepEqual(plain(s.missingPrice), []);
  assert.equal(s.priceAsOfMin, "2026-10-16");
});

test("売買履歴との整合: 複数回購入(移動平均)と部分売却は、既存の保有判定(buildHoldings)の結果どおりに集計される", () => {
  let id = 1;
  const t = (code, type, date, quantity, price, extra = {}) => ({
    id: id++, code, transaction_type: type, transaction_date: date, quantity, price, amount: quantity * price,
    memo: null, purchase_evaluation_id: null, created_at: `${date}T00:00:00.000Z`, canceled_at: null, stock_name: `銘柄${code}`, ...extra,
  });
  const rows = [
    // 5555: 100株@1000 + 100株@1400 → 平均1200。その後50株売却 → 150株、平均は1200のまま
    t("5555", "buy", "2026-10-01", 100, 1000),
    t("5555", "buy", "2026-10-02", 100, 1400),
    t("5555", "sell", "2026-10-05", 50, 1500),
    // 6666: 全部売却済み → 保有に出ない(未完了ではない)
    t("6666", "buy", "2026-10-01", 10, 3000),
    t("6666", "sell", "2026-10-06", 10, 3100),
    // 7777: 買いを取り消した → 保有に出ない(取消済みは除外)
    t("7777", "buy", "2026-10-03", 20, 800, { canceled_at: "2026-10-04T00:00:00.000Z" }),
    // 8888: 1回だけ購入
    t("8888", "buy", "2026-10-07", 30, 2000),
  ];
  const prices = new Map([["5555", 1300], ["8888", 2200]]);
  const holdings = buildHoldings(rows, prices, new Map(), new Map(), new Map(), new Map([["5555", "2026-10-16"], ["8888", "2026-10-16"]]));
  assert.deepEqual(holdings.map((x) => x.code).sort(), ["5555", "8888"]); // 売却済み・取消済みは出ない
  const s = summarize(holdings);
  assert.equal(s.count, 2);
  const r5555 = s.rows.find((r) => r.code === "5555");
  assert.equal(r5555.quantity, 150);
  assert.ok(near(r5555.cost, 1200 * 150)); // 購入金額 = 平均取得単価1,200 × 残り150株
  assert.ok(near(r5555.value, 1300 * 150));
  assert.ok(near(r5555.pnl, (1300 - 1200) * 150));
  const r8888 = s.rows.find((r) => r.code === "8888");
  assert.ok(near(r8888.cost, 60000) && near(r8888.pnl, 6000));
  assert.ok(near(s.purchaseTotal, 180000 + 60000));
});

test("株価が取得できない銘柄は、評価額・含み損益の合計に含めず、推測で計算しない(算出不可)", () => {
  const s = summarize([h("1111", 100, 1000, 1100), h("3333", 50, 2000, null, { priceAsOf: null })]);
  assert.equal(s.count, 2);
  assert.ok(near(s.purchaseTotal, 100000 + 100000)); // 購入金額は両方の合計
  assert.ok(near(s.valueTotal, 110000)); // 評価額は株価が分かる銘柄だけ
  assert.equal(s.comparableCount, 1);
  assert.ok(near(s.pnl, 10000)); // 含み損益は、株価が分かる銘柄の分だけ
  assert.ok(near(s.pnlPct, 10)); // 損益率の分母も、その銘柄の購入金額(100,000)だけ
  assert.deepEqual(plain(s.missingPrice.map((r) => r.code)), ["3333"]);
  const bad = s.rows.find((r) => r.code === "3333");
  assert.equal(bad.value, null);
  assert.equal(bad.pnl, null);
  assert.equal(bad.pnlPct, null);
  const html = render([h("1111", 100, 1000, 1100), h("3333", 50, 2000, null, { priceAsOf: null })], fmt, { updatedAt: "2026-10-17 20:00" });
  assert.match(html, /株価を取得できない1銘柄/);
  assert.match(html, /合計に含めていません/);
  assert.match(html, /算出不可/);
  assert.match(html, /評価額を算出できた1銘柄分/);
});

test("全銘柄の株価が無いときは、評価額・含み損益・損益率はすべて「算出不可」(購入金額だけ出る)", () => {
  const s = summarize([h("1111", 100, 1000, null), h("2222", 10, 500, 0)]); // 株価0も「無い」として扱う
  assert.equal(s.valueTotal, null);
  assert.equal(s.pnl, null);
  assert.equal(s.pnlPct, null);
  assert.ok(near(s.purchaseTotal, 105000));
  const html = render([h("1111", 100, 1000, null)], fmt);
  assert.match(html, /含み損益・損益率は算出できません/);
});

test("平均取得単価が不明な銘柄は、購入金額と損益を算出できない", () => {
  const s = summarize([h("1111", 100, null, 1100), h("2222", 10, 500, 600)]);
  assert.ok(near(s.purchaseTotal, 5000)); // 2222のみ
  assert.ok(near(s.valueTotal, 110000 + 6000)); // 評価額は株価が分かる2銘柄(1111: 100株×1,100円、2222: 10株×600円)
  assert.equal(s.comparableCount, 1);
  assert.ok(near(s.pnl, 1000));
  assert.deepEqual(plain(s.missingCost.map((r) => r.code)), ["1111"]);
  assert.match(render([h("1111", 100, null, 1100)], fmt), /平均取得単価が不明の1銘柄/);
});

test("保有0件(または保有数量が0以下・不正な行だけ)のときは、空状態を表示する", () => {
  for (const input of [[], [h("1111", 0, 1000, 1100), h("2222", -5, 1000, 1100), h("3333", NaN, 1000, 1100), null], undefined]) {
    const s = summarize(input);
    assert.equal(s.count, 0);
    assert.equal(s.purchaseTotal, null);
    assert.equal(s.pnl, null);
    assert.match(render(input, fmt), /未完了の取引\(保有中・未売却の銘柄\)はありません/);
  }
});

test("同じ銘柄コードが重複していても、二重に数えない(最初の1件だけ)", () => {
  const s = summarize([h("1111", 100, 1000, 1100), h("1111", 100, 1000, 1100), h("2222", 10, 500, 600)]);
  assert.equal(s.count, 2);
  assert.equal(s.duplicates, 1);
  assert.equal(s.quantity, 110);
  assert.ok(near(s.purchaseTotal, 100000 + 5000));
  assert.match(render([h("1111", 100, 1000, 1100), h("1111", 100, 1000, 1100)], fmt), /二重に数えていません/);
});

test("内訳: 構成比の合計は1。銘柄が多いときは上位をまとめて「その他(N銘柄)」にする。購入金額が不明な銘柄は含めない", () => {
  const many = Array.from({ length: 12 }, (_, i) => h(String(1000 + i), 10, 100 * (12 - i), 100));
  const { rows } = { rows: summarize(many).rows };
  const parts = composition(rows, 8);
  assert.equal(parts.length, 8); // 上位7銘柄 + その他
  assert.equal(parts[7].code, null);
  assert.equal(parts[7].label, "その他(5銘柄)");
  assert.equal(parts[7].count, 5);
  assert.ok(near(parts.reduce((a, p) => a + p.ratio, 0), 1));
  for (let i = 1; i < 7; i++) assert.ok(parts[i - 1].cost >= parts[i].cost); // 購入金額の大きい順
  const one = composition(summarize([h("1111", 10, 100, 100)]).rows);
  assert.equal(one.length, 1);
  assert.ok(near(one[0].ratio, 1));
  const unknownCost = composition(summarize([h("1111", 10, null, 100), h("2222", 10, 100, 100)]).rows);
  assert.equal(unknownCost.length, 1);
  assert.equal(unknownCost[0].code, "2222");
  assert.deepEqual(plain(composition([])), []);
});

test("グラフ用ラベル: コード + 銘柄名(長い名前は省略)", () => {
  assert.equal(shortLabel({ code: "7203", name: "トヨタ自動車" }), "7203 トヨタ自動車");
  assert.equal(shortLabel({ code: "9999", name: "あ".repeat(20) }), `9999 ${"あ".repeat(14)}…`);
  assert.equal(shortLabel({ code: "1111", name: null }), "1111");
});

test("HTML: サマリー6項目・3つのグラフ・銘柄別の一覧・データ基準日・表示更新時刻が出る。損益の正負は色だけでなく符号でも分かる", () => {
  const html = render([h("1111", 100, 1000, 1100), h("2222", 10, 5000, 4000)], fmt, { updatedAt: "2026-10-17 20:00" });
  for (const label of ["保有銘柄数", "保有株数", "購入金額", "現在評価額", "含み損益", "含み損益率"]) assert.ok(html.includes(label), label);
  assert.match(html, /銘柄別の購入金額と現在評価額/);
  assert.match(html, /銘柄別の含み損益\(金額\)/);
  assert.match(html, /保有資金の内訳\(購入金額の構成比\)/);
  assert.match(html, /銘柄別の一覧/);
  assert.match(html, /株価のデータ基準日: 2026-10-16/);
  assert.match(html, /表示更新: 2026-10-17 20:00/);
  assert.match(html, /手数料は記録されていないため含みません/);
  assert.match(html, /\+¥10,000/); // 利益は「+」
  assert.match(html, /-¥10,000/); // 損失は「-」
  assert.match(html, /class="oc-pos"/);
  assert.match(html, /class="oc-neg"/);
  assert.match(html, /role="img"/);
  assert.match(html, /<table class="op-table">/);
  // 銘柄名などはエスケープされる
  const xss = render([h("1111", 1, 100, 100, { name: "<img src=x onerror=1>" })], fmt);
  assert.ok(!xss.includes("<img src=x"));
  // 株価の基準日が銘柄ごとに違う場合は範囲で示す
  const range = render([h("1111", 1, 100, 100, { priceAsOf: "2026-10-14" }), h("2222", 1, 100, 100, { priceAsOf: "2026-10-16" })], fmt);
  assert.match(range, /2026-10-14〜2026-10-16/);
});

test("配線の確認: 保有銘柄画面にパネルがあり、保有銘柄の読み込み後に描画される。既存の保有銘柄の読み込み(再評価結果の表示)は残っている", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="open-positions-panel"/);
  assert.match(html, /未完了取引の状況/);
  assert.match(html, /約定していない注文は含みません/);
  assert.match(appSource, /currentHoldings = holdings;\s*renderOpenPositions\(holdings\);/);
  assert.match(appSource, /async function loadHoldings\(\)/);
  assert.match(appSource, /sortHoldingsByAcquisitionDesc\(holdings, latestBuyDateByCode\)/); // 既存の一覧の描画は変えていない
  // 集計は表示だけの処理で、取引の登録・取消・保有の再評価のAPIを呼ばない
  const blockSource = appSource.slice(begin, end);
  assert.doesNotMatch(blockSource, /\b(fetch|postJson|putJson|getJson|fetchJson)\(/);
});
