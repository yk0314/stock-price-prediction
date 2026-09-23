// Cloudflare Workers API のベースURL。
const API_BASE = "https://jp-stock-ai-app-api.yk0314.workers.dev";

async function fetchJson(path) {
  const res = await fetch(API_BASE + path);
  if (!res.ok) {
    throw new Error(`API error: ${res.status}`);
  }
  return res.json();
}

// ---- フォーマット用ヘルパー ----

function formatPercent(value) {
  if (value === null || value === undefined) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value}%`;
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
              <span class="stock-name">${holding.name ?? "銘柄名未取得"}</span>
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
      fetchJson("/api/ranking"),
      fetchJson("/api/holdings"),
      fetchJson("/api/meta"),
    ]);

    renderAlertZone(holdings);
    renderStatsStrip(holdings, meta);

    const heldCodes = new Set(holdings.map((h) => h.code));
    const displayRanking = sortRankingForDisplay(excludeHeldCodes(ranking, heldCodes)).slice(0, 4);
    rankingPreviewEl.innerHTML = displayRanking.length
      ? displayRanking.map((item, i) => renderRankingCard(item, i + 1)).join("")
      : `<div class="no-data">現在、購入候補となる評価結果がありません。</div>`;

    const sortedHoldings = sortHoldingsByAcquisitionDesc(holdings, await getLatestBuyDateByCode());
    holdingsPreviewEl.innerHTML = sortedHoldings.length
      ? sortedHoldings.slice(0, 3).map(renderHoldingCard).join("")
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
          <span class="stock-name">${item.name ?? "銘柄名未取得"}</span>
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
      ${item.summary ? `<p class="rank-card-summary">${item.summary}</p>` : ""}
      <div class="meta-line">評価日: ${item.evaluationDate ?? "-"} ／ データ基準日: ${item.dataAsOfDate ?? "-"}</div>
    </a>
  `;
}

async function loadRanking() {
  const el = document.getElementById("ranking-list");
  el.textContent = "読み込み中...";
  try {
    const [ranking, holdings] = await Promise.all([fetchJson("/api/ranking"), fetchJson("/api/holdings")]);
    const heldCodes = new Set(holdings.map((h) => h.code));
    const display = sortRankingForDisplay(excludeHeldCodes(ranking, heldCodes));
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
      ${evaluation.summary ? `<p class="eval-summary">${evaluation.summary}</p>` : ""}
      ${evaluation.reasoning ? `<details class="eval-reasoning"><summary>判断理由の詳細</summary><p>${evaluation.reasoning}</p></details>` : ""}
      <div class="meta-line">評価日: ${evaluation.evaluationDate ?? "-"} ／ データ基準日: ${evaluation.dataAsOfDate ?? "-"}</div>
    </div>
  `;
}

async function loadDetail(code) {
  const el = document.getElementById("detail-content");
  el.innerHTML = "読み込み中...";
  try {
    const [stock, prices] = await Promise.all([
      fetchJson(`/api/stocks/${encodeURIComponent(code)}`),
      fetchJson(`/api/stocks/${encodeURIComponent(code)}/prices`),
    ]);

    el.innerHTML = `
      <div class="detail-header">
        <span class="stock-code">${stock.code}</span>
        <h2 class="stock-name">${stock.name ?? "銘柄名未取得"}</h2>
        ${stock.market ? `<span class="market-tag">${stock.market}</span>` : ""}
      </div>
      <div class="current-price-line">
        現在価格: <strong class="num">${formatYen(stock.price)}</strong>
        <span class="meta-line">（データ基準日: ${stock.dataAsOf ?? "-"}）</span>
      </div>

      <h3 class="detail-subhead">株価チャート</h3>
      ${renderPriceChart(prices)}

      <h3 class="detail-subhead">AI評価</h3>
      ${renderEvaluationBlock(stock.latestEvaluation)}
    `;
  } catch (err) {
    el.innerHTML = `<div class="no-data">この銘柄コードのデータを取得できませんでした（コードが正しいかご確認ください）。</div>`;
  }
}

// ---- 保有銘柄画面 ----

let cachedLatestBuyDateByCode = null;

/**
 * 各銘柄コードについて、最も新しいBUY取引の約定日を取得する。
 * /api/holdingsには取得日時が含まれていないため、/api/tradesから導出する
 * （APIのデータ構造は変更せず、Frontend側で2つのAPIを組み合わせるだけに留める）。
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
    const dateA = latestBuyDateByCode.get(a.code) ?? "";
    const dateB = latestBuyDateByCode.get(b.code) ?? "";
    if (dateA === dateB) return 0;
    return dateA < dateB ? 1 : -1; // 新しい日付が先
  });
}

function renderHoldingCard(h) {
  const judgement = judgeHoldingAttention(h);
  return `
    <a class="holding-card" href="#/stock/${encodeURIComponent(h.code)}">
      <div class="holding-card-top">
        <div class="rank-card-title">
          <span class="stock-code">${h.code}</span>
          <span class="stock-name">${h.name ?? "銘柄名未取得"}</span>
        </div>
        <div class="holding-pnl">
          <div class="holding-pnl-value num ${percentClass(h.unrealizedPnl)}">${formatSignedYen(h.unrealizedPnl)}</div>
          <div class="holding-pnl-pct num ${percentClass(h.unrealizedPnl)}">${formatPercent(
    h.unrealizedPnlPct !== null ? Math.round(h.unrealizedPnlPct * 10) / 10 : null
  )}</div>
        </div>
      </div>
      <div class="holding-card-badges">
        ${h.latestEvaluation ? ratingBadge(h.latestEvaluation.rating) : ""}
        ${h.latestEvaluation ? riskBadge(h.latestEvaluation.risk) : ""}
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
  `;
}

async function loadHoldings() {
  const el = document.getElementById("holdings-list");
  el.textContent = "読み込み中...";
  try {
    const [holdings, latestBuyDateByCode] = await Promise.all([fetchJson("/api/holdings"), getLatestBuyDateByCode()]);
    const sorted = sortHoldingsByAcquisitionDesc(holdings, latestBuyDateByCode);
    el.innerHTML = sorted.length ? sorted.map(renderHoldingCard).join("") : `<div class="no-data">現在保有中の銘柄はありません。</div>`;
  } catch {
    el.innerHTML = `<div class="no-data">保有銘柄を取得できませんでした。</div>`;
  }
}

// ---- 売買履歴画面 ----

function renderTradeCard(t) {
  const typeLabel = t.transactionType === "buy" ? "買い" : "売り";
  const typeClass = t.transactionType === "buy" ? "buy" : "sell";
  const pnlLabel = t.pnlType === "realized" ? "実現損益" : "含み損益(参考)";
  return `
    <a class="trade-card" href="#/stock/${encodeURIComponent(t.code)}">
      <span class="trade-type-flag ${typeClass}">${typeLabel}</span>
      <div class="trade-card-main">
        <div class="trade-card-title">
          <span class="stock-name">${t.code} ${t.name ?? ""}</span>
        </div>
        <div class="trade-card-sub">
          <span>${t.transactionDate}</span>
          <span class="num">${t.quantity.toLocaleString()}株</span>
          <span class="num">${formatYen(t.price)}</span>
          ${t.memo ? `<span>${t.memo}</span>` : ""}
        </div>
      </div>
      <div class="trade-card-pnl">
        <div class="trade-card-pnl-value num ${percentClass(t.pnl)}">${formatSignedYen(t.pnl)}</div>
        <div class="trade-card-pnl-label">${pnlLabel}</div>
      </div>
    </a>
  `;
}

async function loadTrades() {
  const el = document.getElementById("trades-list");
  el.textContent = "読み込み中...";
  try {
    const trades = await fetchJson("/api/trades");
    el.innerHTML = trades.length ? trades.map(renderTradeCard).join("") : `<div class="no-data">売買履歴はまだありません。</div>`;
  } catch {
    el.innerHTML = `<div class="no-data">売買履歴を取得できませんでした。</div>`;
  }
}

/**
 * 購入日・売却日の入力欄を初期化する。
 * - 初期値を「本日」にする
 * - max属性を「本日」にし、未来日を選択できないようにする
 * input type="date" の .value は常に YYYY-MM-DD 形式であり、
 * これは既存のAPI(transactionDate)にそのまま渡している形式と同じなので、
 * ここでの変更によってバックエンドへ渡すデータ形式は変わらない。
 */
function initTradeDateField() {
  const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dateInput = document.getElementById("trade-date");
  dateInput.max = todayStr;
  dateInput.value = todayStr;
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
    loadTrades();
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
    loadHoldings();
  } else if (hash === "#/trades") {
    showView("trades");
    setActiveNav("trades");
    initTradeDateField();
    loadTrades();
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
document.getElementById("trades-reload").addEventListener("click", loadTrades);
document.getElementById("trade-form").addEventListener("submit", submitTradeForm);

async function loadMetaHeader() {
  try {
    renderMeta(await fetchJson("/api/meta"));
  } catch {
    renderMeta(null);
  }
}

handleRoute();
loadMetaHeader();
