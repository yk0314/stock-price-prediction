// Cloudflare Workers API のベースURL。
// デプロイ後、実際のWorkers URL（例: https://jp-stock-ai-app-api.your-subdomain.workers.dev）に置き換えること。
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

// rating("BUY"/"HOLD"/"SELL")・risk("LOW"/"MEDIUM"/"HIGH")を日本語ラベル+バッジ用クラスに変換
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
  return `<span class="badge badge-risk badge-risk-${cls}">リスク${label}</span>`;
}

// ---- ランキング画面 ----

function renderMeta(meta) {
  const el = document.getElementById("meta-info");
  if (!meta || !meta.cutoffDate) {
    el.textContent = "データ基準日: 未取得";
    return;
  }
  el.textContent =
    `データ基準日: ${meta.cutoffDate} ／ ` +
    `最終更新: ${meta.predictionExecutedAt ? meta.predictionExecutedAt.slice(0, 16).replace("T", " ") : "-"} ／ ` +
    `対象ユニバース: ${meta.universeCodeCount ?? "-"}銘柄`;
}

function renderRankingCard(item, rank) {
  const priceLabel =
    item.priceAtEvaluation !== null && item.priceAtEvaluation !== undefined
      ? `¥${Number(item.priceAtEvaluation).toLocaleString()}`
      : "-";
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
          <span class="metric-value">${priceLabel}</span>
        </div>
        <div class="metric">
          <span class="metric-label">期待リターン</span>
          <span class="metric-value ${percentClass(item.expectedReturn)}">${formatPercent(item.expectedReturn)}</span>
        </div>
        <div class="metric">
          <span class="metric-label">想定保有日数</span>
          <span class="metric-value">${item.expectedHoldingDays ?? "-"}日</span>
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
    const ranking = await fetchJson("/api/ranking");
    el.innerHTML = ranking.length
      ? ranking.map((item, i) => renderRankingCard(item, i + 1)).join("")
      : "現在、AI評価結果がありません。";
  } catch (err) {
    el.textContent = "現在データを取得できませんでした。しばらくしてから再度お試しください。";
  }
}

async function loadMeta() {
  try {
    const meta = await fetchJson("/api/meta");
    renderMeta(meta);
  } catch {
    renderMeta(null);
  }
}

// ---- 銘柄詳細画面 ----

function formatDateShort(dateStr) {
  // "2026-09-19" -> "9/19"
  if (!dateStr) return "";
  const parts = dateStr.split("-");
  return parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : dateStr;
}

/**
 * 株価履歴(close配列)から、外部ライブラリ無しのシンプルなSVG折れ線チャートを描く。
 * プロジェクト全体の「外部npmパッケージ不使用」方針に合わせ、Canvasやチャートライブラリは使わない。
 */
function renderPriceChart(prices) {
  if (!prices || prices.length === 0) {
    return `<p class="no-data">株価データがありません（この銘柄はスクリーニングプール対象外の可能性があります）。</p>`;
  }

  const width = 640;
  const height = 220;
  const padding = { top: 12, right: 12, bottom: 24, left: 52 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const closes = prices.map((p) => p.close).filter((c) => c !== null && c !== undefined);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1; // 全て同値の場合のゼロ割回避

  const points = prices.map((p, i) => {
    const x = padding.left + (i / Math.max(prices.length - 1, 1)) * plotWidth;
    const y = padding.top + plotHeight - ((p.close - min) / range) * plotHeight;
    return { x, y, ...p };
  });

  const pathD = points
    .map((pt, i) => `${i === 0 ? "M" : "L"} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`)
    .join(" ");

  const last = points[points.length - 1];
  const first = points[0];
  const trendClass = last.close >= first.close ? "positive" : "negative";

  // Y軸目盛り(最大・中央・最小の3本)
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

  // X軸ラベル(先頭・中央・末尾の日付のみ、混雑を避ける)
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
      <div class="chart-range-note">
        表示期間: ${prices[0].date} 〜 ${prices[prices.length - 1].date}（${prices.length}営業日分）
      </div>
    </div>
  `;
}

function renderEvaluationBlock(evaluation) {
  if (!evaluation) {
    return `<p class="no-data">この銘柄はAI分析の対象外でした（スクリーニングで選定された候補のみ分析されます）。</p>`;
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
          <span class="metric-value ${percentClass(evaluation.expectedReturn)}">${formatPercent(evaluation.expectedReturn)}</span>
        </div>
        <div class="metric">
          <span class="metric-label">想定保有日数</span>
          <span class="metric-value">${evaluation.expectedHoldingDays ?? "-"}日</span>
        </div>
        <div class="metric">
          <span class="metric-label">上昇確率</span>
          <span class="metric-value">${evaluation.upsideProbability ?? "-"}%</span>
        </div>
        <div class="metric">
          <span class="metric-label">下落リスク</span>
          <span class="metric-value">${evaluation.downsideRisk ?? "-"}%</span>
        </div>
        <div class="metric">
          <span class="metric-label">信頼度</span>
          <span class="metric-value">${evaluation.confidence ?? "-"}%</span>
        </div>
        <div class="metric">
          <span class="metric-label">評価時株価</span>
          <span class="metric-value">${
            evaluation.priceAtEvaluation ? `¥${Number(evaluation.priceAtEvaluation).toLocaleString()}` : "-"
          }</span>
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
        現在価格: <strong>${stock.price ? `¥${Number(stock.price).toLocaleString()}` : "-"}</strong>
        <span class="meta-line">（データ基準日: ${stock.dataAsOf ?? "-"}）</span>
      </div>

      <h3 class="detail-subhead">株価チャート</h3>
      ${renderPriceChart(prices)}

      <h3 class="detail-subhead">AI評価</h3>
      ${renderEvaluationBlock(stock.latestEvaluation)}
    `;
  } catch (err) {
    el.innerHTML = `<p class="no-data">この銘柄コードのデータを取得できませんでした（コードが正しいかご確認ください）。</p>`;
  }
}

// ---- 保有銘柄画面 ----

function renderHoldingCard(h) {
  const pnlClass = percentClass(h.unrealizedPnl);
  return `
    <a class="rank-card" href="#/stock/${encodeURIComponent(h.code)}">
      <div class="rank-card-top">
        <div class="rank-card-title">
          <span class="stock-code">${h.code}</span>
          <span class="stock-name">${h.name ?? "銘柄名未取得"}</span>
        </div>
        ${h.latestEvaluation ? ratingBadge(h.latestEvaluation.rating) : ""}
      </div>
      <div class="rank-card-metrics">
        <div class="metric">
          <span class="metric-label">保有数量</span>
          <span class="metric-value">${h.quantity.toLocaleString()}株</span>
        </div>
        <div class="metric">
          <span class="metric-label">平均取得単価</span>
          <span class="metric-value">¥${Math.round(h.avgCost).toLocaleString()}</span>
        </div>
        <div class="metric">
          <span class="metric-label">現在価格</span>
          <span class="metric-value">${h.currentPrice ? `¥${Number(h.currentPrice).toLocaleString()}` : "-"}</span>
        </div>
      </div>
      <div class="pnl-line ${pnlClass}">
        評価損益: ${h.unrealizedPnl !== null ? `${h.unrealizedPnl > 0 ? "+" : ""}¥${Math.round(h.unrealizedPnl).toLocaleString()}` : "-"}
        （${formatPercent(h.unrealizedPnlPct !== null ? Math.round(h.unrealizedPnlPct * 10) / 10 : null)}）
      </div>
    </a>
  `;
}

async function loadHoldings() {
  const el = document.getElementById("holdings-list");
  el.textContent = "読み込み中...";
  try {
    const holdings = await fetchJson("/api/holdings");
    el.innerHTML = holdings.length
      ? `<div class="ranking-grid">${holdings.map(renderHoldingCard).join("")}</div>`
      : `<p class="no-data">現在保有中の銘柄はありません。</p>`;
  } catch {
    el.innerHTML = `<p class="no-data">保有銘柄を取得できませんでした。</p>`;
  }
}

// ---- 売買履歴画面 ----

function renderTradeRow(t) {
  const typeLabel = t.transactionType === "buy" ? "買い" : "売り";
  const typeClass = t.transactionType === "buy" ? "trade-type-buy" : "trade-type-sell";
  const pnlLabel = t.pnlType === "realized" ? "実現損益" : "含み損益（参考）";
  const pnlText =
    t.pnl !== null
      ? `${t.pnl > 0 ? "+" : ""}¥${Math.round(t.pnl).toLocaleString()}（${formatPercent(
          t.pnlPct !== null ? Math.round(t.pnlPct * 10) / 10 : null
        )}）`
      : "-";
  const winLabel = t.win === null ? "" : t.win ? `<span class="badge badge-buy">勝ち</span>` : `<span class="badge badge-sell">負け</span>`;

  return `
    <tr>
      <td>${t.transactionDate}</td>
      <td><a href="#/stock/${encodeURIComponent(t.code)}">${t.code} ${t.name ?? ""}</a></td>
      <td><span class="trade-type ${typeClass}">${typeLabel}</span></td>
      <td>${t.quantity.toLocaleString()}株</td>
      <td>¥${Number(t.price).toLocaleString()}</td>
      <td class="${percentClass(t.pnl)}">${pnlLabel}<br />${pnlText} ${winLabel}</td>
      <td class="meta-line">${t.memo ?? ""}</td>
    </tr>
  `;
}

async function loadTrades() {
  const el = document.getElementById("trades-list");
  el.textContent = "読み込み中...";
  try {
    const trades = await fetchJson("/api/trades");
    el.innerHTML = trades.length
      ? `
        <table class="trades-table">
          <thead>
            <tr><th>日付</th><th>銘柄</th><th>区分</th><th>数量</th><th>約定価格</th><th>損益</th><th>メモ</th></tr>
          </thead>
          <tbody>${trades.map(renderTradeRow).join("")}</tbody>
        </table>
      `
      : `<p class="no-data">売買履歴はまだありません。</p>`;
  } catch {
    el.innerHTML = `<p class="no-data">売買履歴を取得できませんでした。</p>`;
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
    loadTrades();
    loadHoldings();
  } catch {
    messageEl.textContent = "通信エラーが発生しました。";
    messageEl.classList.add("form-message-error");
  } finally {
    submitButton.disabled = false;
  }
}

// ---- 画面切り替え（ハッシュルーティング） ----

function showView(name) {
  document.getElementById("view-ranking").hidden = name !== "ranking";
  document.getElementById("view-detail").hidden = name !== "detail";
  document.getElementById("view-holdings").hidden = name !== "holdings";
  document.getElementById("view-trades").hidden = name !== "trades";
}

function handleRoute() {
  const hash = window.location.hash; // 例: "#/stock/7203", "#/holdings", "#/trades", "" / "#/"
  const stockMatch = hash.match(/^#\/stock\/([^/]+)$/);
  if (stockMatch) {
    const code = decodeURIComponent(stockMatch[1]);
    showView("detail");
    loadDetail(code);
  } else if (hash === "#/holdings") {
    showView("holdings");
    loadHoldings();
  } else if (hash === "#/trades") {
    showView("trades");
    loadTrades();
  } else {
    showView("ranking");
  }
}

window.addEventListener("hashchange", handleRoute);
document.getElementById("back-to-ranking").addEventListener("click", () => {
  window.location.hash = "#/";
});
document.getElementById("ranking-reload").addEventListener("click", () => {
  loadMeta();
  loadRanking();
});
document.getElementById("holdings-reload").addEventListener("click", loadHoldings);
document.getElementById("trades-reload").addEventListener("click", loadTrades);
document.getElementById("trade-form").addEventListener("submit", submitTradeForm);

handleRoute();
loadMeta();
loadRanking();
