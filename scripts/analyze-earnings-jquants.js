#!/usr/bin/env node
// 決算データの検証(J-Quantsから直接取得。D1・KV・Geminiには一切触れない)。
//   取得: 取引カレンダー / 日足(1営業日1リクエスト) / 財務(fins/summary、開示日ごとに1リクエスト)
//   計算: src/earningsStudy.js
//   出力: data/earnings-study.txt(読む用) / data/earnings-study.json(全数値) / data/earnings-events.json(決算イベント)
//
// 環境変数:
//   JQUANTS_API_KEY (必須)
//   FROM / TO            取得期間(既定: 今日の5年前の2日後 〜 今日)
//   EXPLORE_END          探索期間の最終日(既定 2024-06-30。これより後が確認期間)
//   COST_PCT             往復コスト%(既定 0.3)
//   MIN_VA               買う日より前20営業日の平均売買代金(円)の下限(既定 50000000)
//   HOLDS                保有営業日(既定 1,3,5,10,20)
//   MIN_INTERVAL_MS      リクエスト間隔ms(既定 1250 = 毎分約48回)
import fs from 'node:fs';
import path from 'node:path';
import { buildEvents, formatReport, runStudy, toIsoDate, toShortCode } from '../src/earningsStudy.js';

const BASE = process.env.JQUANTS_BASE || 'https://api.jquants.com/v2';
const API_KEY = process.env.JQUANTS_API_KEY;
if (!API_KEY) {
  console.error('JQUANTS_API_KEY が未設定です');
  process.exit(1);
}
const MIN_INTERVAL_MS = Number(process.env.MIN_INTERVAL_MS || 1250);
const MAX_RETRY = 6;
const OUT_DIR = process.env.OUT_DIR || 'data';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = { requests: 0, retries: 0, failures: 0 };
let lastReq = 0;

async function jq(pathname, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}${pathname}${qs ? `?${qs}` : ''}`;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    const wait = lastReq + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastReq = Date.now();
    stats.requests++;
    let res;
    try {
      res = await fetch(url, { headers: { 'x-api-key': API_KEY } });
    } catch (e) {
      stats.retries++;
      if (attempt === MAX_RETRY) throw e;
      await sleep(Math.min(60000, 2000 * 2 ** attempt));
      continue;
    }
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      stats.retries++;
      const ra = Number(res.headers.get('retry-after'));
      await sleep(ra > 0 ? ra * 1000 : Math.min(60000, 2000 * 2 ** attempt));
      continue;
    }
    stats.failures++;
    const body = await res.text().catch(() => '');
    const err = new Error(`J-Quants ${res.status} ${pathname}?${qs}: ${body.slice(0, 300)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  stats.failures++;
  throw new Error(`リトライ上限 ${pathname}?${qs}`);
}

async function jqAll(pathname, params = {}) {
  const rows = [];
  let pk;
  do {
    const j = await jq(pathname, pk ? { ...params, pagination_key: pk } : params);
    const data = j.data ?? [];
    for (const r of data) rows.push(r);
    pk = j.pagination_key;
  } while (pk);
  return rows;
}

const today = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
function defaultFrom() {
  const d = new Date(Date.UTC(today.getUTCFullYear() - 5, today.getUTCMonth(), today.getUTCDate() + 2));
  return iso(d);
}
let FROM = process.env.FROM || defaultFrom();
const TO = process.env.TO || iso(today);
const EXPLORE_END = process.env.EXPLORE_END || '2024-06-30';
const holds = (process.env.HOLDS || '1,3,5,10,20').split(',').map(Number).filter((n) => n > 0);

async function fetchCalendar() {
  try {
    return await jqAll('/markets/calendar', { from: FROM, to: TO });
  } catch (e) {
    // 契約の範囲外(例:「2021-11-23 から」)なら、範囲の始まりに合わせて1回だけやり直す
    const m = e.status === 400 && /(\d{4}-\d{2}-\d{2})/.exec(e.body || '');
    if (m && m[1] > FROM) {
      console.log(`開始日 ${FROM} は契約範囲外のため ${m[1]} に合わせます`);
      FROM = m[1];
      return jqAll('/markets/calendar', { from: FROM, to: TO });
    }
    throw e;
  }
}

function elapsed(t0) {
  return ((Date.now() - t0) / 60000).toFixed(1);
}

async function main() {
  const t0 = Date.now();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1) 営業日
  const cal = await fetchCalendar();
  const candidate = cal
    .filter((r) => {
      const hd = String(r.HolDiv ?? '');
      return hd === '1' || hd === '2' || hd === '';
    })
    .map((r) => toIsoDate(r.Date))
    .filter((d) => d >= FROM && d <= TO)
    .sort();
  if (!candidate.length) throw new Error('営業日が取得できませんでした');
  console.log(`営業日候補 ${candidate.length}日 (${candidate[0]} 〜 ${candidate[candidate.length - 1]}) / 保有日数 ${holds.join(',')}`);

  // 2) 日足(1営業日1リクエスト)
  const Tc = candidate.length;
  const codeIdx = new Map();
  const stocks = [];
  const days = [];
  for (let c = 0; c < Tc; c++) {
    const date = candidate[c];
    const rows = await jqAll('/equities/bars/daily', { date });
    if (!rows.length) {
      console.log(`  ${date}: 日足なし(除外)`);
      continue;
    }
    const di = days.length;
    days.push(date);
    for (const r of rows) {
      const code = toShortCode(r.Code);
      let s = codeIdx.get(code);
      if (s === undefined) {
        s = stocks.length;
        codeIdx.set(code, s);
        stocks.push({ code, open: new Float64Array(Tc).fill(NaN), va: new Float64Array(Tc).fill(NaN) });
      }
      const o = Number(r.AdjO ?? r.O);
      stocks[s].open[di] = Number.isFinite(o) && o > 0 ? o : NaN;
      const va = Number(r.Va);
      stocks[s].va[di] = Number.isFinite(va) ? va : NaN;
    }
    if ((c + 1) % 50 === 0 || c + 1 === Tc) {
      const done = c + 1;
      const perMin = done / Math.max(0.01, (Date.now() - t0) / 60000);
      console.log(`  日足 ${done}/${Tc} 銘柄${stocks.length} 経過${elapsed(t0)}分 残り約${((Tc - done) / perMin).toFixed(0)}分`);
    }
  }
  const T = days.length;
  for (const st of stocks) {
    st.open = st.open.subarray(0, T);
    st.va = st.va.subarray(0, T);
  }
  console.log(`日足 完了: ${T}営業日・${stocks.length}銘柄 (リクエスト${stats.requests}回・再試行${stats.retries}回)`);

  // 3) 財務(開示日ごと)
  const finRows = [];
  const docTypes = new Map();
  for (let c = 0; c < Tc; c++) {
    const date = candidate[c];
    const rows = await jqAll('/fins/summary', { date });
    for (const r of rows) {
      docTypes.set(r.DocType, (docTypes.get(r.DocType) ?? 0) + 1);
      finRows.push({
        Code: r.Code,
        DiscDate: r.DiscDate,
        DiscTime: r.DiscTime,
        DocType: r.DocType,
        CurPerType: r.CurPerType,
        CurPerEn: r.CurPerEn,
        CurFYEn: r.CurFYEn,
        NxtFYEn: r.NxtFYEn,
        Sales: r.Sales,
        OP: r.OP,
        EPS: r.EPS,
        FOP: r.FOP,
        NxFOP: r.NxFOP,
      });
    }
    if ((c + 1) % 50 === 0 || c + 1 === Tc) {
      console.log(`  財務 ${c + 1}/${Tc} 行${finRows.length} 経過${elapsed(t0)}分`);
    }
  }
  console.log('書類種別(DocType)の件数:');
  for (const [k, v] of [...docTypes.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);

  const events = buildEvents(finRows);
  const nFS = events.filter((e) => e.cls === 'FS').length;
  const nREV = events.filter((e) => e.cls === 'REV').length;
  console.log(`決算イベント: 決算短信${nFS}件・予想修正${nREV}件`);
  if (!nFS) {
    throw new Error('決算短信が1件も見つかりません。上の DocType の一覧を見て、src/earningsStudy.js の classifyDocType を合わせてください');
  }
  const withSignal = (k) => events.filter((e) => e.signals[k] !== null).length;
  console.log(
    `シグナルが取れた件数: opYoY=${withSignal('opYoY')} epsYoY=${withSignal('epsYoY')} salesYoY=${withSignal('salesYoY')} guideOP=${withSignal('guideOP')} revOP=${withSignal('revOP')}`,
  );
  fs.writeFileSync(path.join(OUT_DIR, 'earnings-events.json'), JSON.stringify(events));

  // 4) 検証
  const options = { holds, exploreEnd: EXPLORE_END };
  if (process.env.COST_PCT) options.costPct = Number(process.env.COST_PCT);
  if (process.env.MIN_VA) options.minVa = Number(process.env.MIN_VA);
  console.log(`検証を開始(経過${elapsed(t0)}分)`);
  const result = runStudy({ days, stocks, events }, options);
  const report = formatReport(result);
  fs.writeFileSync(path.join(OUT_DIR, 'earnings-study.json'), JSON.stringify(result));
  fs.writeFileSync(path.join(OUT_DIR, 'earnings-study.txt'), report);
  console.log('');
  console.log(report);
  console.log('');
  console.log(
    `J-Quants リクエスト${stats.requests}回・再試行${stats.retries}回・失敗${stats.failures}回 / 所要${elapsed(t0)}分`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
