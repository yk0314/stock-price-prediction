// test/unit.test.js を、J-Quants有料化・ランキング日・保有銘柄の変更に合わせて更新するパッチ。
//   node scripts/update-unit-tests.mjs           # 更新を適用(test/unit.test.js を書き換える)
//   node scripts/update-unit-tests.mjs --check   # 書き換えずに、適用できるかだけを確認する
// 改行コード(LF/CRLF)は元のファイルのまま保つ。各置換は「該当箇所がちょうど1つ」のときだけ行い、
// 見つからない・複数ある場合は何も書き換えずにエラー終了する(古い版に誤って適用しないため)。
import { readFileSync, writeFileSync } from "node:fs";

const target = new URL("../test/unit.test.js", import.meta.url);
const checkOnly = process.argv.includes("--check");
const raw = readFileSync(target, "utf8");
const crlf = raw.includes("\r\n");
let text = raw.replace(/\r\n/g, "\n");
const applied = [];

function count(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}
function fail(msg) {
  console.error(`[update-unit-tests] 適用できません: ${msg}`);
  process.exit(1);
}
function replaceExact(label, oldText, newText) {
  const n = count(text, oldText);
  if (n !== 1) fail(`${label}: 該当箇所が${n}件(1件のはず)`);
  text = text.replace(oldText, () => newText);
  applied.push(label);
}
// 文字列の位置を、その行の先頭に揃える(マーカーが行の途中にあっても、行ごと置換・挿入できるように)
function lineStart(index) {
  return text.lastIndexOf("\n", index - 1) + 1;
}
// startMarker のある行の先頭から、endMarker のある行の先頭の直前までを、newText に置き換える
function replaceBlock(label, startMarker, endMarker, newText) {
  if (count(text, startMarker) !== 1) fail(`${label}: 開始位置が${count(text, startMarker)}件(1件のはず)`);
  const startIdx = text.indexOf(startMarker);
  const endIdx = text.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1) fail(`${label}: 終了位置が見つかりません`);
  text = text.slice(0, lineStart(startIdx)) + newText + text.slice(lineStart(endIdx));
  applied.push(label);
}
function insertBefore(label, marker, newText) {
  if (count(text, marker) !== 1) fail(`${label}: 挿入位置が${count(text, marker)}件(1件のはず)`);
  text = text.slice(0, lineStart(text.indexOf(marker))) + newText + text.slice(lineStart(text.indexOf(marker)));
  applied.push(label);
}
// 正規表現に、ちょうど1か所だけ一致するときに置換する
function replaceRegex(label, regex, replacement) {
  const matches = text.match(new RegExp(regex.source, regex.flags.replace("g", "") + "g")) ?? [];
  if (matches.length !== 1) fail(`${label}: 該当箇所が${matches.length}件(1件のはず)`);
  text = text.replace(regex, replacement);
  applied.push(label);
}
// startMarker より後ろで最初に現れる targetText の行の、次の行の先頭に newText を挿入する(メソッドの本体の先頭に差し込む用)
function insertAfterLineOfFirstAfter(label, startMarker, targetText, newText) {
  if (count(text, startMarker) !== 1) fail(`${label}: 開始位置が${count(text, startMarker)}件(1件のはず)`);
  const startIdx = text.indexOf(startMarker);
  const idx = text.indexOf(targetText, startIdx);
  if (idx === -1) fail(`${label}: 挿入位置が見つかりません`);
  const nextLine = text.indexOf("\n", idx) + 1;
  text = text.slice(0, nextLine) + newText + text.slice(nextLine);
  applied.push(label);
}

// 1) import: jstDateString
replaceExact(
  "import(cutoff.js)",
  'import { resolveCutoffDate, isOnOrBeforeCutoff } from "../src/cutoff.js";',
  'import { resolveCutoffDate, isOnOrBeforeCutoff, jstDateString } from "../src/cutoff.js";'
);

// 2) cutoff: 無料プランの90日遅延の固定値を撤廃(既定は0)。互換の自動計算は設定値に追従する
replaceBlock(
  "cutoff: 未指定時の自動計算",
  'await test("未指定時は自動計算(90日前)になる"',
  'await test("不正な形式はエラーになる"',
  `await test("未指定時は「実行日 - JQUANTS_DELAY_DAYS」(後方互換)。有料プランの既定は0で、遅延を仮定しない", () => {
  const now = new Date("2026-09-03T00:00:00Z");
  assert.equal(config.JQUANTS_DELAY_DAYS, 0); // 無料プランの12週間遅延(90日)の固定値は撤廃した
  const byDefault = resolveCutoffDate(undefined, now);
  assert.equal(byDefault.cutoffDate, "2026-09-03");
  assert.equal(byDefault.source, "auto");
  // 無料プランで運用する場合の互換: 設定値(JQUANTS_DELAY_DAYS)の分だけさかのぼる
  const original = config.JQUANTS_DELAY_DAYS;
  config.JQUANTS_DELAY_DAYS = 90;
  try {
    assert.equal(resolveCutoffDate(undefined, now).cutoffDate, "2026-06-05");
  } finally {
    config.JQUANTS_DELAY_DAYS = original;
  }
});
`
);

// 3) selectGeminiCandidates: 既定の件数は150(プールサイズと同じ)。このテストでは件数を10に固定して絞り込みを確認する
replaceRegex(
  "selectGeminiCandidates",
  /const (\w+) = selectGeminiCandidates\((\w+)\);/,
  `const originalCandidateCount = config.GEMINI.candidateCount;
  config.GEMINI.candidateCount = 10; // テスト用に件数を固定する(既定は150)
  let $1;
  try {
    $1 = selectGeminiCandidates($2);
  } finally {
    config.GEMINI.candidateCount = originalCandidateCount;
  }`
);

// 4) marketDataService: 「今日のAPI呼び出しが成功」ではなく「今日の株価が実際にある」ことで判定する
replaceBlock(
  "marketDataService: 直接取得できる場合",
  'await test("discoverSubscriptionBoundary: 今日が直接取得できれば遅延なしと判定する"',
  'await test("discoverSubscriptionBoundary: 400エラーメッセージから提供期間を検出する',
  `await test("discoverSubscriptionBoundary: 今日(JST)の全銘柄分のデータが取得できれば遅延なしと判定する", async () => {
  const originalFetch = global.fetch;
  const originalMinRows = config.LATEST_DATE.minRowsForCompleteDay;
  config.LATEST_DATE.minRowsForCompleteDay = 1; // テストなので、1件あれば「全銘柄分が揃っている」とみなす
  global.fetch = async () =>
    new Response(JSON.stringify({ data: [{ Date: "2026-01-01", Code: "13010" }] }), { status: 200 });
  try {
    const { discoverSubscriptionBoundary, resetSubscriptionBoundaryCache } = await import(
      "../src/marketDataService.js"
    );
    resetSubscriptionBoundaryCache();
    const boundary = await discoverSubscriptionBoundary(new JQuantsClient("dummy"));
    assert.equal(boundary.discoveredVia, "direct-success");
    assert.equal(boundary.to, jstDateString());
  } finally {
    global.fetch = originalFetch;
    config.LATEST_DATE.minRowsForCompleteDay = originalMinRows;
  }
});
await test("discoverSubscriptionBoundary: 今日のデータがまだ無い(0件)ときは、データがある最新の取引日を使う(今日を最新日にしない)", async () => {
  const originalFetch = global.fetch;
  const originalMinRows = config.LATEST_DATE.minRowsForCompleteDay;
  config.LATEST_DATE.minRowsForCompleteDay = 1;
  const todayCompact = jstDateString().replaceAll("-", "");
  global.fetch = async (url) => {
    const isToday = String(url).includes(\`date=\${todayCompact}\`);
    return new Response(JSON.stringify({ data: isToday ? [] : [{ Date: "2026-01-01", Code: "13010" }] }), {
      status: 200,
    });
  };
  try {
    const { discoverSubscriptionBoundary, resetSubscriptionBoundaryCache } = await import(
      "../src/marketDataService.js"
    );
    resetSubscriptionBoundaryCache();
    const boundary = await discoverSubscriptionBoundary(new JQuantsClient("dummy", { intervalMs: 0 }));
    assert.equal(boundary.discoveredVia, "latest-with-data");
    assert.ok(boundary.to < jstDateString(), \`今日(\${jstDateString()})はデータが無いので、それより前の日付になるはず: \${boundary.to}\`);
    const weekday = new Date(boundary.to + "T00:00:00Z").getUTCDay();
    assert.ok(weekday !== 0 && weekday !== 6, "土日は取引日ではない");
  } finally {
    global.fetch = originalFetch;
    config.LATEST_DATE.minRowsForCompleteDay = originalMinRows;
  }
});
`
);
replaceBlock(
  "marketDataService: フォールバック",
  'await test("discoverSubscriptionBoundary: 解析できないエラーはconfigの値にフォールバックする"',
  'await test("discoverSubscriptionBoundary: 同一実行内ではキャッシュされ再度probeしない"',
  `await test("discoverSubscriptionBoundary: 解析できないエラーはconfigの値にフォールバックする", async () => {
  const originalFetch = global.fetch;
  const originalDelay = config.JQUANTS_DELAY_DAYS;
  const originalRetry = { ...config.JQUANTS_RETRY };
  config.JQUANTS_DELAY_DAYS = 90; // 検出失敗時の「最後の保険」(通常は0)を明示的に設定する
  config.JQUANTS_RETRY.maxRetriesOnTransient = 0; // テストなので、5xxの再試行(待機)はしない
  global.fetch = async () => new Response("unexpected error", { status: 500 });
  try {
    const { discoverSubscriptionBoundary, resetSubscriptionBoundaryCache } = await import(
      "../src/marketDataService.js"
    );
    resetSubscriptionBoundaryCache();
    const boundary = await discoverSubscriptionBoundary(new JQuantsClient("dummy"));
    assert.equal(boundary.discoveredVia, "fallback-config");
    assert.ok(boundary.to < jstDateString());
  } finally {
    global.fetch = originalFetch;
    config.JQUANTS_DELAY_DAYS = originalDelay;
    Object.assign(config.JQUANTS_RETRY, originalRetry);
  }
});
`
);
replaceBlock(
  "marketDataService: キャッシュ",
  'await test("discoverSubscriptionBoundary: 同一実行内ではキャッシュされ再度probeしない"',
  'await test("resolveEffectiveCutoffDate: 手動指定があればそれを優先する"',
  `await test("discoverSubscriptionBoundary: 同一実行内ではキャッシュされ再度probeしない", async () => {
  const originalFetch = global.fetch;
  const originalMinRows = config.LATEST_DATE.minRowsForCompleteDay;
  config.LATEST_DATE.minRowsForCompleteDay = 1;
  let callCount = 0;
  global.fetch = async () => {
    callCount++;
    return new Response(JSON.stringify({ data: [{ Date: "2026-01-01", Code: "13010" }] }), { status: 200 });
  };
  try {
    const { discoverSubscriptionBoundary, resetSubscriptionBoundaryCache } = await import(
      "../src/marketDataService.js"
    );
    resetSubscriptionBoundaryCache();
    await discoverSubscriptionBoundary(new JQuantsClient("dummy"));
    await discoverSubscriptionBoundary(new JQuantsClient("dummy"));
    assert.equal(callCount, 1);
  } finally {
    global.fetch = originalFetch;
    config.LATEST_DATE.minRowsForCompleteDay = originalMinRows;
  }
});
`
);
replaceBlock(
  "marketDataService: 自動検出の最新日",
  'await test("resolveEffectiveCutoffDate: 未指定なら自動検出した最新日を使う"',
  "[test] listedInfo.js (Phase2",
  `await test("resolveEffectiveCutoffDate: 未指定なら自動検出した最新日を使う", async () => {
  const originalFetch = global.fetch;
  const originalMinRows = config.LATEST_DATE.minRowsForCompleteDay;
  config.LATEST_DATE.minRowsForCompleteDay = 1;
  global.fetch = async () =>
    new Response(JSON.stringify({ data: [{ Date: "2026-01-01", Code: "13010" }] }), { status: 200 });
  try {
    const { resolveEffectiveCutoffDate, resetSubscriptionBoundaryCache } = await import(
      "../src/marketDataService.js"
    );
    resetSubscriptionBoundaryCache();
    const result = await resolveEffectiveCutoffDate(new JQuantsClient("dummy"), undefined);
    assert.equal(result.source, "auto-detected");
    assert.equal(result.cutoffDate, jstDateString());
  } finally {
    global.fetch = originalFetch;
    config.LATEST_DATE.minRowsForCompleteDay = originalMinRows;
  }
});

`
);

// 5) 銘柄マスタ: 英字を含む新しい証券コード(135A0 → 135A)
insertBefore(
  "listedInfo: 英字コード",
  "[test] worker/src/index.js (/api/ranking)",
  `await test("normalizeListedInfoRow: 英字を含む新しい証券コード(例: 135A0)も、株価データ(normalizeRawRow)と同じ形式になる", async () => {
  const { normalizeListedInfoRow } = await import("../src/listedInfo.js");
  const master = normalizeListedInfoRow({ Code: "135A0", CoName: "テスト銘柄", MktNm: "グロース" });
  const price = normalizeRawRow({ Code: "135A0", Date: "20261005", AdjC: 100 });
  assert.equal(master.code, "135A");
  assert.equal(master.code, price.code); // 株価データと銘柄マスタを同じコードで結び付けられる
});
await test("buildListedInfoByCode: 英字コードの銘柄も株価データのコードで引ける(全銘柄モードの市場区分フィルタで漏れない)", async () => {
  const { buildListedInfoByCode } = await import("../src/listedInfo.js");
  const map = buildListedInfoByCode([
    { Code: "135A0", CoName: "テスト銘柄", MktNm: "グロース" },
    { Code: "72030", CoName: "トヨタ自動車", MktNm: "プライム" },
    { Code: "72035", CoName: "5桁目が0以外はそのまま", MktNm: "プライム" },
  ]);
  assert.equal(map.get("135A").name, "テスト銘柄");
  assert.equal(map.get("7203").market, "プライム");
  assert.ok(map.has("72035"));
});

`
);

// 6) /api/ranking: 「今日のランキング日(日本時間17:00で切替)の最新の実行」のpipeline評価だけを選ぶ構造
replaceBlock(
  "ranking: SQLの構造",
  'await test("/api/ranking: SQLが銘柄ごとに最新(MAX id)のみをscore降順で選ぶ構造になっている"',
  'await test("/api/ranking: limitパラメータがD1へのbind引数に反映される',
  `await test("/api/ranking: SQLが「今日のランキング日の最新の実行」のpipeline評価だけをscore降順で選ぶ構造になっている", async () => {
  const worker = (await import("../worker/src/index.js")).default;
  let capturedSql = null;
  const fakeDb = {
    prepare(sql) {
      capturedSql = sql;
      const statement = {
        bind: () => statement,
        all: async () => ({ results: [] }),
      };
      return statement;
    },
  };
  await worker.fetch(new Request("https://example.com/api/ranking"), { DB: fakeDb });
  assert.ok(capturedSql.includes("FROM ai_evaluations"));
  assert.ok(capturedSql.includes("MAX(generated_at)")); // 今日の最新の1回の実行(generated_at)だけに絞る
  assert.ok(capturedSql.includes("date(generated_at, '-8 hours')")); // 日本時間17:00で「今日」が切り替わる
  assert.ok(capturedSql.includes("ae.source = 'pipeline'"));
  assert.ok(!capturedSql.includes("MAX(id)")); // 前日以前・前回完走分へのフォールバックはしない
  assert.ok(capturedSql.includes("ORDER BY ae.score DESC"));
  assert.ok(capturedSql.includes("LEFT JOIN stocks"));
});

`
);
replaceBlock(
  "ranking: limitとランキング日のbind",
  'await test("/api/ranking: limitパラメータがD1へのbind引数に反映される',
  'await test("/api/ranking: Gemini分析が存在しない銘柄',
  `await test("/api/ranking: ランキング日とlimitがD1へのbind引数に反映される（上限100件でキャップ）", async () => {
  const worker = (await import("../worker/src/index.js")).default;
  let capturedArgs = null;
  const fakeDb = {
    prepare(sql) {
      const statement = {
        bind: (...args) => {
          capturedArgs = args;
          return statement;
        },
        all: async () => ({ results: [] }),
      };
      return statement;
    },
  };
  // ランキング日 = 日本時間17:00で切り替わる日付(UTCに -8時間を加えた日付)
  const rankingDay = new Date(Date.now() + (9 - 17) * 60 * 60 * 1000).toISOString().slice(0, 10);

  await worker.fetch(new Request("https://example.com/api/ranking?limit=5"), { DB: fakeDb });
  assert.deepEqual(capturedArgs, [rankingDay, 5]);

  await worker.fetch(new Request("https://example.com/api/ranking?limit=999"), { DB: fakeDb });
  assert.deepEqual(capturedArgs, [rankingDay, 100]); // MAX_RANKING_LIMIT(100)でキャップされる

  await worker.fetch(new Request("https://example.com/api/ranking"), { DB: fakeDb });
  assert.deepEqual(capturedArgs, [rankingDay, 20]); // limit未指定時のデフォルト(DEFAULT_RANKING_LIMIT)
});

`
);

// 7) 保有銘柄: 最新と前回のAI評価を .all() で取得するようになったため、模擬D1を合わせる
insertAfterLineOfFirstAfter(
  "holdings: 模擬D1のAI評価の取得",
  "function makeFakeTradesD1(",
  "async all() {",
  `          if (sql.includes("FROM ai_evaluations") && sql.includes("WHERE ae.code = ?")) {
            // 銘柄ごとのAI評価(新しい順)。最新と、その1つ前の評価を取得するクエリ
            const row = latestEvaluationRowByCode[statement.args[0]];
            return { results: row ? [row] : [] };
          }
`
);

// 8) Gemini: 出力に tradeable が必須になっているため、テストの模擬応答に追加する
replaceRegex(
  "gemini: 模擬応答のtradeable",
  /(\n\s*)code, score: 80,/,
  "$1code, tradeable: true, score: 80,"
);

console.log(`[update-unit-tests] ${applied.length}か所を${checkOnly ? "適用できます(--checkのため書き換えません)" : "更新しました"}:`);
for (const label of applied) console.log(`  - ${label}`);
if (!checkOnly) writeFileSync(target, crlf ? text.replace(/\n/g, "\r\n") : text);
