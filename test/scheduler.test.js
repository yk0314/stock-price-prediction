// pipeline の定刻起動(worker/src/scheduler.js)のテスト。外部通信・D1には触れない(fetchとD1は模擬)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../worker/src/index.js";
import {
  PRIMARY_CRON,
  WATCHDOG_CRON,
  decideAction,
  dispatchWorkflow,
  handleScheduled,
  listRecentRuns,
  windowStartMs,
} from "../worker/src/scheduler.js";

const TOKEN = "github_pat_TESTTOKEN1234567890";
const T0830 = Date.parse("2026-10-26T08:10:00Z"); // 17:10 JST
const WINDOW = Date.parse("2026-10-26T07:00:00Z"); // 16:00 JST

const run = (created, status = "completed", conclusion = "success", event = "workflow_dispatch") => ({ id: Math.floor(Math.random() * 1e6), event, status, conclusion, created_at: created });
const silent = () => ({ log() {}, warn() {}, error() {} });

/** fetchの模擬。GET(実行履歴)にはrunsを返し、POST(起動)には postStatus を返す。呼び出しを記録する。 */
function mockFetch({ runs = [], listStatus = 200, postStatus = 204, postBody = "" } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ?? null });
    if ((init.method ?? "GET") === "POST") return { ok: postStatus >= 200 && postStatus < 300, status: postStatus, text: async () => postBody, json: async () => ({}) };
    return { ok: listStatus === 200, status: listStatus, json: async () => ({ workflow_runs: runs }), text: async () => "" };
  };
  fn.calls = calls;
  return fn;
}

/** D1の模擬(error_logsへの書き込みを記録する)。 */
function mockDb({ fail = false } = {}) {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async run() {
              if (fail) throw new Error("D1が書き込めません");
              writes.push({ sql, params });
            },
          };
        },
      };
    },
  };
}

const baseEnv = (extra = {}) => ({ GITHUB_REPO: "owner/repo", GITHUB_WORKFLOW: "pipeline.yml", GITHUB_REF: "main", GITHUB_DISPATCH_TOKEN: TOKEN, ...extra });
const event = (cron) => ({ cron, scheduledTime: T0830 });

test("今日の実行の数え始め: cronが動いたUTC日の07:00(= 16:00 JST)", () => {
  assert.equal(windowStartMs(T0830), WINDOW);
  assert.equal(windowStartMs(Date.parse("2026-10-26T08:40:00Z")), WINDOW);
  assert.equal(windowStartMs(Date.parse("2026-10-27T08:10:00Z")), Date.parse("2026-10-27T07:00:00Z"));
});

test("判断(primary): 今日の実行が無ければ起動し、既にあれば(手動などで動いていても)起動しない。昨日までの実行は数えない", () => {
  assert.equal(decideAction("primary", [], WINDOW).action, "dispatch");
  assert.equal(decideAction("primary", [run("2026-10-25T08:05:00Z")], WINDOW).action, "dispatch"); // 昨日の実行
  assert.equal(decideAction("primary", [run("2026-10-26T06:59:59Z")], WINDOW).action, "dispatch"); // 16:00 JSTより前
  assert.equal(decideAction("primary", [run("2026-10-26T07:30:00Z", "in_progress", null)], WINDOW).action, "none");
  assert.equal(decideAction("primary", [run("2026-10-26T08:00:00Z", "completed", "failure")], WINDOW).action, "none"); // 再試行は見張りの役目
  assert.equal(decideAction("primary", undefined, WINDOW).action, "dispatch");
});

test("判断(watchdog): 実行が無ければ起動。実行中・待機中・成功は何もしない。全て失敗なら1回だけ再起動(1日2回まで)", () => {
  const w = (runs) => decideAction("watchdog", runs, WINDOW);
  assert.equal(w([]).action, "dispatch");
  assert.equal(w([run("2026-10-26T08:10:00Z", "in_progress", null)]).action, "none");
  assert.equal(w([run("2026-10-26T08:10:00Z", "queued", null)]).action, "none");
  assert.equal(w([run("2026-10-26T08:10:00Z", "completed", "success")]).action, "none");
  assert.equal(w([run("2026-10-26T08:10:00Z", "completed", "failure")]).action, "dispatch"); // 失敗 → 再起動
  assert.equal(w([run("2026-10-26T08:10:00Z", "completed", "cancelled")]).action, "dispatch");
  assert.equal(w([run("2026-10-26T08:10:00Z", "completed", "timed_out")]).action, "dispatch");
  // 既に2回起動して、どちらも失敗 → これ以上は起動しない
  const two = w([run("2026-10-26T08:10:00Z", "completed", "failure"), run("2026-10-26T08:41:00Z", "completed", "failure")]);
  assert.equal(two.action, "none");
  assert.match(two.reason, /上限/);
  // 失敗と成功が混ざる(再試行で成功した)なら、何もしない
  assert.equal(w([run("2026-10-26T08:10:00Z", "completed", "failure"), run("2026-10-26T08:41:00Z", "completed", "success")]).action, "none");
  // 結果がskippedなどのときは、勝手に起動しない
  assert.equal(w([run("2026-10-26T08:10:00Z", "completed", "skipped")]).action, "none");
});

test("起動の呼び出し: 正しいURL・メソッド・認証ヘッダ・本文(ref と inputs)で、204なら成功", async () => {
  const f = mockFetch();
  const r = await dispatchWorkflow({ repo: "owner/repo", workflow: "pipeline.yml", ref: "main", inputs: { universeMode: "all" }, token: TOKEN, fetchFn: f });
  assert.deepEqual(r, { ok: true, status: 204 });
  const c = f.calls[0];
  assert.equal(c.url, "https://api.github.com/repos/owner/repo/actions/workflows/pipeline.yml/dispatches");
  assert.equal(c.method, "POST");
  assert.equal(c.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(c.headers.Accept, "application/vnd.github+json");
  assert.ok(c.headers["User-Agent"]); // GitHub APIはUser-Agentが必須
  assert.ok(c.headers["X-GitHub-Api-Version"]);
  assert.deepEqual(JSON.parse(c.body), { ref: "main", inputs: { universeMode: "all" } });
});

test("起動の失敗: 状態コードを返し、メッセージにトークンを含めない(本文にトークンが入っていても伏せる)", async () => {
  const f = mockFetch({ postStatus: 422, postBody: `Unexpected inputs provided: ["x"] token=${TOKEN}` });
  const r = await dispatchWorkflow({ repo: "owner/repo", workflow: "pipeline.yml", ref: "main", inputs: { x: "1" }, token: TOKEN, fetchFn: f });
  assert.equal(r.ok, false);
  assert.equal(r.status, 422);
  assert.ok(!r.message.includes(TOKEN));
  assert.match(r.message, /422/);
});

test("実行履歴の取得: 今日の窓(16:00 JST)以降だけを問い合わせ、失敗時はトークンを含まない例外にする", async () => {
  const f = mockFetch({ runs: [run("2026-10-26T08:10:00Z")] });
  const runs = await listRecentRuns({ repo: "owner/repo", workflow: "pipeline.yml", sinceMs: WINDOW, token: TOKEN, fetchFn: f });
  assert.equal(runs.length, 1);
  assert.match(f.calls[0].url, /\/actions\/workflows\/pipeline\.yml\/runs\?per_page=20&created=%3E%3D2026-10-26T07%3A00%3A00Z$/);
  const bad = mockFetch({ listStatus: 500 });
  await assert.rejects(() => listRecentRuns({ repo: "owner/repo", workflow: "pipeline.yml", sinceMs: WINDOW, token: TOKEN, fetchFn: bad }), (e) => /500/.test(e.message) && !e.message.includes(TOKEN));
});

test("primaryのcron: 今日の実行が無ければ、全銘柄モードを指定して1回だけ起動する", async () => {
  const f = mockFetch({ runs: [] });
  const r = await handleScheduled(event(PRIMARY_CRON), baseEnv(), { fetchFn: f, logger: silent() });
  assert.equal(r.action, "dispatched");
  const posts = f.calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].body).inputs, { universeMode: "all" }); // 手動の既定(phase1_subset)にならない
  assert.equal(JSON.parse(posts[0].body).ref, "main");
});

test("primaryのcron: 今日の実行が既にあれば、起動しない(二重起動しない)", async () => {
  const f = mockFetch({ runs: [run("2026-10-26T07:50:00Z", "in_progress", null)] });
  const r = await handleScheduled(event(PRIMARY_CRON), baseEnv(), { fetchFn: f, logger: silent() });
  assert.equal(r.action, "none");
  assert.equal(f.calls.filter((c) => c.method === "POST").length, 0);
});

test("watchdogのcron: 起動していなければ起動、失敗していれば再起動、実行中・成功・上限なら何もしない", async () => {
  const cases = [
    [[], "dispatched"],
    [[run("2026-10-26T08:10:00Z", "completed", "failure")], "dispatched"],
    [[run("2026-10-26T08:10:00Z", "in_progress", null)], "none"],
    [[run("2026-10-26T08:10:00Z", "completed", "success")], "none"],
    [[run("2026-10-26T08:10:00Z", "completed", "failure"), run("2026-10-26T08:30:00Z", "completed", "failure")], "none"],
  ];
  for (const [runs, expected] of cases) {
    const f = mockFetch({ runs });
    const r = await handleScheduled(event(WATCHDOG_CRON), baseEnv(), { fetchFn: f, logger: silent() });
    assert.equal(r.action, expected);
    assert.equal(f.calls.filter((c) => c.method === "POST").length, expected === "dispatched" ? 1 : 0);
  }
});

test("DRY_RUN=true のときは、起動する判断でも起動しない(動作確認用)", async () => {
  const f = mockFetch({ runs: [] });
  const r = await handleScheduled(event(PRIMARY_CRON), baseEnv({ DRY_RUN: "true" }), { fetchFn: f, logger: silent() });
  assert.equal(r.action, "dry-run");
  assert.equal(f.calls.filter((c) => c.method === "POST").length, 0);
});

test("想定外のcronは、何も呼ばない", async () => {
  const f = mockFetch();
  const r = await handleScheduled(event("0 0 * * *"), baseEnv(), { fetchFn: f, logger: silent() });
  assert.equal(r.action, "none");
  assert.equal(f.calls.length, 0);
});

test("設定不備(トークン・リポジトリ名が無い): 何も呼ばず、D1のerror_logsに記録する(source=scheduler)", async () => {
  const f = mockFetch();
  const db = mockDb();
  const errors = [];
  const r = await handleScheduled(event(PRIMARY_CRON), { ...baseEnv(), GITHUB_DISPATCH_TOKEN: undefined, DB: db }, { fetchFn: f, logger: { ...silent(), error: (m) => errors.push(m) } });
  assert.equal(r.action, "error");
  assert.equal(f.calls.length, 0);
  assert.equal(db.writes.length, 1);
  assert.match(db.writes[0].sql, /INSERT INTO error_logs \(occurred_at, source, error_type, message, context\)/);
  assert.equal(db.writes[0].params[1], "scheduler");
  assert.equal(db.writes[0].params[2], "config_missing");
  assert.match(db.writes[0].params[3], /GITHUB_DISPATCH_TOKEN/);
  assert.equal(errors.length, 1);
});

test("GitHub APIの失敗: error_logsに記録し、ログにもD1にもトークンを書かない。D1に書けなくても例外にしない", async () => {
  const logged = [];
  const logger = { log: (m) => logged.push(m), warn: (m) => logged.push(m), error: (m) => logged.push(m) };
  const db = mockDb();
  const f = mockFetch({ runs: [], postStatus: 403, postBody: `Resource not accessible token=${TOKEN}` });
  const r = await handleScheduled(event(PRIMARY_CRON), baseEnv({ DB: db }), { fetchFn: f, logger });
  assert.equal(r.action, "error");
  assert.equal(db.writes.length, 1);
  assert.equal(db.writes[0].params[2], "dispatch_failed");
  const everything = JSON.stringify([logged, db.writes, r]);
  assert.ok(!everything.includes(TOKEN), "トークンがログ・D1・戻り値に含まれています");
  assert.match(db.writes[0].params[3], /403/);
  // D1が書き込めない場合でも、処理は例外にならない
  const failingDb = mockDb({ fail: true });
  const r2 = await handleScheduled(event(PRIMARY_CRON), baseEnv({ DB: failingDb }), { fetchFn: mockFetch({ listStatus: 500 }), logger: silent() });
  assert.equal(r2.action, "error");
});

test("Workerの入口: scheduledハンドラが、cronのイベントを受けてhandleScheduledを実行し、HTTPのfetchとは別に呼ばれる(設定不備なら何も呼ばず、エラーを記録する)", async () => {
  assert.equal(typeof worker.scheduled, "function");
  assert.equal(typeof worker.fetch, "function");
  const pending = [];
  const db = mockDb();
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => {
    fetched++;
    throw new Error("設定不備のときは、外部通信をしてはいけません");
  };
  try {
    await worker.scheduled({ cron: PRIMARY_CRON, scheduledTime: T0830 }, { DB: db }, { waitUntil: (p) => pending.push(p) });
    assert.equal(pending.length, 1); // ctx.waitUntil に渡される
    await Promise.all(pending);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(fetched, 0);
  assert.equal(db.writes.length, 1);
  assert.equal(db.writes[0].params[2], "config_missing");
});

test("cronの曜日: Cloudflareの曜日は1=日曜なので、平日は MON-FRI と書く(数字の 1-5 は日〜木になるため使わない)", () => {
  for (const cron of [PRIMARY_CRON, WATCHDOG_CRON]) {
    assert.match(cron, /\* \* MON-FRI$/);
    assert.doesNotMatch(cron, /\* \* 1-5$/);
  }
  const toml = readFileSync(new URL("../worker/wrangler.toml", import.meta.url), "utf8");
  assert.doesNotMatch(toml, /^crons\s*=.*\* \* 1-5/m);
});

test("配線の確認: wrangler.tomlのcronとscheduler.jsの定数が一致し、トークンは書かれていない。Workerの入口にscheduledがあり、起動する入力がpipeline.ymlに存在する", () => {
  const toml = readFileSync(new URL("../worker/wrangler.toml", import.meta.url), "utf8");
  const crons = toml.match(/^crons\s*=\s*\[(.*)\]/m)?.[1] ?? "";
  assert.ok(crons.includes(`"${PRIMARY_CRON}"`) && crons.includes(`"${WATCHDOG_CRON}"`), `crons=${crons}`);
  assert.ok(!/GITHUB_DISPATCH_TOKEN\s*=/.test(toml), "トークンをwrangler.tomlに書いてはいけません(wrangler secret put で登録する)");
  assert.ok(!/github_pat_|ghp_/.test(toml));
  assert.match(toml, /^GITHUB_REPO\s*=\s*"[^"]+\/[^"]+"/m);
  const index = readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  assert.match(index, /async scheduled\(event, env, ctx\) \{\s*ctx\.waitUntil\(handleScheduled\(event, env\)\);/);
  assert.match(index, /import \{ handleScheduled \} from "\.\/scheduler\.js";/);
  const wf = readFileSync(new URL("../.github/workflows/pipeline.yml", import.meta.url), "utf8");
  assert.match(wf, /workflow_dispatch:/);
  assert.match(wf, /^\s+universeMode:/m); // 起動時に渡す入力(未知の入力は422で拒否される)
});
