// pipeline の定刻起動(Cloudflare Workers の Cron Trigger から、GitHub の workflow_dispatch を呼ぶ)。
//
// 背景: GitHub Actions の schedule は、混雑すると数時間遅れたり、起動しないことがある(実際に、17時台のはずが22時台になった)。
//       Cron Trigger は定刻に動くので、そこから workflow_dispatch(手動実行と同じ経路)で起動する。
//
// 2本のcron(worker/wrangler.toml の [triggers] と一致させる。test/scheduler.test.js が検査する):
//   PRIMARY_CRON  : 17:10 JST  今日の実行が無ければ起動する
//   WATCHDOG_CRON : 17:40 JST  見張り。今日の実行が無い、または全て失敗していれば、もう一度起動する(1日の起動は最大2回)
//
// 必要なSecret: GITHUB_DISPATCH_TOKEN(このリポジトリのActionsだけに「Read and write」の権限を付けた、細粒度のトークン)。
//   登録: cd worker && npx wrangler secret put GITHUB_DISPATCH_TOKEN
// 変数(wrangler.toml の [vars]): GITHUB_REPO / GITHUB_WORKFLOW / GITHUB_REF / DRY_RUN("true"なら起動せず、判断だけをログに出す)
//
// 失敗・設定不備は、console.error と、D1の error_logs(source='scheduler')に記録する(記録に失敗しても処理は続ける)。

// 注意: Cloudflareのcronは、曜日が「1 = 日曜 〜 7 = 土曜」(一般的なcronの 1-5 は、ここでは「日〜木」になる)。平日は MON-FRI と書く。
export const PRIMARY_CRON = "10 8 * * MON-FRI";
export const WATCHDOG_CRON = "40 8 * * MON-FRI";

const API_BASE = "https://api.github.com";
// 16:00 JST(J-Quantsのデータ更新前)以降に作られた実行を「今日の実行」とみなす
const TODAY_WINDOW_START_UTC_HOUR = 7;
const MAX_ATTEMPTS_PER_DAY = 2;
const FAILED_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "startup_failure"]);

/** 「今日の実行」を数え始める時刻(ミリ秒)。cronが動いたUTC日の07:00(= 16:00 JST)。 */
export function windowStartMs(scheduledTimeMs) {
  const d = new Date(scheduledTimeMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), TODAY_WINDOW_START_UTC_HOUR, 0, 0);
}

/**
 * 起動するかどうかの判断。runsは、GitHubの実行の一覧(created_at・status・conclusion)。
 *  - primary : 今日の実行が1件も無ければ起動する(手動などで既に動いていれば、起動しない)
 *  - watchdog: 今日の実行が無ければ起動する。あっても、全て失敗(失敗・取消・タイムアウト)で、起動が上限未満なら、再度起動する
 *              実行中・待機中、または成功した実行があれば、何もしない
 */
export function decideAction(mode, runs, windowStart) {
  const today = (Array.isArray(runs) ? runs : []).filter((r) => Date.parse(r.created_at) >= windowStart);
  if (today.length === 0) return { action: "dispatch", reason: "今日の実行が見つからない" };
  if (mode === "primary") return { action: "none", reason: "今日の実行が既にある" };
  if (today.some((r) => r.status !== "completed")) return { action: "none", reason: "今日の実行が、実行中または待機中" };
  if (today.some((r) => r.conclusion === "success")) return { action: "none", reason: "今日の実行は成功している" };
  if (today.every((r) => FAILED_CONCLUSIONS.has(r.conclusion))) {
    if (today.length >= MAX_ATTEMPTS_PER_DAY) return { action: "none", reason: `今日の実行は失敗しているが、起動の上限(${MAX_ATTEMPTS_PER_DAY}回)に達している` };
    return { action: "dispatch", reason: "今日の実行が失敗したため、再度起動する" };
  }
  return { action: "none", reason: "今日の実行は、成功でも失敗でもない結果(skippedなど)で終わっている" };
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "jp-stock-ai-scheduler", // GitHub APIは User-Agent が必須
    "Content-Type": "application/json",
  };
}

const mask = (text, token) => (token ? String(text).split(token).join("***") : String(text));

/** workflow_dispatch を呼ぶ。成功は 204。 */
export async function dispatchWorkflow({ repo, workflow, ref, inputs, token, fetchFn = fetch }) {
  const res = await fetchFn(`${API_BASE}/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify({ ref, inputs }),
  });
  if (res.status === 204) return { ok: true, status: 204 };
  let detail = "";
  try {
    detail = (await res.text()).slice(0, 300);
  } catch {
    // 本文が読めなくても、状態だけ返す
  }
  return { ok: false, status: res.status, message: mask(`GitHub APIが${res.status}を返しました(起動)${detail ? `: ${detail}` : ""}`, token) };
}

/** sinceMs以降に作られた実行を取得する(新しい順)。 */
export async function listRecentRuns({ repo, workflow, sinceMs, token, fetchFn = fetch }) {
  const since = new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  const url = `${API_BASE}/repos/${repo}/actions/workflows/${workflow}/runs?per_page=20&created=${encodeURIComponent(`>=${since}`)}`;
  const res = await fetchFn(url, { headers: githubHeaders(token) });
  if (!res.ok) throw new Error(mask(`GitHub APIが${res.status}を返しました(実行履歴の取得)`, token));
  const json = await res.json();
  return Array.isArray(json.workflow_runs) ? json.workflow_runs : [];
}

/** D1のerror_logsに記録する(記録に失敗しても、例外にしない)。 */
async function recordError(env, errorType, message, context) {
  try {
    if (!env.DB) return;
    await env.DB.prepare("INSERT INTO error_logs (occurred_at, source, error_type, message, context) VALUES (?, ?, ?, ?, ?)")
      .bind(new Date().toISOString(), "scheduler", errorType, message, context ? JSON.stringify(context) : null)
      .run();
  } catch {
    // 記録できなくても、起動の処理は続ける
  }
}

/** Cron Trigger のハンドラ本体。テストできるよう、fetch・時刻・ログを差し替えられる。 */
export async function handleScheduled(event, env, { fetchFn = fetch, now = Date.now, logger = console } = {}) {
  const mode = event.cron === PRIMARY_CRON ? "primary" : event.cron === WATCHDOG_CRON ? "watchdog" : null;
  if (!mode) {
    logger.warn(`[scheduler] 想定していないcronです: ${event.cron}`);
    return { action: "none", reason: "想定していないcron" };
  }
  const repo = env.GITHUB_REPO;
  const workflow = env.GITHUB_WORKFLOW || "pipeline.yml";
  const ref = env.GITHUB_REF || "main";
  const token = env.GITHUB_DISPATCH_TOKEN;
  if (!repo || !token) {
    const message = `設定が足りません(${!repo ? "GITHUB_REPO" : ""}${!repo && !token ? "・" : ""}${!token ? "GITHUB_DISPATCH_TOKEN" : ""})`;
    logger.error(`[scheduler] ${message}`);
    await recordError(env, "config_missing", message, { mode });
    return { action: "error", message };
  }
  try {
    const runs = await listRecentRuns({ repo, workflow, sinceMs: windowStartMs(event.scheduledTime ?? now()), token, fetchFn });
    const decision = decideAction(mode, runs, windowStartMs(event.scheduledTime ?? now()));
    if (decision.action !== "dispatch") {
      logger.log(`[scheduler] ${mode}: 起動しません(${decision.reason})`);
      return decision;
    }
    if (env.DRY_RUN === "true") {
      logger.log(`[scheduler] ${mode}: DRY_RUNのため起動しません(起動する判断: ${decision.reason})`);
      return { action: "dry-run", reason: decision.reason };
    }
    // 手動実行の既定は開発用の少数銘柄(phase1_subset)なので、必ず全銘柄モードを指定する
    const result = await dispatchWorkflow({ repo, workflow, ref, inputs: { universeMode: "all" }, token, fetchFn });
    if (!result.ok) throw new Error(result.message);
    logger.log(`[scheduler] ${mode}: ${workflow} を起動しました(${decision.reason})`);
    return { action: "dispatched", reason: decision.reason };
  } catch (err) {
    const message = mask(err?.message ?? String(err), token);
    logger.error(`[scheduler] ${mode}: 失敗しました: ${message}`);
    await recordError(env, "dispatch_failed", message, { mode });
    return { action: "error", message };
  }
}
