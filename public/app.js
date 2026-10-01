// Cloudflare Workers API のベースURL。
const API_BASE = "https://jp-stock-ai-app-api.yk0314.workers.dev";

// ランキングは、APIから多めに取得し(保有銘柄の除外・並べ替えの後でも候補が減らないようにする)、
// 画面には上位N件だけを表示する。
const RANKING_FETCH_LIMIT = 100;
const RANKING_DISPLAY_LIMIT = 20;

async function fetchJson(path) {
  const res = await fetch(API_BASE + path);
  if (!res.ok) {
    throw new Error(`API error: ${res.status}`);
  }
  return res.json();
}

/**
 * JSONをPOSTする。エラー時もレスポンス本文(error)を読めるよう、例外にはせず結果を返す。
 * @returns {Promise<{ok:boolean, status:number, body:any}>}
 */
async function postJson(path, payload) {
  const res = await fetch(API_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

// ---- フォーマット用ヘルパー ----

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function formatPercent(value) {
  if (value === null || value === undefined) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value}%`;
}

/** 小数を丸めて符号付きの%表記にする。値が無ければ「—」。 */
function fmtPct(value, digits = 1, signed = true) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  const rounded = Math.round(Number(value) * 10 ** digits) / 10 ** digits;
  const sign = signed && rounded > 0 ? "+" : "";
  return `${sign}${rounded.toFixed(digits)}%`;
}

function percentClass(value) {
  if (value === null || value === undefined) return "";
  return value > 0 ? "positive" : value < 0 ? "negative" : "";
}

function formatYen(value) {
  if (value === null || value === undefined) return "-";
  return `¥${Math.round(Number(value)).toLocaleString()}`;
}

function formatSignedYen(value) {
  if (value === null || value === undefined) return "-";
  const rounded = Math.round(Number(value));
  const sign = rounded > 0 ? "+" : "";
  return `${sign}¥${rounded.toLocaleString()}`;
}

/** 値が無いときは「—」を返す円表記。 */
function yenOrDash(value) {
  return value === null || value === undefined ? "—" : formatYen(value);
}

function signedYenOrDash(value) {
  return value === null || value === undefined ? "—" : formatSignedYen(value);
}

/** 端末のローカル日付(YYYY-MM-DD)。日本時間の朝にUTC日付だと前日になってしまうのを避ける。 */
function todayLocalStr() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const RATING_LABELS = { BUY: "買い", HOLD: "様子見", SELL: "売り" };
const RISK_LABELS = { LOW: "低", MEDIUM: "中", HIGH: "高" };

function ratingBadge(rating) {
  const label = RATING_LABELS[rating] ?? rating ?? "-";
  const cls = (rating ?? "").toLowerCase();
  return `<span class="badge badge-rating badge-${cls}">${label}</span>`;
}

function riskBadge(risk) {
  const label = RISK_LABELS[risk] ?? risk ?? "-";
  const cls = (risk ?? "").toLowerCase();
  return `<span class="badge badge-risk badge-risk-${cls}">${label}リスク</span>`;
}

// ---- モーダル ----

function showModal(id) {
  document.getElementById(id).hidden = false;
  document.body.style.overflow = "hidden";
}

function hideModal(id) {
  document.getElementById(id).hidden = true;
  if (![...document.querySelectorAll(".modal")].some((m) => !m.hidden)) {
    document.body.style.overflow = "";
  }
}

document.addEventListener("click", (e) => {
  const closer = e.target.closest("[data-modal-close]");
  if (closer) {
    const modal = closer.closest(".modal");
    if (modal) hideModal(modal.id);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  document.querySelectorAll(".modal").forEach((m) => {
    if (!m.hidden) hideModal(m.id);
  });
});

function setMessage(el, text, kind) {
  el.textContent = text ?? "";
  el.className = "form-message" + (kind === "success" ? " form-message-success" : kind === "error" ? " form-message-error" : "");
}

// ---- AI評価の比較(購入時→現在、前回→現在) ----

const RATING_ORDER = { BUY: 0, HOLD: 1, SELL: 2 };

function scoreDelta(from, to) {
  if (!from || !to || from.score === null || from.score === undefined || to.score === null || to.score === undefined) return null;
  return Math.round((to.score - from.score) * 10) / 10;
}

function deltaSpan(delta) {
  if (delta === null) return `<span class="delta-flat">—</span>`;
  if (delta > 0) return `<span class="delta-up num">▲ +${delta}</span>`;
  if (delta < 0) return `<span class="delta-down num">▼ ${delta}</span>`;
  return `<span class="delta-flat num">± 0</span>`;
}

/** BUY/HOLD/SELLの変化を「買い → 様子見」のような表示にする。変化が無ければ「変化なし」。 */
function ratingChangeSpan(from, to) {
  if (!from || !to) return `<span class="delta-flat">—</span>`;
  if (from.rating === to.rating) {
    return `<span class="delta-flat">${RATING_LABELS[to.rating] ?? to.rating ?? "-"}（変化なし）</span>`;
  }
  const fromRank = RATING_ORDER[from.rating] ?? 99;
  const toRank = RATING_ORDER[to.rating] ?? 99;
  const cls = toRank > fromRank ? "delta-down" : "delta-up";
  return `<span class="${cls}">${RATING_LABELS[from.rating] ?? from.rating} → ${RATING_LABELS[to.rating] ?? to.rating}</span>`;
}

function evalStep(label, evaluation) {
  const body = evaluation
    ? `${ratingBadge(evaluation.rating)}<span>${evaluation.score ?? "-"}</span>`
    : `<span class="delta-flat">—</span>`;
  return `<div class="eval-step"><span class="eval-step-label">${label}</span><div class="eval-step-body">${body}</div></div>`;
}

/** 保有銘柄カード内の「AI評価の変化」ブロック。 */
function renderEvalChange(holding) {
  const latest = holding.latestEvaluation;
  const previous = holding.previousEvaluation;
  const purchase = holding.purchaseEvaluation;
  if (!latest) {
    return `<div class="eval-change"><div class="eval-change-title">AI評価の変化</div><span class="meta-line">この銘柄のAI評価はまだありません。</span></div>`;
  }

  const lines = [];
  if (purchase && purchase.id !== latest.id) {
    lines.push(
      `<span>購入時→現在: ${ratingChangeSpan(purchase, latest)} ／ スコア ${deltaSpan(scoreDelta(purchase, latest))}</span>`
    );
  } else if (purchase) {
    lines.push(`<span>購入時の評価が最新です（その後の再評価はまだありません）。</span>`);
  } else {
    lines.push(`<span class="meta-line">購入時のAI評価は記録されていません。</span>`);
  }
  if (previous) {
    lines.push(`<span>前回→現在: ${ratingChangeSpan(previous, latest)} ／ スコア ${deltaSpan(scoreDelta(previous, latest))}</span>`);
  }

  return `
    <div class="eval-change">
      <div class="eval-change-title">AI評価の変化</div>
      <div class="eval-change-row">
        ${evalStep("購入時", purchase)}
        ${evalStep("前回", previous)}
        ${evalStep("現在", latest)}
      </div>
      <div class="eval-change-summary">${lines.join("")}</div>
    </div>
  `;
}

// ---- ランキングの並び替え・絞り込み ----

const RATING_SORT_ORDER = { BUY: 0, HOLD: 1, SELL: 2 };
const RISK_SORT_ORDER = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/**
 * 保有中の銘柄をランキングから除外する。APIのデータ構造・順序ロジックには手を入れず、
 * Frontend側でクライアントサイドフィルタ+ソートするだけに留める。
 */
function excludeHeldCodes(ranking, heldCodes) {
  return ranking.filter((r) => !heldCodes.has(r.code));
}

/**
 * BUY優先 → 低リスク優先 → 期待リターン大きい順 → 想定保有日数短い順、の多段階ソート。
 */
function sortRankingForDisplay(ranking) {
  return [...ranking].sort((a, b) => {
    const ratingDiff = (RATING_SORT_ORDER[a.rating] ?? 99) - (RATING_SORT_ORDER[b.rating] ?? 99);
    if (ratingDiff !== 0) return ratingDiff;
    const riskDiff = (RISK_SORT_ORDER[a.risk] ?? 99) - (RISK_SORT_ORDER[b.risk] ?? 99);
    if (riskDiff !== 0) return riskDiff;
    const returnDiff = (b.expectedReturn ?? -Infinity) - (a.expectedReturn ?? -Infinity);
    if (returnDiff !== 0) return returnDiff;
    return (a.expectedHoldingDays ?? Infinity) - (b.expectedHoldingDays ?? Infinity);
  });
}

// ---- 保有銘柄の「今どうすべきか」判定(UI表示用の簡易ヒント。バックエンドの判定ロジックは追加しない) ----

function judgeHoldingAttention(holding) {
  const evaluation = holding.latestEvaluation;
  if (!evaluation) {
    return { needsAttention: false, hint: "AI評価待ち", hintClass: "" };
  }
  if (evaluation.rating === "SELL") {
    return { needsAttention: true, reason: "SELL評価", hint: "売却を検討", hintClass: "action-hint-sell" };
  }
  if (evaluation.rating === "HOLD" && evaluation.risk === "HIGH") {
    return { needsAttention: true, reason: "HOLDだが高リスク", hint: "様子見・要注意", hintClass: "action-hint-hold" };
  }
  if (evaluation.expectedReturn !== null && evaluation.expectedReturn !== undefined && evaluation.expectedReturn < 0) {
    return { needsAttention: true, reason: "期待リターンがマイナス", hint: "売却を検討", hintClass: "action-hint-sell" };
  }
  if (evaluation.rating === "BUY") {
    return { needsAttention: false, hint: "保有継続・追加も選択肢", hintClass: "action-hint-buy" };
  }
  return { needsAttention: false, hint: "保有継続", hintClass: "action-hint-hold" };
}

// ---- ナビゲーション ----

function setActiveNav(route) {
  document.querySelectorAll(".top-nav-link, .bottom-nav-link").forEach((el) => {
    el.classList.toggle("active", el.dataset.route === route);
  });
}

// ---- ホーム画面 ----

function renderAlertZone(holdings) {
  const el = document.getElementById("home-alert-zone");
  if (holdings.length === 0) {
    el.innerHTML = `
      <div class="alert-zone">
        <div class="alert-zone-head"><h2>今すぐ確認</h2></div>
        <div class="no-data">保有銘柄がありません。売買履歴から取引を登録すると、ここに表示されます。</div>
      </div>
    `;
    return;
  }

  const attentionList = holdings
    .map((h) => ({ holding: h, judgement: judgeHoldingAttention(h) }))
    .filter((x) => x.judgement.needsAttention);

  if (attentionList.length === 0) {
    el.innerHTML = `
      <div class="alert-zone">
        <div class="alert-zone-head"><h2>今すぐ確認</h2></div>
        <div class="alert-calm">
          <span class="alert-calm-icon">✓</span>
          <span>現在、緊急に確認が必要な保有銘柄はありません。</span>
        </div>
      </div>
    `;
    return;
  }

  el.innerHTML = `
    <div class="alert-zone">
      <div class="alert-zone-head">
        <h2>今すぐ確認</h2>
        <span class="alert-count">${attentionList.length}件</span>
      </div>
      ${attentionList
        .map(({ holding, judgement }) => `
          <a class="alert-card" href="#/stock/${encodeURIComponent(holding.code)}">
            <div class="alert-card-top">
              ${ratingBadge(holding.latestEvaluation.rating)}
              ${riskBadge(holding.latestEvaluation.risk)}
              <span class="stock-code">${holding.code}</span>
              <span class="stock-name">${esc(holding.name ?? "銘柄名未取得")}</span>
            </div>
            <div class="alert-reason">
              ${judgement.reason} ／ 保有 ${holding.quantity.toLocaleString()}株 ／
              評価損益 <span class="num ${percentClass(holding.unrealizedPnl)}">${formatSignedYen(holding.unrealizedPnl)}</span>
              (${formatPercent(holding.unrealizedPnlPct !== null ? Math.round(holding.unrealizedPnlPct * 10) / 10 : null)})
            </div>
          </a>
        `)
        .join("")}
    </div>
  `;
}

function renderStatsStrip(holdings, meta) {
  const el = document.getElementById("home-stats");
  const totalPnl = holdings.reduce((sum, h) => sum + (h.unrealizedPnl ?? 0), 0);
  const hasPnl = holdings.some((h) => h.unrealizedPnl !== null);
  el.innerHTML = `
    <div class="stat-cell">
      <div class="stat-label">保有銘柄数</div>
      <div class="stat-value num">${holdings.length}</div>
    </div>
    <div class="stat-cell">
      <div class="stat-label">評価損益合計</div>
      <div class="stat-value num ${percentClass(totalPnl)}">${hasPnl ? formatSignedYen(totalPnl) : "-"}</div>
    </div>
    <div class="stat-cell">
      <div class="stat-label">データ基準日</div>
      <div class="stat-value num">${meta?.cutoffDate ?? "-"}</div>
    </div>
  `;
}

async function loadHome() {
  const rankingPreviewEl = document.getElementById("home-ranking-preview");
  const holdingsPreviewEl = document.getElementById("home-holdings-preview");
  document.getElementById("home-alert-zone").innerHTML = "読み込み中...";
  document.getElementById("home-stats").innerHTML = "";
  rankingPreviewEl.textContent = "読み込み中...";
  holdingsPreviewEl.textContent = "読み込み中...";

  try {
    const [ranking, holdings, meta] = await Promise.all([
      fetchJson(`/api/ranking?limit=${RANKING_FETCH_LIMIT}`),
      fetchJson("/api/holdings"),
      fetchJson("/api/meta"),
    ]);

    renderAlertZone(holdings);
    renderStatsStrip(holdings, meta);

    const heldCodes = new Set(holdings.map((h) => h.code));
    const displayRanking = sortRankingForDisplay(excludeHeldCodes(ranking, heldCodes)).slice(0, 4);
    rankingPreviewEl.innerHTML = displayRanking.length
      ? displayRanking.map((item, i) => renderRankingCard(item, i + 1)).join("")
      : ranking.length === 0
        ? `<div class="no-data">本日のランキングデータがありません。</div>`
        : `<div class="no-data">現在、購入候補となる評価結果がありません。</div>`;

    const dateByCode = await getLatestBuyDateByCode();
    const sortedHoldings = sortHoldingsByAcquisitionDesc(holdings, dateByCode);
    holdingsPreviewEl.innerHTML = sortedHoldings.length
      ? sortedHoldings
          .slice(0, 3)
          .map((h) => renderHoldingCard(h, h.lastBuyDate ?? dateByCode.get(h.code), { detailed: false }))
          .join("")
      : `<div class="no-data">保有銘柄がありません。</div>`;
  } catch (err) {
    document.getElementById("home-alert-zone").innerHTML = `<div class="no-data">データを取得できませんでした。</div>`;
    rankingPreviewEl.innerHTML = "";
    holdingsPreviewEl.innerHTML = "";
  }
}

// ---- ランキング画面 ----

function renderMeta(meta) {
  const el = document.getElementById("meta-info");
  if (!meta || !meta.cutoffDate) {
    el.textContent = "データ基準日: 未取得";
    return;
  }
  el.textContent =
    `データ基準日: ${meta.cutoffDate} ／ 更新: ${meta.predictionExecutedAt ? meta.predictionExecutedAt.slice(0, 16).replace("T", " ") : "-"}`;
}

function renderRankingCard(item, rank) {
  return `
    <a class="rank-card" href="#/stock/${encodeURIComponent(item.code)}" data-code="${item.code}">
      <div class="rank-card-top">
        <span class="rank-number">${rank}</span>
        <div class="rank-card-title">
          <span class="stock-code">${item.code}</span>
          <span class="stock-name">${esc(item.name ?? "銘柄名未取得")}</span>
        </div>
        <span class="ai-score">${item.score ?? "-"}<small>/100</small></span>
      </div>
      <div class="rank-card-badges">
        ${ratingBadge(item.rating)}
        ${riskBadge(item.risk)}
      </div>
      <div class="rank-card-metrics">
        <div class="metric">
          <span class="metric-label">評価時株価</span>
          <span class="metric-value num">${formatYen(item.priceAtEvaluation)}</span>
        </div>
        <div class="metric">
          <span class="metric-label">期待リターン</span>
          <span class="metric-value num ${percentClass(item.expectedReturn)}">${formatPercent(item.expectedReturn)}</span>
        </div>
        <div class="metric">
          <span class="metric-label">想定保有日数</span>
          <span class="metric-value num">${item.expectedHoldingDays ?? "-"}日</span>
        </div>
      </div>
      ${item.summary ? `<p class="rank-card-summary">${esc(item.summary)}</p>` : ""}
      <div class="meta-line">評価日: ${item.evaluationDate ?? "-"} ／ データ基準日: ${item.dataAsOfDate ?? "-"}</div>
    </a>
  `;
}

async function loadRanking() {
  const el = document.getElementById("ranking-list");
  el.textContent = "読み込み中...";
  try {
    const [ranking, holdings] = await Promise.all([
      fetchJson(`/api/ranking?limit=${RANKING_FETCH_LIMIT}`),
      fetchJson("/api/holdings"),
    ]);
    if (ranking.length === 0) {
      el.innerHTML = `<div class="no-data">本日のランキングデータがありません。</div>`;
      return;
    }
    const heldCodes = new Set(holdings.map((h) => h.code));
    const display = sortRankingForDisplay(excludeHeldCodes(ranking, heldCodes)).slice(0, RANKING_DISPLAY_LIMIT);
    el.innerHTML = display.length
      ? display.map((item, i) => renderRankingCard(item, i + 1)).join("")
      : `<div class="no-data">現在、表示できる評価結果がありません（保有銘柄は除外されています）。</div>`;
  } catch (err) {
    el.innerHTML = `<div class="no-data">現在データを取得できませんでした。しばらくしてから再度お試しください。</div>`;
  }
}

// ---- 銘柄詳細画面 ----

function formatDateShort(dateStr) {
  if (!dateStr) return "";
  const parts = dateStr.split("-");
  return parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : dateStr;
}

function renderPriceChart(prices) {
  if (!prices || prices.length === 0) {
    return `<div class="no-data">株価データがありません（この銘柄はスクリーニングプール対象外の可能性があります）。</div>`;
  }

  const width = 640;
  const height = 220;
  const padding = { top: 12, right: 12, bottom: 24, left: 58 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const closes = prices.map((p) => p.close).filter((c) => c !== null && c !== undefined);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;

  const points = prices.map((p, i) => {
    const x = padding.left + (i / Math.max(prices.length - 1, 1)) * plotWidth;
    const y = padding.top + plotHeight - ((p.close - min) / range) * plotHeight;
    return { x, y, ...p };
  });

  const pathD = points.map((pt, i) => `${i === 0 ? "M" : "L"} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const first = points[0];
  const trendClass = last.close >= first.close ? "positive" : "negative";

  const yTicks = [max, (max + min) / 2, min];
  const yTickSvg = yTicks
    .map((v) => {
      const y = padding.top + plotHeight - ((v - min) / range) * plotHeight;
      return `
        <line x1="${padding.left}" y1="${y.toFixed(1)}" x2="${width - padding.right}" y2="${y.toFixed(1)}" class="chart-gridline" />
        <text x="${padding.left - 8}" y="${y.toFixed(1)}" class="chart-axis-label" text-anchor="end" dominant-baseline="middle">¥${Math.round(v).toLocaleString()}</text>
      `;
    })
    .join("");

  const xLabelIndexes = [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const xTickSvg = [...new Set(xLabelIndexes)]
    .map((i) => {
      const pt = points[i];
      return `<text x="${pt.x.toFixed(1)}" y="${height - 6}" class="chart-axis-label" text-anchor="middle">${formatDateShort(pt.date)}</text>`;
    })
    .join("");

  return `
    <div class="chart-wrap">
      <svg viewBox="0 0 ${width} ${height}" class="price-chart ${trendClass}" role="img" aria-label="株価推移チャート">
        ${yTickSvg}
        <path d="${pathD}" class="chart-line" fill="none" />
        <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="3.5" class="chart-last-point" />
        ${xTickSvg}
      </svg>
      <div class="chart-range-note">表示期間: ${prices[0].date} 〜 ${prices[prices.length - 1].date}（${prices.length}営業日分）</div>
    </div>
  `;
}

function renderEvaluationBlock(evaluation) {
  if (!evaluation) {
    return `<div class="no-data">この銘柄はAI分析の対象外でした（スクリーニングで選定された候補のみ分析されます）。</div>`;
  }
  return `
    <div class="eval-block">
      <div class="eval-top">
        ${ratingBadge(evaluation.rating)}
        ${riskBadge(evaluation.risk)}
        <span class="ai-score">${evaluation.score ?? "-"}<small>/100</small></span>
      </div>
      <div class="detail-metrics">
        <div class="metric">
          <span class="metric-label">期待リターン</span>
          <span class="metric-value num ${percentClass(evaluation.expectedReturn)}">${formatPercent(evaluation.expectedReturn)}</span>
        </div>
        <div class="metric">
          <span class="metric-label">想定保有日数</span>
          <span class="metric-value num">${evaluation.expectedHoldingDays ?? "-"}日</span>
        </div>
        <div class="metric">
          <span class="metric-label">上昇確率</span>
          <span class="metric-value num">${evaluation.upsideProbability ?? "-"}%</span>
        </div>
        <div class="metric">
          <span class="metric-label">下落リスク</span>
          <span class="metric-value num">${evaluation.downsideRisk ?? "-"}%</span>
        </div>
        <div class="metric">
          <span class="metric-label">信頼度</span>
          <span class="metric-value num">${evaluation.confidence ?? "-"}%</span>
        </div>
        <div class="metric">
          <span class="metric-label">評価時株価</span>
          <span class="metric-value num">${formatYen(evaluation.priceAtEvaluation)}</span>
        </div>
      </div>
      ${evaluation.summary ? `<p class="eval-summary">${esc(evaluation.summary)}</p>` : ""}
      ${evaluation.reasoning ? `<details class="eval-reasoning"><summary>判断理由の詳細</summary><p>${esc(evaluation.reasoning)}</p></details>` : ""}
      <div class="meta-line">評価日: ${evaluation.evaluationDate ?? "-"} ／ データ基準日: ${evaluation.dataAsOfDate ?? "-"}</div>
    </div>
  `;
}

/** AI評価のスコア推移(古い順に渡す)。 */
function renderScoreChart(evaluationsAsc) {
  const points = evaluationsAsc.filter((e) => e.score !== null && e.score !== undefined);
  if (points.length < 2) return "";

  const width = 640;
  const height = 150;
  const padding = { top: 12, right: 14, bottom: 24, left: 34 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const xy = points.map((e, i) => ({
    x: padding.left + (i / (points.length - 1)) * plotWidth,
    y: padding.top + plotHeight - (Math.max(0, Math.min(100, e.score)) / 100) * plotHeight,
    e,
  }));
  const pathD = xy.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const grid = [0, 50, 100]
    .map((v) => {
      const y = padding.top + plotHeight - (v / 100) * plotHeight;
      return `
        <line x1="${padding.left}" y1="${y.toFixed(1)}" x2="${width - padding.right}" y2="${y.toFixed(1)}" class="chart-gridline" />
        <text x="${padding.left - 6}" y="${y.toFixed(1)}" class="chart-axis-label" text-anchor="end" dominant-baseline="middle">${v}</text>
      `;
    })
    .join("");
  const labelIdx = [...new Set([0, Math.floor((xy.length - 1) / 2), xy.length - 1])];
  const xLabels = labelIdx
    .map((i) => `<text x="${xy[i].x.toFixed(1)}" y="${height - 6}" class="chart-axis-label" text-anchor="middle">${formatDateShort(xy[i].e.evaluationDate)}</text>`)
    .join("");
  const dots = xy
    .map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" class="chart-point"><title>${esc(p.e.evaluationDate)} スコア${p.e.score}（${esc(RATING_LABELS[p.e.rating] ?? p.e.rating)}）</title></circle>`)
    .join("");

  return `
    <div class="chart-wrap">
      <svg viewBox="0 0 ${width} ${height}" class="score-chart" role="img" aria-label="AIスコアの推移">
        ${grid}
        <path d="${pathD}" class="chart-line" fill="none" />
        ${dots}
        ${xLabels}
      </svg>
      <div class="chart-range-note">AIスコアの推移（${points.length}回の評価）</div>
    </div>
  `;
}

/**
 * 銘柄のAI評価履歴(新しい順に渡す)。購入時の評価は、purchaseEvaluationIds(Set)に含まれるidで判定する。
 */
function renderEvaluationHistory(evaluations, purchaseEvaluationIds) {
  if (evaluations === null) {
    return `<div class="no-data">AI評価の履歴を取得できませんでした。</div>`;
  }
  if (evaluations.length === 0) {
    return `<div class="no-data">この銘柄のAI評価の履歴はまだありません。</div>`;
  }

  const latest = evaluations[0];
  const purchase = evaluations.find((e) => purchaseEvaluationIds.has(e.id));
  let compare = "";
  if (purchase && purchase.id !== latest.id) {
    compare = `
      <div class="eval-compare">
        <span>購入時 ${ratingBadge(purchase.rating)} <span class="num">${purchase.score ?? "-"}</span></span>
        <span class="eval-compare-arrow">→</span>
        <span>現在 ${ratingBadge(latest.rating)} <span class="num">${latest.score ?? "-"}</span></span>
        <span>${ratingChangeSpan(purchase, latest)}</span>
        <span>スコア ${deltaSpan(scoreDelta(purchase, latest))}</span>
      </div>`;
  } else if (evaluations.length >= 2) {
    const previous = evaluations[1];
    compare = `
      <div class="eval-compare">
        <span>前回 ${ratingBadge(previous.rating)} <span class="num">${previous.score ?? "-"}</span></span>
        <span class="eval-compare-arrow">→</span>
        <span>最新 ${ratingBadge(latest.rating)} <span class="num">${latest.score ?? "-"}</span></span>
        <span>${ratingChangeSpan(previous, latest)}</span>
        <span>スコア ${deltaSpan(scoreDelta(previous, latest))}</span>
      </div>`;
  }

  const chart = renderScoreChart([...evaluations].reverse());

  const items = evaluations
    .map((e, i) => {
      const older = evaluations[i + 1] ?? null;
      const tags = [
        i === 0 ? `<span class="badge badge-gold">最新</span>` : "",
        purchaseEvaluationIds.has(e.id) ? `<span class="badge badge-gold">購入時</span>` : "",
        e.source && e.source !== "pipeline" ? `<span class="badge badge-soft">保有銘柄の再評価</span>` : "",
      ].join("");
      const change = older
        ? `<span class="meta-line">前回比 ${ratingChangeSpan(older, e)} ／ ${deltaSpan(scoreDelta(older, e))}</span>`
        : `<span class="meta-line">最初の評価</span>`;
      return `
        <div class="eval-timeline-item${purchaseEvaluationIds.has(e.id) ? " purchase" : ""}">
          <div class="eval-timeline-when">
            <span class="num">${esc(e.evaluationDate ?? "-")}</span>
            <span>データ基準日 ${esc(e.dataAsOfDate ?? "-")}</span>
            <div class="eval-timeline-tags">${tags}</div>
          </div>
          <div class="eval-timeline-main">
            ${ratingBadge(e.rating)}
            ${riskBadge(e.risk)}
            <span class="ai-score">${e.score ?? "-"}<small>/100</small></span>
          </div>
          <div class="eval-timeline-metrics">
            <span>期待リターン ${formatPercent(e.expectedReturn)}</span>
            <span>保有日数 ${e.expectedHoldingDays ?? "-"}日</span>
            ${change}
          </div>
        </div>`;
    })
    .join("");

  return `${compare}${chart}<div class="eval-timeline">${items}</div>`;
}

async function loadDetail(code) {
  const el = document.getElementById("detail-content");
  el.innerHTML = "読み込み中...";
  try {
    const [stock, prices, evaluations, trades] = await Promise.all([
      fetchJson(`/api/stocks/${encodeURIComponent(code)}`),
      fetchJson(`/api/stocks/${encodeURIComponent(code)}/prices`),
      // 評価履歴・売買履歴は補助情報のため、取得に失敗しても詳細画面自体は表示する
      fetchJson(`/api/stocks/${encodeURIComponent(code)}/evaluations?limit=30`).catch(() => null),
      fetchJson(`/api/trades?code=${encodeURIComponent(code)}`).catch(() => []),
    ]);

    const purchaseEvaluationIds = new Set(
      (trades ?? []).filter((t) => t.transactionType === "buy" && t.purchaseEvaluationId).map((t) => t.purchaseEvaluationId)
    );

    el.innerHTML = `
      <div class="detail-header">
        <span class="stock-code">${stock.code}</span>
        <h2 class="stock-name">${esc(stock.name ?? "銘柄名未取得")}</h2>
        ${stock.market ? `<span class="market-tag">${esc(stock.market)}</span>` : ""}
      </div>
      <div class="current-price-line">
        現在価格: <strong class="num">${formatYen(stock.price)}</strong>
        <span class="meta-line">（データ基準日: ${stock.dataAsOf ?? "-"}）</span>
      </div>

      <h3 class="detail-subhead">株価チャート</h3>
      ${renderPriceChart(prices)}

      <h3 class="detail-subhead">AI評価</h3>
      ${renderEvaluationBlock(stock.latestEvaluation)}

      <h3 class="detail-subhead">AI評価の履歴</h3>
      ${renderEvaluationHistory(evaluations, purchaseEvaluationIds)}
    `;
  } catch (err) {
    el.innerHTML = `<div class="no-data">この銘柄コードのデータを取得できませんでした（コードが正しいかご確認ください）。</div>`;
  }
}

// ---- 保有銘柄画面 ----

let cachedLatestBuyDateByCode = null;
let currentHoldings = [];

/**
 * 各銘柄コードについて、最も新しいBUY取引の約定日を取得する。
 * /api/holdingsのlastBuyDateを優先して使うが、互換のため/api/tradesからの導出も残している
 * （/api/tradesは取消済みを除外して返すので、取消したBUYの日付は使われない）。
 */
async function getLatestBuyDateByCode() {
  if (cachedLatestBuyDateByCode) return cachedLatestBuyDateByCode;
  try {
    const trades = await fetchJson("/api/trades");
    const map = new Map();
    for (const t of trades) {
      if (t.transactionType !== "buy") continue;
      const current = map.get(t.code);
      if (!current || t.transactionDate > current) {
        map.set(t.code, t.transactionDate);
      }
    }
    cachedLatestBuyDateByCode = map;
    return map;
  } catch {
    return new Map();
  }
}

function sortHoldingsByAcquisitionDesc(holdings, latestBuyDateByCode) {
  return [...holdings].sort((a, b) => {
    const dateA = a.lastBuyDate ?? latestBuyDateByCode.get(a.code) ?? "";
    const dateB = b.lastBuyDate ?? latestBuyDateByCode.get(b.code) ?? "";
    if (dateA === dateB) return 0;
    return dateA < dateB ? 1 : -1; // 新しい日付が先
  });
}

/**
 * 保有銘柄カード。detailed=true(保有銘柄画面)のときは、AI評価の変化と「売却(SELL登録)」ボタンも表示する。
 * false(ホームのプレビュー)のときは従来どおりのコンパクト表示。
 */
function renderHoldingCard(h, acquisitionDate, { detailed = true } = {}) {
  const judgement = judgeHoldingAttention(h);
  const pnlPct = h.unrealizedPnlPct !== null ? Math.round(h.unrealizedPnlPct * 10) / 10 : null;
  return `
    <div class="holding-card" data-code="${h.code}">
      <a class="holding-card-link" href="#/stock/${encodeURIComponent(h.code)}">
        <div class="holding-card-top">
          <div class="rank-card-title">
            <span class="stock-code">${h.code}</span>
            <span class="stock-name">${esc(h.name ?? "銘柄名未取得")}</span>
          </div>
          <div class="holding-pnl">
            <div class="holding-pnl-value num ${percentClass(h.unrealizedPnl)}">${formatSignedYen(h.unrealizedPnl)}</div>
            <div class="holding-pnl-pct num ${percentClass(h.unrealizedPnl)}">${formatPercent(pnlPct)}</div>
          </div>
        </div>
        <div class="holding-card-badges">
          <span class="meta-line holding-acquired-date">取得日: ${acquisitionDate ?? "-"}</span>
          <span class="holding-badge-group">
            ${h.latestEvaluation ? ratingBadge(h.latestEvaluation.rating) : ""}
            ${h.latestEvaluation ? riskBadge(h.latestEvaluation.risk) : ""}
            ${h.latestEvaluation ? `<span class="badge badge-gold num">スコア ${h.latestEvaluation.score ?? "-"}</span>` : ""}
          </span>
        </div>
        <div class="holding-metrics">
          <div class="metric">
            <span class="metric-label">保有数量</span>
            <span class="metric-value num">${h.quantity.toLocaleString()}株</span>
          </div>
          <div class="metric">
            <span class="metric-label">平均取得単価</span>
            <span class="metric-value num">${formatYen(h.avgCost)}</span>
          </div>
          <div class="metric">
            <span class="metric-label">現在価格</span>
            <span class="metric-value num">${formatYen(h.currentPrice)}</span>
          </div>
          <div class="metric">
            <span class="metric-label">期待リターン</span>
            <span class="metric-value num ${percentClass(h.latestEvaluation?.expectedReturn)}">${
    h.latestEvaluation ? formatPercent(h.latestEvaluation.expectedReturn) : "-"
  }</span>
          </div>
        </div>
        <div class="holding-action-hint">
          今どうすべきか: <span class="${judgement.hintClass}">${judgement.hint}</span>
        </div>
      </a>
      ${detailed ? renderEvalChange(h) : ""}
      ${
        detailed
          ? `<div class="holding-actions">
               <span class="meta-line">売却したら、ここから約定内容を記録します。</span>
               <button type="button" class="small-button sell-action" data-action="sell" data-code="${h.code}">売却（SELL登録）</button>
             </div>`
          : ""
      }
    </div>
  `;
}

async function loadHoldings() {
  const el = document.getElementById("holdings-list");
  el.textContent = "読み込み中...";
  try {
    const [holdings, latestBuyDateByCode] = await Promise.all([fetchJson("/api/holdings"), getLatestBuyDateByCode()]);
    currentHoldings = holdings;
    const sorted = sortHoldingsByAcquisitionDesc(holdings, latestBuyDateByCode);
    el.innerHTML = sorted.length
      ? sorted.map((h) => renderHoldingCard(h, h.lastBuyDate ?? latestBuyDateByCode.get(h.code))).join("")
      : `<div class="no-data">現在保有中の銘柄はありません。</div>`;
  } catch {
    currentHoldings = [];
    el.innerHTML = `<div class="no-data">保有銘柄を取得できませんでした。</div>`;
  }
}

// ---- 売却(SELL登録)モーダル ----

let sellTarget = null;

function openSellModal(code) {
  const h = currentHoldings.find((x) => x.code === code);
  if (!h) return;
  sellTarget = h;

  const pnlPct = h.unrealizedPnlPct !== null ? Math.round(h.unrealizedPnlPct * 10) / 10 : null;
  document.getElementById("sell-modal-info").innerHTML = `
    <div class="info-title">
      <span class="stock-code">${h.code}</span>
      <strong>${esc(h.name ?? "銘柄名未取得")}</strong>
    </div>
    <div class="info-grid">
      <div class="metric"><span class="metric-label">保有数量</span><span class="metric-value num">${h.quantity.toLocaleString()}株</span></div>
      <div class="metric"><span class="metric-label">平均取得価格</span><span class="metric-value num">${formatYen(h.avgCost)}</span></div>
      <div class="metric"><span class="metric-label">現在価格（データ基準日時点）</span><span class="metric-value num">${yenOrDash(h.currentPrice)}</span></div>
      <div class="metric"><span class="metric-label">現在の含み損益</span><span class="metric-value num ${percentClass(h.unrealizedPnl)}">${signedYenOrDash(h.unrealizedPnl)}${pnlPct !== null ? `（${formatPercent(pnlPct)}）` : ""}</span></div>
    </div>
    <p class="meta-line">売却価格には、実際にSBI証券等で約定した価格を入力してください。</p>
  `;

  const qty = document.getElementById("sell-quantity");
  qty.max = String(h.quantity);
  qty.value = String(h.quantity);
  const price = document.getElementById("sell-price");
  price.value = h.currentPrice !== null && h.currentPrice !== undefined ? String(h.currentPrice) : "";
  const date = document.getElementById("sell-date");
  date.max = todayLocalStr();
  date.value = todayLocalStr();
  document.getElementById("sell-memo").value = "";
  setMessage(document.getElementById("sell-form-message"), "");
  document.getElementById("sell-submit").disabled = false;
  updateSellPreview();
  showModal("sell-modal");
}

function updateSellPreview() {
  const el = document.getElementById("sell-preview");
  if (!sellTarget) {
    el.textContent = "";
    return;
  }
  const quantity = Number(document.getElementById("sell-quantity").value);
  const price = Number(document.getElementById("sell-price").value);
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) {
    el.textContent = "数量と売却価格を入力すると、見込みの確定損益を表示します。";
    return;
  }
  const pnl = (price - sellTarget.avgCost) * quantity;
  const pct = sellTarget.avgCost > 0 ? (pnl / (sellTarget.avgCost * quantity)) * 100 : null;
  const remaining = sellTarget.quantity - quantity;
  el.innerHTML =
    `見込みの確定損益: <strong class="num ${percentClass(pnl)}">${formatSignedYen(pnl)}</strong>（${fmtPct(pct)}） ／ ` +
    `売却後の保有数量: <strong class="num">${remaining.toLocaleString()}株</strong>` +
    (remaining === 0 ? "（全数量の売却）" : remaining < 0 ? "（保有数量を超えています）" : "（一部売却）");
}

async function submitSellForm(e) {
  e.preventDefault();
  if (!sellTarget) return;
  const messageEl = document.getElementById("sell-form-message");
  const submitButton = document.getElementById("sell-submit");
  setMessage(messageEl, "");

  const quantity = Number(document.getElementById("sell-quantity").value);
  const price = Number(document.getElementById("sell-price").value);
  const transactionDate = document.getElementById("sell-date").value;
  const memo = document.getElementById("sell-memo").value.trim();

  if (!Number.isInteger(quantity) || quantity <= 0) {
    setMessage(messageEl, "売却数量は1以上の整数で入力してください。", "error");
    return;
  }
  if (quantity > sellTarget.quantity) {
    setMessage(messageEl, `売却数量は保有数量(${sellTarget.quantity.toLocaleString()}株)以下にしてください。`, "error");
    return;
  }
  if (!Number.isFinite(price) || price <= 0) {
    setMessage(messageEl, "売却価格を入力してください。", "error");
    return;
  }

  submitButton.disabled = true;
  try {
    // 売買の登録・損益の計算はWorker側(POST /api/trades)に任せ、フロントでは二重実装しない
    const result = await postJson("/api/trades", {
      code: sellTarget.code,
      transactionType: "sell",
      quantity,
      price,
      transactionDate,
      memo: memo || null,
    });
    if (!result.ok) {
      setMessage(messageEl, result.body?.error ?? "売却の登録に失敗しました。", "error");
      return;
    }
    const soldName = `${sellTarget.code} ${sellTarget.name ?? ""}`.trim();
    hideModal("sell-modal");
    sellTarget = null;
    cachedLatestBuyDateByCode = null;
    setMessage(document.getElementById("holdings-message"), `${soldName} の売却を登録しました。`, "success");
    await loadHoldings();
  } catch {
    setMessage(messageEl, "通信エラーが発生しました。", "error");
  } finally {
    submitButton.disabled = false;
  }
}

// ---- 売買履歴画面 ----

let currentTrades = [];
let cancelTarget = null;

/** 累計確定損益の推移チャート(SELLが確定した順。実際の売買履歴だけから描く)。 */
function renderCumulativeChart(series) {
  if (!series || series.length === 0) return "";

  const width = 640;
  const height = 240;
  const padding = { top: 14, right: 16, bottom: 26, left: 66 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const values = series.map((s) => s.cumulativePnl);
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const range = max - min;
  const yOf = (v) => padding.top + plotHeight - ((v - min) / range) * plotHeight;
  const xOf = (i) => (series.length === 1 ? padding.left + plotWidth / 2 : padding.left + (i / (series.length - 1)) * plotWidth);

  const pts = series.map((s, i) => ({ x: xOf(i), y: yOf(s.cumulativePnl), s }));
  const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const zeroY = yOf(0);
  const areaPath = `${linePath} L ${pts[pts.length - 1].x.toFixed(1)} ${zeroY.toFixed(1)} L ${pts[0].x.toFixed(1)} ${zeroY.toFixed(1)} Z`;

  const ticks = [...new Set([max, 0, min])]
    .map((v) => {
      const y = yOf(v);
      return `
        <line x1="${padding.left}" y1="${y.toFixed(1)}" x2="${width - padding.right}" y2="${y.toFixed(1)}" class="${v === 0 ? "chart-zero-line" : "chart-gridline"}" />
        <text x="${padding.left - 8}" y="${y.toFixed(1)}" class="chart-axis-label" text-anchor="end" dominant-baseline="middle">${formatSignedYen(v)}</text>
      `;
    })
    .join("");

  const labelIdx = [...new Set([0, Math.floor((pts.length - 1) / 2), pts.length - 1])];
  const xLabels = labelIdx
    .map((i) => `<text x="${pts[i].x.toFixed(1)}" y="${height - 7}" class="chart-axis-label" text-anchor="middle">${formatDateShort(pts[i].s.date)}</text>`)
    .join("");

  const dots = pts
    .map((p) => {
      const cls = p.s.pnl > 0 ? "win" : p.s.pnl < 0 ? "lose" : "";
      return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" class="chart-point ${cls}"><title>${esc(p.s.date)} ${esc(p.s.code)} ${esc(p.s.name ?? "")}／この取引 ${formatSignedYen(p.s.pnl)}／累計 ${formatSignedYen(p.s.cumulativePnl)}</title></circle>`;
    })
    .join("");

  return `
    <div class="chart-wrap">
      <svg viewBox="0 0 ${width} ${height}" class="cum-chart" role="img" aria-label="累計確定損益の推移">
        <defs>
          <linearGradient id="cum-gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#e8b84b" stop-opacity="0.35" />
            <stop offset="100%" stop-color="#e8b84b" stop-opacity="0.02" />
          </linearGradient>
        </defs>
        ${ticks}
        <path d="${areaPath}" class="chart-area" />
        <path d="${linePath}" class="chart-line" fill="none" />
        ${dots}
        ${xLabels}
      </svg>
      <div class="chart-range-note">累計確定損益の推移（売却が確定した${series.length}件。緑=利益、赤=損失の取引）</div>
    </div>
  `;
}

function perfCell(label, valueHtml, sub, highlight = false) {
  return `
    <div class="perf-cell${highlight ? " highlight" : ""}">
      <div class="perf-label">${label}</div>
      <div class="perf-value">${valueHtml}</div>
      ${sub ? `<div class="perf-sub">${sub}</div>` : ""}
    </div>`;
}

function renderPerformance(data) {
  const summaryEl = document.getElementById("performance-summary");
  const chartEl = document.getElementById("performance-chart");
  const s = data?.summary;

  if (!s || s.sellCount === 0) {
    summaryEl.innerHTML = `<div class="no-data">確定した売却取引がまだありません。売却（SELL）を記録すると、通算成績がここに表示されます。</div>`;
    chartEl.innerHTML = "";
    return;
  }

  const pnlSpan = (v) => `<span class="num ${percentClass(v)}">${signedYenOrDash(v)}</span>`;
  summaryEl.innerHTML = `
    <div class="perf-grid">
      ${perfCell("累計確定損益", pnlSpan(s.totalRealizedPnl), `確定した売却 ${s.sellCount}件`, true)}
      ${perfCell("累計リターン", `<span class="num ${percentClass(s.totalReturnPct)}">${fmtPct(s.totalReturnPct, 2)}</span>`, "確定損益 ÷ 売却分の取得原価")}
      ${perfCell("勝率", `<span class="num">${fmtPct(s.winRate, 1, false)}</span>`, `勝ち ${s.winCount} ／ 負け ${s.loseCount}${s.evenCount ? ` ／ 引分 ${s.evenCount}` : ""}`)}
      ${perfCell("総取引数", `<span class="num">${s.totalTrades}</span>`, `買い ${s.buyCount} ／ 売り ${s.sellCount}`)}
      ${perfCell("平均利益", pnlSpan(s.avgProfit), "勝ちトレードの平均")}
      ${perfCell("平均損失", pnlSpan(s.avgLoss), "負けトレードの平均")}
      ${perfCell("最大利益", pnlSpan(s.maxProfit), "1回の売却での最大")}
      ${perfCell("最大損失", pnlSpan(s.maxLoss), "1回の売却での最大")}
    </div>
  `;
  chartEl.innerHTML = renderCumulativeChart(data.series);
}

async function loadPerformance() {
  const summaryEl = document.getElementById("performance-summary");
  summaryEl.textContent = "読み込み中...";
  document.getElementById("performance-chart").innerHTML = "";
  try {
    renderPerformance(await fetchJson("/api/trades/summary"));
  } catch {
    summaryEl.innerHTML = `<div class="no-data">通算成績を取得できませんでした。</div>`;
  }
}

function renderTradeCard(t) {
  const isBuy = t.transactionType === "buy";
  const typeLabel = isBuy ? "買い" : "売り";
  const typeClass = isBuy ? "buy" : "sell";

  let pnlBlock;
  if (t.canceled) {
    pnlBlock = `<div class="trade-card-pnl-value num">—</div><div class="trade-card-pnl-label">取消済み</div>`;
  } else {
    const pnlLabel = t.pnlType === "realized" ? "確定損益" : "含み損益(参考)";
    const pct = t.pnlPct !== null && t.pnlPct !== undefined ? `（${fmtPct(t.pnlPct)}）` : "";
    const outcome =
      t.outcome === "win"
        ? `<span class="badge badge-win">勝ち</span>`
        : t.outcome === "lose"
          ? `<span class="badge badge-lose">負け</span>`
          : t.outcome === "even"
            ? `<span class="badge badge-even">引分</span>`
            : "";
    pnlBlock = `
      <div class="trade-card-pnl-value num ${percentClass(t.pnl)}">${signedYenOrDash(t.pnl)}</div>
      <div class="trade-card-pnl-label">${pnlLabel}${pct}</div>
      ${outcome}`;
  }

  const priceInfo = isBuy
    ? `<span>購入価格 <span class="num">${formatYen(t.price)}</span></span>`
    : `<span>売却価格 <span class="num">${formatYen(t.price)}</span></span>` +
      `<span>売却時の平均取得価格 <span class="num">${yenOrDash(t.avgCostAtSale)}</span></span>`;

  return `
    <div class="trade-card${t.canceled ? " canceled" : ""}">
      <span class="trade-type-flag ${typeClass}">${typeLabel}</span>
      <div class="trade-card-main">
        <div class="trade-card-title">
          <a href="#/stock/${encodeURIComponent(t.code)}"><span class="stock-name">${t.code} ${esc(t.name ?? "")}</span></a>
          ${t.canceled ? `<span class="badge badge-soft">取消済み</span>` : ""}
        </div>
        <div class="trade-card-sub">
          <span>${esc(t.transactionDate)}</span>
          <span class="num">${t.quantity.toLocaleString()}株</span>
          ${priceInfo}
          ${t.memo ? `<span>${esc(t.memo)}</span>` : ""}
        </div>
      </div>
      <div class="trade-card-pnl">${pnlBlock}</div>
      ${
        t.canceled
          ? ""
          : `<div class="trade-card-actions">
               <button type="button" class="small-button cancel-action" data-action="cancel-trade" data-id="${t.id}">${isBuy ? "BUY登録を取り消す" : "SELL登録を取り消す"}</button>
             </div>`
      }
    </div>
  `;
}

async function loadTrades() {
  const el = document.getElementById("trades-list");
  el.textContent = "読み込み中...";
  const includeCanceled = document.getElementById("trades-show-canceled").checked;
  try {
    const trades = await fetchJson(`/api/trades${includeCanceled ? "?includeCanceled=1" : ""}`);
    currentTrades = trades;
    el.innerHTML = trades.length ? trades.map(renderTradeCard).join("") : `<div class="no-data">売買履歴はまだありません。</div>`;
  } catch {
    currentTrades = [];
    el.innerHTML = `<div class="no-data">売買履歴を取得できませんでした。</div>`;
  }
}

function reloadTradesAndPerformance() {
  loadPerformance();
  return loadTrades();
}

// ---- 取引の取消 ----

function openCancelModal(tradeId) {
  const t = currentTrades.find((x) => x.id === tradeId);
  if (!t) return;
  cancelTarget = t;
  const isBuy = t.transactionType === "buy";
  const label = isBuy ? "BUY" : "SELL";

  document.getElementById("cancel-modal-title").textContent = `${label}登録を取り消しますか？`;
  document.getElementById("cancel-confirm").textContent = `${label}登録を取り消す`;
  document.getElementById("cancel-confirm").disabled = false;
  setMessage(document.getElementById("cancel-modal-message"), "");

  const warning = isBuy
    ? `<p class="modal-warning neutral">取り消すと、この買い登録は最初から無かった状態になります（保有数量・平均取得価格・損益・通算成績は再計算され、履歴には「取消済み」として残ります）。この銘柄に後から登録した売却（SELL）がある場合は、先にそのSELLを取り消してください。</p>`
    : `<p class="modal-warning">取り消すと、この売却は最初から無かった状態になり、保有数量が <strong class="num">${t.quantity.toLocaleString()}株</strong> 戻ります。平均取得価格・損益・通算成績も再計算されます（履歴には「取消済み」として残ります）。</p>`;

  document.getElementById("cancel-modal-body").innerHTML = `
    <div class="info-title">
      <span class="trade-type-flag ${isBuy ? "buy" : "sell"}">${isBuy ? "買い" : "売り"}</span>
      <span class="stock-code">${t.code}</span>
      <strong>${esc(t.name ?? "")}</strong>
    </div>
    <div class="info-grid">
      <div class="metric"><span class="metric-label">約定日</span><span class="metric-value num">${esc(t.transactionDate)}</span></div>
      <div class="metric"><span class="metric-label">数量</span><span class="metric-value num">${t.quantity.toLocaleString()}株</span></div>
      <div class="metric"><span class="metric-label">${isBuy ? "購入価格" : "売却価格"}</span><span class="metric-value num">${formatYen(t.price)}</span></div>
      <div class="metric"><span class="metric-label">金額</span><span class="metric-value num">${formatYen(t.amount)}</span></div>
    </div>
    ${warning}
  `;
  showModal("cancel-modal");
}

async function submitCancel() {
  if (!cancelTarget) return;
  const messageEl = document.getElementById("cancel-modal-message");
  const button = document.getElementById("cancel-confirm");
  setMessage(messageEl, "");
  button.disabled = true;
  try {
    const result = await postJson(`/api/trades/${cancelTarget.id}/cancel`);
    if (!result.ok) {
      // 例: 後続のSELLがあるBUYの取消は「先に該当するSELLを取り消してください」が返る
      setMessage(messageEl, result.body?.error ?? "取消に失敗しました。", "error");
      button.disabled = false;
      return;
    }
    const label = cancelTarget.transactionType === "buy" ? "BUY" : "SELL";
    const summary = `${cancelTarget.code} ${cancelTarget.name ?? ""}`.trim();
    hideModal("cancel-modal");
    cancelTarget = null;
    cachedLatestBuyDateByCode = null;
    setMessage(document.getElementById("trades-message"), `${summary} の${label}登録を取り消しました。`, "success");
    await reloadTradesAndPerformance();
  } catch {
    setMessage(messageEl, "通信エラーが発生しました。", "error");
    button.disabled = false;
  }
}

/**
 * 購入日・売却日の入力欄を初期化する。
 * - 初期値を「本日」にする
 * - max属性を「本日」にし、未来日を選択できないようにする
 * 日付は端末のローカル日付を使う(UTC日付だと日本時間の朝に前日になってしまうため)。
 * input type="date" の .value は常に YYYY-MM-DD 形式であり、既存のAPI(transactionDate)にそのまま渡せる。
 */
function initTradeDateField() {
  const todayStr = todayLocalStr();
  const dateInput = document.getElementById("trade-date");
  dateInput.max = todayStr;
  dateInput.value = todayStr;

  // アイコン部分以外をクリックした場合でもカレンダーが開くようにする(対応ブラウザのみ)。
  if (!dateInput.dataset.pickerBound) {
    dateInput.addEventListener("click", () => {
      if (typeof dateInput.showPicker === "function") {
        try {
          dateInput.showPicker();
        } catch {
          // 既に開いている場合など、失敗しても無視する
        }
      }
    });
    dateInput.dataset.pickerBound = "true";
  }
}

async function submitTradeForm(e) {
  e.preventDefault();
  const messageEl = document.getElementById("trade-form-message");
  const submitButton = document.getElementById("trade-submit");
  messageEl.textContent = "";
  messageEl.className = "form-message";

  const code = document.getElementById("trade-code").value.trim();
  const transactionType = document.getElementById("trade-type").value;
  const quantity = Number(document.getElementById("trade-quantity").value);
  const price = Number(document.getElementById("trade-price").value);
  const transactionDate = document.getElementById("trade-date").value;
  const memo = document.getElementById("trade-memo").value.trim();

  submitButton.disabled = true;
  try {
    const res = await fetch(API_BASE + "/api/trades", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, transactionType, quantity, price, transactionDate, memo: memo || null }),
    });
    const body = await res.json();
    if (!res.ok) {
      messageEl.textContent = body.error ?? "登録に失敗しました。";
      messageEl.classList.add("form-message-error");
      return;
    }
    messageEl.textContent = "登録しました。";
    messageEl.classList.add("form-message-success");
    document.getElementById("trade-form").reset();
    initTradeDateField(); // reset()でmax以外は消えるため、本日の日付を再設定する
    cachedLatestBuyDateByCode = null; // 保有日時キャッシュを無効化
    reloadTradesAndPerformance();
  } catch {
    messageEl.textContent = "通信エラーが発生しました。";
    messageEl.classList.add("form-message-error");
  } finally {
    submitButton.disabled = false;
  }
}

// ---- 画面切り替え（ハッシュルーティング） ----

function showView(name) {
  document.getElementById("view-home").hidden = name !== "home";
  document.getElementById("view-ranking").hidden = name !== "ranking";
  document.getElementById("view-detail").hidden = name !== "detail";
  document.getElementById("view-holdings").hidden = name !== "holdings";
  document.getElementById("view-trades").hidden = name !== "trades";
  window.scrollTo(0, 0);
}

function handleRoute() {
  const hash = window.location.hash;
  const stockMatch = hash.match(/^#\/stock\/([^/]+)$/);
  if (stockMatch) {
    const code = decodeURIComponent(stockMatch[1]);
    showView("detail");
    setActiveNav(null);
    loadDetail(code);
  } else if (hash === "#/ranking") {
    showView("ranking");
    setActiveNav("ranking");
    loadRanking();
  } else if (hash === "#/holdings") {
    showView("holdings");
    setActiveNav("holdings");
    setMessage(document.getElementById("holdings-message"), "");
    loadHoldings();
  } else if (hash === "#/trades") {
    showView("trades");
    setActiveNav("trades");
    initTradeDateField();
    setMessage(document.getElementById("trades-message"), "");
    reloadTradesAndPerformance();
  } else {
    showView("home");
    setActiveNav("home");
    loadHome();
  }
}

window.addEventListener("hashchange", handleRoute);
document.getElementById("back-to-ranking").addEventListener("click", () => {
  window.history.back();
});
document.getElementById("ranking-reload").addEventListener("click", loadRanking);
document.getElementById("holdings-reload").addEventListener("click", () => {
  cachedLatestBuyDateByCode = null;
  loadHoldings();
});
document.getElementById("trades-reload").addEventListener("click", reloadTradesAndPerformance);
document.getElementById("performance-reload").addEventListener("click", loadPerformance);
document.getElementById("trades-show-canceled").addEventListener("change", loadTrades);
document.getElementById("trade-form").addEventListener("submit", submitTradeForm);

// 保有銘柄 → 売却モーダル
document.getElementById("holdings-list").addEventListener("click", (e) => {
  const btn = e.target.closest('[data-action="sell"]');
  if (btn) openSellModal(btn.dataset.code);
});
document.getElementById("sell-form").addEventListener("submit", submitSellForm);
document.getElementById("sell-quantity").addEventListener("input", updateSellPreview);
document.getElementById("sell-price").addEventListener("input", updateSellPreview);
document.getElementById("sell-quantity-all").addEventListener("click", () => {
  if (!sellTarget) return;
  document.getElementById("sell-quantity").value = String(sellTarget.quantity);
  updateSellPreview();
});

// 売買履歴 → 取消モーダル
document.getElementById("trades-list").addEventListener("click", (e) => {
  const btn = e.target.closest('[data-action="cancel-trade"]');
  if (btn) openCancelModal(Number(btn.dataset.id));
});
document.getElementById("cancel-confirm").addEventListener("click", submitCancel);

async function loadMetaHeader() {
  try {
    renderMeta(await fetchJson("/api/meta"));
  } catch {
    renderMeta(null);
  }
}

handleRoute();
loadMetaHeader();
