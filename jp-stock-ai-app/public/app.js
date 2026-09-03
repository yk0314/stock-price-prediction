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

function renderMeta(meta) {
  const el = document.getElementById("meta-info");
  if (!meta || !meta.cutoffDate) {
    el.textContent = "データ基準日: 未取得";
    return;
  }
  el.textContent =
    `データ基準日 (cutoffDate): ${meta.cutoffDate} ／ ` +
    `最終実行(predictionExecutedAt): ${meta.predictionExecutedAt ?? "-"} ／ ` +
    `AI分析対象: ${
      meta.geminiCandidateCount ?? meta.analyzedCount ?? "-"
    }銘柄 ／ ` +
    `対象ユニバース: ${meta.universeCodeCount ?? "-"}銘柄 (mode=${
      meta.universeMode ?? "-"
    })`;
}

function renderRankingItem(item) {
  const stanceClass =
    item.stance === "positive"
      ? "positive"
      : item.stance === "negative"
      ? "negative"
      : "";
  return `
    <div class="stock-card">
      <div><strong>${item.code}</strong> <span class="score">${
    item.score ?? "-"
  } / 100</span></div>
      <div class="${stanceClass}">
        上昇期待度: ${item.upsideProbability ?? "-"}% ／
        下落リスク: ${item.downsideRisk ?? "-"}% ／
        信頼度: ${item.confidence ?? "-"}%
      </div>
      <div>${item.summary ?? ""}</div>
      <div class="meta-line">
        データ基準日(dataAsOf): ${item.dataAsOf ?? "-"} ／
        cutoffDate: ${item.cutoffDate ?? "-"} ／
        予測実行日時: ${item.predictionExecutedAt ?? "-"}
      </div>
      <div class="meta-line">${item.disclaimer ?? ""}</div>
    </div>
  `;
}

async function loadRanking() {
  const el = document.getElementById("ranking-list");
  try {
    const ranking = await fetchJson("/api/ranking");
    el.innerHTML = ranking.length
      ? ranking.map(renderRankingItem).join("")
      : "現在、AI評価結果がありません。";
  } catch (err) {
    el.textContent =
      "現在データを取得できませんでした。しばらくしてから再度お試しください。";
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

async function searchStock(code) {
  const el = document.getElementById("detail-view");
  el.textContent = "読み込み中...";
  try {
    const analysis = await fetchJson(
      `/api/stocks/${encodeURIComponent(code)}/analysis`
    );
    el.innerHTML = renderRankingItem(analysis);
  } catch (err) {
    el.textContent =
      "この銘柄のAI分析結果は見つかりませんでした。（スクリーニング対象外の可能性があります）";
  }
}

document.getElementById("search-button").addEventListener("click", () => {
  const code = document.getElementById("code-input").value.trim();
  if (code) searchStock(code);
});

loadMeta();
loadRanking();
