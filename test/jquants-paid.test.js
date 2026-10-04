import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JQuantsApiError, JQuantsClient, listCandidateDates } from "../src/jquants.js";
import { jstDateString, parseSubscriptionRange, resolveCutoffDate, resolveLatestAvailableDate } from "../src/cutoff.js";
import {
  addDays,
  isTradingHolDiv,
  latestTradingDayOnOrBefore,
  normalizeCalendarDate,
  parseTradingCalendar,
  tradingDaysBetween,
  weekdayDates,
  weekdayOnOrBefore,
} from "../src/tradingCalendar.js";
import { filterByListedMarket } from "../src/universe.js";
import { config } from "../src/config.js";

// ---- テスト用の部品 ----

/** 順番に応答を返すfetchの代わり。items: [{status, body, headers, throws}] */
function makeFetch(items) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const item = items[Math.min(calls.length - 1, items.length - 1)];
    if (item.throws) throw item.throws;
    const text = typeof item.body === "string" ? item.body : JSON.stringify(item.body ?? {});
    const headers = item.headers ?? {};
    return {
      status: item.status ?? 200,
      ok: (item.status ?? 200) >= 200 && (item.status ?? 200) < 300,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      text: async () => text,
    };
  };
  fn.calls = calls;
  return fn;
}

function makeClient(items, options = {}) {
  const fetchImpl = makeFetch(items);
  const sleeps = [];
  const events = [];
  const client = new JQuantsClient("test-key", {
    fetchImpl,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
    nowImpl: () => 1_000_000_000, // 常に一定(=間隔の待機は2回目以降のリクエストでだけ発生する)
    onEvent: (ev) => events.push(ev),
    intervalMs: 1000,
    finsIntervalMs: 3000,
    ...options,
  });
  return { client, fetchImpl, sleeps, events };
}

const ok = (data, extra = {}) => ({ status: 200, body: { data, ...extra } });

// ---- クライアント: 基本・ページネーション ----

test("株価の取得: x-api-keyヘッダーとdateパラメータで呼び出し、dataを返す(0件の日もエラーにしない)", async () => {
  const { client, fetchImpl } = makeClient([ok([{ Date: "2026-10-02", Code: "72030", AdjC: 100 }])]);
  const rows = await client.fetchDailyQuotesForDate("20261002");
  assert.equal(rows.length, 1);
  assert.equal(fetchImpl.calls[0].init.headers["x-api-key"], "test-key");
  assert.match(fetchImpl.calls[0].url, /\/v2\/equities\/bars\/daily\?date=20261002/);

  const empty = makeClient([ok([])]);
  assert.deepEqual(await empty.client.fetchDailyQuotesForDate("20261003"), []);
});

test("ページネーション: pagination_keyが返る限り続けて取得し、結合する", async () => {
  const { client, fetchImpl } = makeClient([
    ok([{ n: 1 }, { n: 2 }], { pagination_key: "KEY1" }),
    ok([{ n: 3 }], { pagination_key: "KEY2" }),
    ok([{ n: 4 }]),
  ]);
  const rows = await client.fetchDailyQuotesForDate("20261002");
  assert.deepEqual(rows.map((r) => r.n), [1, 2, 3, 4]);
  assert.equal(fetchImpl.calls.length, 3);
  assert.ok(!/pagination_key/.test(fetchImpl.calls[0].url));
  assert.match(fetchImpl.calls[1].url, /pagination_key=KEY1/);
  assert.match(fetchImpl.calls[2].url, /pagination_key=KEY2/);
});

test("cutoffDateより新しいレコードは除外される(多重防御)", async () => {
  const { client } = makeClient([ok([{ Date: "2026-10-02" }, { Date: "2026-10-05" }])]);
  const rows = await client.fetchDailyQuotesForDate("20261002", "2026-10-02");
  assert.deepEqual(rows.map((r) => r.Date), ["2026-10-02"]);
});

test("取引カレンダー・TOPIX・上場銘柄一覧のエンドポイントとパラメータ", async () => {
  const { client, fetchImpl } = makeClient([ok([])]);
  await client.fetchTradingCalendar("2026-09-01", "2026-10-03");
  await client.fetchTopixRange("20260901", "20261003");
  await client.fetchListedInfo();
  await client.fetchFinancialsForCode("7203");
  await client.fetchDailyQuotesForCodeRange("9984", "20250101", "20261003");
  const urls = fetchImpl.calls.map((c) => c.url);
  assert.match(urls[0], /\/v2\/markets\/calendar\?from=2026-09-01&to=2026-10-03/);
  assert.match(urls[1], /\/v2\/indices\/bars\/daily\/topix\?from=20260901&to=20261003/);
  assert.match(urls[2], /\/v2\/equities\/master$/);
  assert.match(urls[3], /\/v2\/fins\/summary\?code=7203/);
  assert.match(urls[4], /\/v2\/equities\/bars\/daily\?code=9984&from=20250101&to=20261003/);
});

test("日付リスト取得: 取得済みの日付(prefetched)は再取得せず、0件の日も正常として扱う", async () => {
  const { client, fetchImpl } = makeClient([ok([{ Date: "2026-10-01", Code: "A" }]), ok([])]);
  const rows = await client.fetchDailyQuotesForDates(["2026-10-01", "2026-10-02", "2026-10-05"], "2026-10-05", {
    prefetched: { "2026-10-02": [{ Date: "2026-10-02", Code: "B" }] },
  });
  assert.deepEqual(rows.map((r) => r.Code), ["A", "B"]);
  assert.equal(fetchImpl.calls.length, 2); // 10-02は取得済みなので、10-01と10-05の2回だけ
  assert.match(fetchImpl.calls[0].url, /date=20261001/);
  assert.match(fetchImpl.calls[1].url, /date=20261005/);
});

test("互換: listCandidateDates は土日を除く日付を返す", () => {
  assert.deepEqual(listCandidateDates("2026-10-01", "2026-10-06"), ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06"]);
});

// ---- クライアント: リトライ・エラー処理 ----

test("5xx: 待機してから再試行し、成功すれば結果を返す(指数バックオフ。再試行はeventで通知)", async () => {
  const { client, fetchImpl, sleeps, events } = makeClient([{ status: 503, body: "busy" }, { status: 500, body: "err" }, ok([{ ok: 1 }])]);
  const rows = await client.fetchDailyQuotesForDate("20261002");
  assert.equal(rows.length, 1);
  assert.equal(fetchImpl.calls.length, 3);
  assert.deepEqual(sleeps.filter((ms) => ms !== 1000), [2000, 4000]); // 2秒 → 4秒(1000は通常の間隔)
  assert.deepEqual(events.map((e) => [e.type, e.kind, e.attempt]), [["retry", "server", 1], ["retry", "server", 2]]);
  assert.equal(client.stats.retries, 2);
});

test("5xx: 上限回数(3回)で必ず止まり、JQuantsApiError(kind=server)になる(無限リトライしない)", async () => {
  const { client, fetchImpl, events } = makeClient([{ status: 502, body: "bad gateway" }]);
  await assert.rejects(
    () => client.fetchDailyQuotesForDate("20261002"),
    (err) => err instanceof JQuantsApiError && err.kind === "server" && err.status === 502
  );
  assert.equal(fetchImpl.calls.length, 1 + config.JQUANTS_RETRY.maxRetriesOnTransient);
  assert.equal(events.filter((e) => e.type === "retry").length, config.JQUANTS_RETRY.maxRetriesOnTransient);
  assert.equal(events.filter((e) => e.type === "failure").length, 1);
  assert.equal(client.stats.failures, 1);
});

test("429: Retry-Afterがあればその秒数、無ければ段階的に待機して再試行する", async () => {
  const withHeader = makeClient([{ status: 429, body: "", headers: { "retry-after": "7" } }, ok([{ a: 1 }])]);
  assert.equal((await withHeader.client.fetchDailyQuotesForDate("20261002")).length, 1);
  assert.ok(withHeader.sleeps.includes(7000));

  const noHeader = makeClient(
    [{ status: 429, body: "" }, { status: 429, body: "" }, ok([{ a: 1 }])],
    { retry: { retryBackoffMs: 100 } }
  );
  await noHeader.client.fetchDailyQuotesForDate("20261002");
  assert.deepEqual(noHeader.sleeps.filter((ms) => ms !== 1000), [100, 200]); // 100ms×(1,2)
  assert.deepEqual(noHeader.events.map((e) => e.kind), ["rate-limit", "rate-limit"]);
});

test("429: 上限回数(3回)で止まり、JQuantsApiError(kind=rate-limit)になる", async () => {
  const { client, fetchImpl } = makeClient([{ status: 429, body: "" }]);
  await assert.rejects(
    () => client.fetchDailyQuotesForDate("20261002"),
    (err) => err.kind === "rate-limit" && err.status === 429
  );
  assert.equal(fetchImpl.calls.length, 1 + config.JQUANTS_RETRY.maxRetriesOn429);
});

test("ネットワークエラー: 再試行して成功 / 上限で止まる", async () => {
  const recover = makeClient([{ throws: new Error("ECONNRESET") }, ok([{ x: 1 }])]);
  assert.equal((await recover.client.fetchDailyQuotesForDate("20261002")).length, 1);
  assert.equal(recover.events[0].kind, "network");

  const dead = makeClient([{ throws: new Error("ENOTFOUND") }]);
  await assert.rejects(
    () => dead.client.fetchDailyQuotesForDate("20261002"),
    (err) => err.kind === "network"
  );
  assert.equal(dead.fetchImpl.calls.length, 1 + config.JQUANTS_RETRY.maxRetriesOnTransient);
});

test("タイムアウト: 応答が返らないリクエストは中断して再試行し、上限で止まる", async () => {
  let calls = 0;
  const hanging = (url, init) => {
    calls++;
    return new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
  };
  const client = new JQuantsClient("k", {
    fetchImpl: hanging,
    sleepImpl: async () => {},
    nowImpl: () => 1_000_000_000,
    retry: { requestTimeoutMs: 5, maxRetriesOnTransient: 2 },
  });
  await assert.rejects(
    () => client.fetchDailyQuotesForDate("20261002"),
    (err) => err.kind === "network" && /タイムアウト/.test(err.message)
  );
  assert.equal(calls, 3);
});

test("認証・権限・不正リクエストは再試行しない(1回で失敗)。契約期間外は取得可能期間を取り出す", async () => {
  for (const [status, kind] of [[401, "auth"], [403, "forbidden"], [404, "client"]]) {
    const { client, fetchImpl } = makeClient([{ status, body: "{\"message\":\"no\"}" }]);
    await assert.rejects(() => client.fetchTopixRange("20260901", "20261003"), (err) => err.kind === kind && err.status === status);
    assert.equal(fetchImpl.calls.length, 1, `${status}は再試行しない`);
  }

  const msg = "Your subscription covers the following dates: 2021-10-03 ~ . If you want more data, please check other plans";
  const { client } = makeClient([{ status: 400, body: JSON.stringify({ message: msg }) }]);
  await assert.rejects(
    () => client.fetchDailyQuotesForDate("20201002"),
    (err) => err.kind === "bad-request" && err.subscriptionRange?.from === "2021-10-03" && err.subscriptionRange?.to === null
  );
});

test("200でもJSONが壊れていれば再試行し、上限で止まる(parse)", async () => {
  const { client, fetchImpl } = makeClient([{ status: 200, body: "<html>maintenance</html>" }]);
  await assert.rejects(() => client.fetchDailyQuotesForDate("20261002"), (err) => err.kind === "parse");
  assert.equal(fetchImpl.calls.length, 1 + config.JQUANTS_RETRY.maxRetriesOnTransient);
});

test("リクエスト間隔: 通常APIは intervalMs、財務情報(/fins/summary)は finsIntervalMs で待機する", async () => {
  const normal = makeClient([ok([])]);
  await normal.client.fetchDailyQuotesForDate("20261001");
  await normal.client.fetchDailyQuotesForDate("20261002");
  assert.deepEqual(normal.sleeps, [1000]);

  const fins = makeClient([ok([])]);
  await fins.client.fetchFinancialsForCode("7203");
  await fins.client.fetchFinancialsForCode("6758");
  assert.deepEqual(fins.sleeps, [3000]);
});

// ---- 取引カレンダー ----

test("取引カレンダー: HolDiv 1(営業日)・2(半日立会)だけが取引日。日付形式は両方受け付ける", () => {
  assert.deepEqual([isTradingHolDiv("0"), isTradingHolDiv("1"), isTradingHolDiv("2"), isTradingHolDiv("3"), isTradingHolDiv(1)], [false, true, true, false, true]);
  assert.equal(normalizeCalendarDate("20261002"), "2026-10-02");
  assert.equal(normalizeCalendarDate("2026-10-02"), "2026-10-02");
  assert.equal(normalizeCalendarDate("bad"), null);
  const days = parseTradingCalendar([
    { Date: "2026-10-03", HolDiv: "0" },
    { Date: "2026-10-02", HolDiv: "1" },
    { Date: "20261001", HolDiv: "2" },
    { Date: "2026-10-02", HolDiv: "1" }, // 重複
    { Date: "2026-10-12", HolDiv: "3" },
    { Date: "x", HolDiv: "1" },
  ]);
  assert.deepEqual(days, ["2026-10-01", "2026-10-02"]);
  assert.deepEqual(parseTradingCalendar(null), []);
});

test("営業日の計算: 範囲・以前の最新・平日・日付加算", () => {
  const days = ["2026-09-28", "2026-09-29", "2026-10-01", "2026-10-02"];
  assert.deepEqual(tradingDaysBetween(days, "2026-09-29", "2026-10-01"), ["2026-09-29", "2026-10-01"]);
  assert.equal(latestTradingDayOnOrBefore(days, "2026-09-30"), "2026-09-29");
  assert.equal(latestTradingDayOnOrBefore(days, "2026-09-01"), null);
  assert.equal(weekdayOnOrBefore("2026-10-04"), "2026-10-02"); // 日曜 → 金曜
  assert.deepEqual(weekdayDates("2026-10-02", "2026-10-05"), ["2026-10-02", "2026-10-05"]);
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

// ---- データ基準日(取得可能な最新の取引日)の判定 ----

/** 日付 -> 件数 or Error の対応表から、fetchDailyQuotesForDateを持つ偽のクライアントを作る */
function fakeQuoteClient(byDate) {
  const requested = [];
  return {
    requested,
    async fetchDailyQuotesForDate(dateCompact) {
      const date = `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}`;
      requested.push(date);
      const v = byDate[date];
      if (v instanceof Error) throw v;
      return Array.from({ length: v ?? 0 }, (_, i) => ({ Date: date, Code: String(1000 + i) }));
    },
  };
}
const CAL = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06"];

test("最新日: 土曜に実行しても、取引カレンダーから金曜(取引日)を選ぶ。土曜には問い合わせない", async () => {
  const client = fakeQuoteClient({ "2026-10-02": 4400 });
  const r = await resolveLatestAvailableDate(client, { now: new Date("2026-10-03T00:30:00Z"), tradingDays: CAL }); // JST 10/3(土) 9:30
  assert.equal(r.cutoffDate, "2026-10-02");
  assert.equal(r.source, "auto-latest");
  assert.deepEqual(client.requested, ["2026-10-02"]);
  assert.equal(r.rows.length, 4400); // 判定で取得した最新日のデータは再利用できる
});

test("最新日: 当日の更新前(16:30前)は0件のため、前の取引日に戻る", async () => {
  const client = fakeQuoteClient({ "2026-10-05": 0, "2026-10-02": 4400 });
  const r = await resolveLatestAvailableDate(client, { now: new Date("2026-10-05T01:00:00Z"), tradingDays: CAL }); // JST 10/5(月) 10:00
  assert.equal(r.cutoffDate, "2026-10-02");
  assert.deepEqual(r.probes.map((p) => [p.date, p.outcome]), [["2026-10-05", "empty"], ["2026-10-02", "ok"]]);
});

test("最新日: 17:00 JSTの実行(更新後)は当日がデータ基準日になる", async () => {
  const client = fakeQuoteClient({ "2026-10-05": 4400, "2026-10-02": 4400 });
  const r = await resolveLatestAvailableDate(client, { now: new Date("2026-10-05T08:00:00Z"), tradingDays: CAL }); // JST 10/5 17:00
  assert.equal(r.cutoffDate, "2026-10-05");
  assert.deepEqual(client.requested, ["2026-10-05"]);
});

test("最新日: 件数が少なすぎる日(更新途中)は不完全とみなして前の取引日に戻る", async () => {
  const client = fakeQuoteClient({ "2026-10-05": 500, "2026-10-02": 4400 });
  const r = await resolveLatestAvailableDate(client, { now: new Date("2026-10-05T08:00:00Z"), tradingDays: CAL });
  assert.equal(r.cutoffDate, "2026-10-02");
  assert.equal(r.probes[0].outcome, "incomplete");
});

test("最新日: 日付の境界はJST(UTC 15:00 = JST 0:00)", () => {
  assert.equal(jstDateString(new Date("2026-10-02T14:59:59Z")), "2026-10-02");
  assert.equal(jstDateString(new Date("2026-10-02T15:00:00Z")), "2026-10-03");
});

test("最新日: カレンダーが無い場合は平日だけで判定する(土曜→金曜)", async () => {
  const client = fakeQuoteClient({ "2026-10-02": 4400 });
  const r = await resolveLatestAvailableDate(client, { now: new Date("2026-10-03T00:30:00Z"), tradingDays: [] });
  assert.equal(r.cutoffDate, "2026-10-02");
  assert.deepEqual(client.requested, ["2026-10-02"]); // 土曜は候補にならない
});

test("最新日: 祝日(カレンダーに無い平日)には問い合わせない", async () => {
  const cal = ["2026-10-08", "2026-10-09", "2026-10-13"]; // 10/12(月)は祝日
  const client = fakeQuoteClient({ "2026-10-09": 4400 });
  const r = await resolveLatestAvailableDate(client, { now: new Date("2026-10-12T05:00:00Z"), tradingDays: cal });
  assert.equal(r.cutoffDate, "2026-10-09");
  assert.deepEqual(client.requested, ["2026-10-09"]); // 祝日の10/12(月)には問い合わせない
});

test("最新日: 契約期間のエラー(Freeプランの12週間遅延)でも、固定値を使わずに最新日を判定できる", async () => {
  const outside = new JQuantsApiError("J-Quants APIエラー 400: /equities/bars/daily Your subscription covers the following dates: 2024-07-04 ~ 2026-07-04. If you want more data", {
    status: 400,
    kind: "bad-request",
  });
  const byDate = new Proxy({}, { get: (_, date) => (date > "2026-07-04" ? outside : date === "2026-07-03" ? 4400 : 0) });
  const client = fakeQuoteClient(byDate);
  const r = await resolveLatestAvailableDate(client, { now: new Date("2026-10-03T00:30:00Z"), tradingDays: [] });
  assert.equal(r.cutoffDate, "2026-07-03"); // 上限(7/4は土曜)以前で最新の平日
  assert.ok(client.requested.length <= 3, `問い合わせは数回で済む: ${client.requested.join(",")}`);
});

test("最新日: 認証エラー・サーバーエラーは握りつぶさず呼び出し側へ。どの日にもデータが無ければ明確なエラー", async () => {
  const auth = new JQuantsApiError("401", { status: 401, kind: "auth" });
  await assert.rejects(() => resolveLatestAvailableDate(fakeQuoteClient({ "2026-10-02": auth }), { now: new Date("2026-10-03T00:30:00Z"), tradingDays: CAL }), (e) => e.kind === "auth");
  await assert.rejects(
    () => resolveLatestAvailableDate(fakeQuoteClient({}), { now: new Date("2026-10-03T00:30:00Z"), tradingDays: CAL }),
    /取得可能な最新の取引日を判定できませんでした/
  );
});

test("最新日: 手動指定(CUTOFF_DATE)は問い合わせずにそのまま使う。形式が不正ならエラー", async () => {
  const client = fakeQuoteClient({});
  const r = await resolveLatestAvailableDate(client, { manualCutoffDate: "2026-06-01" });
  assert.deepEqual([r.cutoffDate, r.source, client.requested.length], ["2026-06-01", "manual", 0]);
  await assert.rejects(() => resolveLatestAvailableDate(client, { manualCutoffDate: "2026/06/01" }), /形式が不正/);
});

test("契約期間エラーのメッセージ解析", () => {
  assert.deepEqual(parseSubscriptionRange("Your subscription covers the following dates: 2021-10-03 ~ . If you want"), { from: "2021-10-03", to: null });
  assert.deepEqual(parseSubscriptionRange("Your subscription covers the following dates: 2024-07-04 ~ 2026-07-04. x"), { from: "2024-07-04", to: "2026-07-04" });
  assert.equal(parseSubscriptionRange("something else"), null);
  assert.equal(parseSubscriptionRange(undefined), null);
});

test("互換: resolveCutoffDate(手動指定の検証と従来の自動計算)。既定では遅延日数は0", () => {
  assert.deepEqual(resolveCutoffDate("2026-06-01"), { cutoffDate: "2026-06-01", source: "manual" });
  assert.throws(() => resolveCutoffDate("2026/06/01"), /形式が不正/);
  const now = new Date("2026-10-03T00:00:00Z");
  assert.equal(config.JQUANTS_DELAY_DAYS, 0);
  assert.deepEqual(resolveCutoffDate(undefined, now), { cutoffDate: "2026-10-03", source: "auto" });
});

// ---- Universe(銘柄範囲)の絞り込み ----

test("Universe=all: 市場区分(プライム/スタンダード/グロース)だけを残し、ETF・REIT等(その他)・PRO Marketは除外する", () => {
  const grouped = new Map([["7203", []], ["1306", []], ["8951", []], ["9999", []], ["4444", []], ["5555", []]]);
  const info = new Map([
    ["7203", { code: "7203", market: "プライム" }],
    ["1306", { code: "1306", market: "その他" }], // ETF
    ["8951", { code: "8951", market: "その他" }], // REIT
    ["9999", { code: "9999", market: "グロース" }],
    ["4444", { code: "4444", market: "TOKYO PRO MARKET" }],
    // 5555 は銘柄マスタに無い
  ]);
  const { grouped: kept, summary } = filterByListedMarket(grouped, info, ["プライム", "スタンダード", "グロース"]);
  assert.deepEqual([...kept.keys()].sort(), ["7203", "9999"]);
  assert.equal(summary.kept, 2);
  assert.equal(summary.removedByMarket["その他"], 2);
  assert.equal(summary.removedByMarket["TOKYO PRO MARKET"], 1);
  assert.equal(summary.removedByMarket["(銘柄マスタに無い)"], 1);
});

test("Universe: ALL指定・銘柄マスタ未取得のときは絞り込まない(全銘柄を誤って除外しない)", () => {
  const grouped = new Map([["7203", []], ["1306", []]]);
  assert.equal(filterByListedMarket(grouped, new Map([["7203", { market: "プライム" }]]), null).grouped.size, 2);
  const noMaster = filterByListedMarket(grouped, new Map(), ["プライム"]);
  assert.equal(noMaster.grouped.size, 2);
  assert.equal(noMaster.summary.skipped, "master-unavailable");
});

// ---- 設定(環境変数) ----

let importCounter = 0;
async function loadConfigWithEnv(env) {
  const saved = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return (await import(`../src/config.js?case=${++importCounter}`)).config;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("設定: プランごとにレート制限に合わせたリクエスト間隔になる(Freeは従来どおり15秒)", async () => {
  const base = { JQUANTS_REQUEST_INTERVAL_MS: undefined, JQUANTS_FINS_INTERVAL_MS: undefined };
  const free = await loadConfigWithEnv({ ...base, JQUANTS_PLAN: "free" });
  const light = await loadConfigWithEnv({ ...base, JQUANTS_PLAN: "light" });
  const standard = await loadConfigWithEnv({ ...base, JQUANTS_PLAN: "standard" });
  const premium = await loadConfigWithEnv({ ...base, JQUANTS_PLAN: "premium" });
  assert.equal(free.JQUANTS_REQUEST_INTERVAL_MS, 15000);
  assert.equal(light.JQUANTS_REQUEST_INTERVAL_MS, 1250);
  assert.equal(standard.JQUANTS_REQUEST_INTERVAL_MS, 625);
  assert.equal(premium.JQUANTS_REQUEST_INTERVAL_MS, 150);
  assert.equal(standard.JQUANTS_FINS_INTERVAL_MS, 1250); // 財務情報はプランによらず60回/分
  assert.equal(free.JQUANTS_RETRY.retryBackoffMs, 20000);
  assert.equal(light.JQUANTS_RETRY.retryBackoffMs, 5000);
  // 不明なプラン名・未設定はLight(現在の契約)として扱う
  assert.equal((await loadConfigWithEnv({ ...base, JQUANTS_PLAN: "gold" })).JQUANTS_PLAN, "light");
  assert.equal((await loadConfigWithEnv({ ...base, JQUANTS_PLAN: undefined })).JQUANTS_PLAN, "light");
  // 明示的な上書き
  assert.equal((await loadConfigWithEnv({ JQUANTS_PLAN: "light", JQUANTS_REQUEST_INTERVAL_MS: "2000" })).JQUANTS_REQUEST_INTERVAL_MS, 2000);
});

test("設定: ユニバース・候補プール・Gemini評価件数は独立した設定で、環境変数で変更できる(不正値は既定に戻る)", async () => {
  const cfg = await loadConfigWithEnv({ SCREENING_POOL_SIZE: "300", GEMINI_MAX_STOCKS: "100", UNIVERSE_MARKETS: "プライム, グロース" });
  assert.equal(cfg.SCREENING.poolSize, 300);
  assert.equal(cfg.GEMINI.candidateCount, 100);
  assert.deepEqual(cfg.UNIVERSE_MARKETS, ["プライム", "グロース"]);

  const defaults = await loadConfigWithEnv({ SCREENING_POOL_SIZE: undefined, GEMINI_MAX_STOCKS: undefined, UNIVERSE_MARKETS: undefined });
  assert.equal(defaults.SCREENING.poolSize, 150);
  assert.equal(defaults.GEMINI.candidateCount, 150);
  assert.deepEqual(defaults.UNIVERSE_MARKETS, ["プライム", "スタンダード", "グロース"]);

  assert.equal((await loadConfigWithEnv({ SCREENING_POOL_SIZE: "abc" })).SCREENING.poolSize, 150);
  assert.equal((await loadConfigWithEnv({ SCREENING_POOL_SIZE: "-5" })).SCREENING.poolSize, 150);
  assert.equal((await loadConfigWithEnv({ UNIVERSE_MARKETS: "ALL" })).UNIVERSE_MARKETS, null);
  assert.equal((await loadConfigWithEnv({ UNIVERSE_MARKETS: "  " })).UNIVERSE_MARKETS.length, 3);
});

// ---- 無料プランの固定値が残っていないこと ----

test("12週間遅延(84日/90日)の固定値が、データ基準日の判定に使われていない", () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const pipeline = read("../src/pipeline.js");
  assert.match(pipeline, /resolveLatestAvailableDate/);
  assert.ok(!/resolveCutoffDate\(/.test(pipeline), "pipeline.jsは固定日数の自動計算を使わない");
  assert.ok(!/JQUANTS_DELAY_DAYS/.test(pipeline));
  const cfg = read("../src/config.js");
  assert.ok(!/JQUANTS_DELAY_DAYS:\s*(84|90)\b/.test(cfg), "config.jsに84/90日の固定値が無い");
  const html = read("../public/index.html");
  assert.ok(!/Freeプラン/.test(html), "画面に無料プランの固定説明が残っていない");
});
