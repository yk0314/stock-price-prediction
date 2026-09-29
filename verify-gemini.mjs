import assert from "node:assert/strict";
import { config } from "../src/config.js";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function makeFeature(code, overrides = {}) {
  return {
    code,
    name: null,
    price: 1000,
    dataAsOf: "2026-09-19",
    isHeld: false,
    sma5: 990,
    rsi14: 55,
    financials: null,
    ...overrides,
  };
}

function extractCode(opts) {
  return JSON.parse(opts.body).contents[0].parts[0].text.match(/銘柄コード (\w+)/)[1];
}

function jsonResponse(bodyObj, status = 200, headers = {}) {
  const envelope = { candidates: [{ content: { parts: [{ text: JSON.stringify(bodyObj) }] } }] };
  return new Response(status === 200 ? JSON.stringify(envelope) : JSON.stringify({ error: bodyObj }), { status, headers });
}

const tradeableOutput = (code, overrides = {}) => ({
  code, tradeable: true, decision: "BUY", score: 80, risk: "MEDIUM",
  expectedReturn: 3.5, expectedHoldingDays: 5, upsideProbability: 60, downsideRisk: 30, confidence: 70,
  ...overrides,
});
const notTradeableOutput = (code) => ({ code, tradeable: false });
const heldOutput = (code, decision = "HOLD", overrides = {}) => ({
  code, decision, score: 70, risk: "LOW",
  expectedReturn: 1.0, expectedHoldingDays: 3, upsideProbability: 50, downsideRisk: 20, confidence: 60,
  ...overrides,
});

const originalIntervalMs = config.GEMINI.requestIntervalMs;
const originalRetryBackoffBaseMs = config.GEMINI.retryBackoffBaseMs;
const originalBackoff429Ms = config.GEMINI.backoff429Ms;
const originalMaxRetries = config.GEMINI.maxRetries;
const originalDailyLimit = config.GEMINI.dailyRequestLimit;
const originalConsecutive429Limit = config.GEMINI.consecutive429Limit;
config.GEMINI.requestIntervalMs = 1;
config.GEMINI.retryBackoffBaseMs = 1;
config.GEMINI.backoff429Ms = 1;

// ============ Candidate: pool150→150, 保有優先, 重複除外, 1銘柄1リクエスト ============
console.log("[verify] Candidate: 150件化・保有優先・重複除外・1銘柄1リクエスト");

await test("candidateCountの既定値は150(config.js)", async () => {
  assert.equal(config.GEMINI.candidateCount, 150);
});

await test("150銘柄でも150回のfetch呼び出しになる(バッチ化されていない)", async () => {
  const originalFetch = global.fetch;
  const { analyzeCandidates } = await import("../src/gemini.js");
  let callCount = 0;
  global.fetch = async (url, opts) => {
    callCount++;
    return jsonResponse(tradeableOutput(extractCode(opts)));
  };
  try {
    const candidates = Array.from({ length: 150 }, (_, i) => makeFeature(String(1000 + i)));
    const results = await analyzeCandidates("key", candidates, { cutoffDate: "2026-09-19", predictionExecutedAt: "t" });
    assert.equal(callCount, 150);
    assert.equal(results.length, 150);
  } finally {
    global.fetch = originalFetch;
  }
});

await test("渡された順番(保有優先→新規)で処理される(呼び出し側が順序を決める前提の確認)", async () => {
  const originalFetch = global.fetch;
  const { analyzeCandidates } = await import("../src/gemini.js");
  const order = [];
  global.fetch = async (url, opts) => {
    const code = extractCode(opts);
    order.push(code);
    return jsonResponse(tradeableOutput(code));
  };
  try {
    // 呼び出し側(pipeline.js)は保有銘柄を先頭に並べて渡す契約
    const candidates = [
      makeFeature("HELD1", { isHeld: true }),
      makeFeature("HELD2", { isHeld: true }),
      makeFeature("NEW1", { isHeld: false }),
      makeFeature("NEW2", { isHeld: false }),
    ];
    global.fetch = async (url, opts) => {
      const code = extractCode(opts);
      order.push(code);
      return jsonResponse(candidates.find((c) => c.code === code).isHeld ? heldOutput(code) : tradeableOutput(code));
    };
    await analyzeCandidates("key", candidates, { cutoffDate: "2026-09-19", predictionExecutedAt: "t" });
    assert.deepEqual(order, ["HELD1", "HELD2", "NEW1", "NEW2"]);
  } finally {
    global.fetch = originalFetch;
  }
});

await test("各リクエストのプロンプトに他銘柄のコードが含まれない(1銘柄1リクエストの隔離確認)", async () => {
  const originalFetch = global.fetch;
  const { analyzeCandidates } = await import("../src/gemini.js");
  const prompts = [];
  global.fetch = async (url, opts) => {
    const text = JSON.parse(opts.body).contents[0].parts[0].text;
    prompts.push(text);
    return jsonResponse(tradeableOutput(extractCode(opts)));
  };
  try {
    await analyzeCandidates("key", [makeFeature("1001"), makeFeature("1002")], { cutoffDate: "2026-09-19", predictionExecutedAt: "t" });
    assert.ok(prompts[0].includes("1001") && !prompts[0].includes("1002"));
    assert.ok(prompts[1].includes("1002") && !prompts[1].includes("1001"));
  } finally {
    global.fetch = originalFetch;
  }
});

// ============ Output: tradeable / decision / score / risk / 長文なし / 不正出力 ============
console.log("[verify] Output: tradeable判定・decision・長文出力なし・不正出力検証");

await test("新規候補でtradeable=falseなら除外扱い(D1に保存しない、失敗でもない)", async () => {
  const originalFetch = global.fetch;
  const { analyzeWithGemini } = await import("../src/gemini.js");
  global.fetch = async () => jsonResponse(notTradeableOutput("2001"));
  try {
    const outcome = await analyzeWithGemini("key", makeFeature("2001"));
    assert.equal(outcome.excluded, true);
    assert.equal(outcome.success, false);
    assert.equal(outcome.result, null);
  } finally {
    global.fetch = originalFetch;
  }
});

await test("新規候補でtradeable=trueならBUYとして成功扱いになる", async () => {
  const originalFetch = global.fetch;
  const { analyzeWithGemini } = await import("../src/gemini.js");
  global.fetch = async () => jsonResponse(tradeableOutput("2002"));
  try {
    const outcome = await analyzeWithGemini("key", makeFeature("2002"));
    assert.equal(outcome.success, true);
    assert.equal(outcome.excluded, false);
    assert.equal(outcome.result.rating, "BUY");
  } finally {
    global.fetch = originalFetch;
  }
});

await test("保有銘柄(isHeld=true)はtradeable判定なしで、HOLD/SELL/BUYそれぞれ受理される", async () => {
  const originalFetch = global.fetch;
  const { analyzeWithGemini } = await import("../src/gemini.js");
  for (const decision of ["BUY", "HOLD", "SELL"]) {
    global.fetch = async () => jsonResponse(heldOutput("3001", decision));
    try {
      const outcome = await analyzeWithGemini("key", makeFeature("3001", { isHeld: true }));
      assert.equal(outcome.success, true, `decision=${decision}で成功するはず`);
      assert.equal(outcome.result.rating, decision);
    } finally {
      global.fetch = originalFetch;
    }
  }
});

await test("成功結果にsummary/reasoning等の長文フィールドが含まれない(null/空配列)", async () => {
  const originalFetch = global.fetch;
  const { analyzeWithGemini } = await import("../src/gemini.js");
  global.fetch = async () => jsonResponse(tradeableOutput("4001"));
  try {
    const outcome = await analyzeWithGemini("key", makeFeature("4001"));
    assert.equal(outcome.result.summary, null);
    assert.equal(outcome.result.reasoning, null);
    assert.deepEqual(outcome.result.positiveFactors, []);
    assert.deepEqual(outcome.result.negativeFactors, []);
  } finally {
    global.fetch = originalFetch;
  }
});

await test("プロンプト自体が長文を要求していない(summary/reasoningの語を含まない)", async () => {
  const originalFetch = global.fetch;
  const { analyzeWithGemini } = await import("../src/gemini.js");
  let capturedPrompt = null;
  global.fetch = async (url, opts) => {
    capturedPrompt = JSON.parse(opts.body).contents[0].parts[0].text;
    return jsonResponse(tradeableOutput("4002"));
  };
  try {
    await analyzeWithGemini("key", makeFeature("4002"));
    assert.ok(!capturedPrompt.includes('"summary"'));
    assert.ok(!capturedPrompt.includes('"reasoning"'));
  } finally {
    global.fetch = originalFetch;
  }
});

await test("新規候補でtradeableが未指定/不正なら失敗扱い(除外でもない)", async () => {
  const originalFetch = global.fetch;
  const { analyzeWithGemini } = await import("../src/gemini.js");
  const broken = tradeableOutput("5001");
  delete broken.tradeable;
  global.fetch = async () => jsonResponse(broken);
  try {
    const outcome = await analyzeWithGemini("key", makeFeature("5001"));
    assert.equal(outcome.success, false);
    assert.equal(outcome.excluded, false);
  } finally {
    global.fetch = originalFetch;
  }
});

await test("銘柄コード不一致・score範囲外・不正decisionは失敗扱い", async () => {
  const originalFetch = global.fetch;
  const { analyzeWithGemini } = await import("../src/gemini.js");

  global.fetch = async () => jsonResponse(tradeableOutput("9999")); // リクエストは6001なのに9999
  try {
    const outcome = await analyzeWithGemini("key", makeFeature("6001"));
    assert.equal(outcome.success, false);
  } finally {
    global.fetch = originalFetch;
  }

  global.fetch = async () => jsonResponse(tradeableOutput("6002", { score: 500 }));
  try {
    assert.equal((await analyzeWithGemini("key", makeFeature("6002"))).success, false);
  } finally {
    global.fetch = originalFetch;
  }

  global.fetch = async () => jsonResponse(tradeableOutput("6003", { decision: "STRONG_BUY" }));
  try {
    assert.equal((await analyzeWithGemini("key", makeFeature("6003"))).success, false);
  } finally {
    global.fetch = originalFetch;
  }
});

await test("Geminiが独自のpriceを返しても、こちらのfeature.priceが常に優先される(汚染防止)", async () => {
  const originalFetch = global.fetch;
  const { analyzeWithGemini } = await import("../src/gemini.js");
  global.fetch = async () => jsonResponse(tradeableOutput("7001", { price: 999999 }));
  try {
    const outcome = await analyzeWithGemini("key", makeFeature("7001", { price: 1234 }));
    assert.equal(outcome.success, true);
    assert.equal(outcome.result.price, 1234);
  } finally {
    global.fetch = originalFetch;
  }
});

// ============ Rate limit: 30秒間隔・429・503・バックオフ・連続429停止 ============
console.log("[verify] Rate limit: 通常間隔・429/503リトライ・連続429安全停止");

await test("通常時は config.GEMINI.requestIntervalMs(30秒相当の設定値)でsleepされる", async () => {
  const originalFetch = global.fetch;
  const { analyzeCandidates } = await import("../src/gemini.js");
  global.fetch = async (url, opts) => jsonResponse(tradeableOutput(extractCode(opts)));
  const originalSetTimeout = global.setTimeout;
  const sleepCalls = [];
  global.setTimeout = (fn, ms, ...args) => {
    if (ms === config.GEMINI.requestIntervalMs) sleepCalls.push(ms);
    return originalSetTimeout(fn, 0, ...args);
  };
  try {
    await analyzeCandidates("key", [makeFeature("8001"), makeFeature("8002"), makeFeature("8003")], {
      cutoffDate: "2026-09-19", predictionExecutedAt: "t",
    });
    assert.equal(sleepCalls.length, 2); // 3銘柄なら間隔は2回(最後の後は待機しない)
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
  }
});

await test("429: リトライ後成功する", async () => {
  const originalFetch = global.fetch;
  const { analyzeWithGemini } = await import("../src/gemini.js");
  let callCount = 0;
  global.fetch = async (url, opts) => {
    callCount++;
    if (callCount === 1) return jsonResponse({ message: "rate limited" }, 429);
    return jsonResponse(tradeableOutput(extractCode(opts)));
  };
  try {
    const outcome = await analyzeWithGemini("key", makeFeature("9001"));
    assert.equal(outcome.success, true);
    assert.equal(outcome.statusCounts.status429, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

await test("429: Retry-Afterヘッダがあれば最優先で使う", async () => {
  const originalFetch = global.fetch;
  const { analyzeWithGemini } = await import("../src/gemini.js");
  const originalSetTimeout = global.setTimeout;
  const allTimeouts = [];
  global.setTimeout = (fn, ms, ...args) => {
    allTimeouts.push(ms);
    return originalSetTimeout(fn, 0, ...args);
  };
  let callCount = 0;
  global.fetch = async (url, opts) => {
    callCount++;
    if (callCount === 1) return jsonResponse({ message: "rate limited" }, 429, { "retry-after": "9" });
    return jsonResponse(tradeableOutput(extractCode(opts)));
  };
  try {
    await analyzeWithGemini("key", makeFeature("9002"));
    assert.ok(allTimeouts.includes(9000), `9000msが見つからない: ${JSON.stringify(allTimeouts)}`);
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
  }
});

await test("429: Retry-Afterが無ければ config.GEMINI.backoff429Ms(固定値)を使う", async () => {
  const originalFetch = global.fetch;
  const { analyzeWithGemini } = await import("../src/gemini.js");
  config.GEMINI.backoff429Ms = 12345;
  const originalSetTimeout = global.setTimeout;
  const allTimeouts = [];
  global.setTimeout = (fn, ms, ...args) => {
    allTimeouts.push(ms);
    return originalSetTimeout(fn, 0, ...args);
  };
  let callCount = 0;
  global.fetch = async (url, opts) => {
    callCount++;
    if (callCount === 1) return jsonResponse({ message: "rate limited" }, 429); // Retry-Afterなし
    return jsonResponse(tradeableOutput(extractCode(opts)));
  };
  try {
    await analyzeWithGemini("key", makeFeature("9003"));
    assert.ok(allTimeouts.includes(12345), `12345msが見つからない: ${JSON.stringify(allTimeouts)}`);
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    config.GEMINI.backoff429Ms = 1;
  }
});

await test("429: リトライ上限に達したら失敗扱い、無限リトライしない", async () => {
  const originalFetch = global.fetch;
  const { analyzeWithGemini } = await import("../src/gemini.js");
  let callCount = 0;
  global.fetch = async () => {
    callCount++;
    return jsonResponse({ message: "rate limited" }, 429);
  };
  try {
    const outcome = await analyzeWithGemini("key", makeFeature("9004"));
    assert.equal(outcome.success, false);
    assert.equal(callCount, 1 + config.GEMINI.maxRetries);
  } finally {
    global.fetch = originalFetch;
  }
});

await test("503: 指数バックオフでリトライされ、429とは別カウントされる", async () => {
  const originalFetch = global.fetch;
  const { analyzeWithGemini } = await import("../src/gemini.js");
  let callCount = 0;
  global.fetch = async () => {
    callCount++;
    return jsonResponse({ message: "unavailable" }, 503);
  };
  try {
    const outcome = await analyzeWithGemini("key", makeFeature("9005"));
    assert.equal(outcome.statusCounts.status503, 1 + config.GEMINI.maxRetries);
    assert.equal(outcome.statusCounts.status429, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

await test("503: Retry-Afterヘッダがあれば優先される", async () => {
  const originalFetch = global.fetch;
  const { analyzeWithGemini } = await import("../src/gemini.js");
  const originalSetTimeout = global.setTimeout;
  const allTimeouts = [];
  global.setTimeout = (fn, ms, ...args) => {
    allTimeouts.push(ms);
    return originalSetTimeout(fn, 0, ...args);
  };
  let callCount = 0;
  global.fetch = async (url, opts) => {
    callCount++;
    if (callCount === 1) return jsonResponse({ message: "unavailable" }, 503, { "retry-after": "3" });
    return jsonResponse(tradeableOutput(extractCode(opts)));
  };
  try {
    await analyzeWithGemini("key", makeFeature("9006"));
    assert.ok(allTimeouts.includes(3000));
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
  }
});

await test("500等、429/503以外は即座に失敗扱い(リトライしない)", async () => {
  const originalFetch = global.fetch;
  const { analyzeWithGemini } = await import("../src/gemini.js");
  let callCount = 0;
  global.fetch = async () => {
    callCount++;
    return jsonResponse({ message: "internal" }, 500);
  };
  try {
    await analyzeWithGemini("key", makeFeature("9007"));
    assert.equal(callCount, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

await test("連続429が上限に達したら安全停止する(Gemini rate limit detected, stopping safely)", async () => {
  config.GEMINI.consecutive429Limit = 4;
  config.GEMINI.maxRetries = 0; // 1候補あたり1回の429で即失敗するようにして数えやすくする
  const originalFetch = global.fetch;
  const { analyzeCandidates } = await import("../src/gemini.js");
  let callCount = 0;
  global.fetch = async () => {
    callCount++;
    return jsonResponse({ message: "rate limited" }, 429);
  };
  const originalWarn = console.warn;
  const warns = [];
  console.warn = (...args) => { warns.push(args.join(" ")); originalWarn(...args); };
  try {
    const candidates = Array.from({ length: 10 }, (_, i) => makeFeature(`A${i}`));
    const results = await analyzeCandidates("key", candidates, { cutoffDate: "2026-09-19", predictionExecutedAt: "t" });
    // consecutive429Limit=4、1候補=1回の429なので4候補目で停止するはず
    assert.equal(callCount, 4);
    assert.equal(results.length, 0);
    assert.ok(warns.some((w) => w.includes("Gemini rate limit detected, stopping safely")));
  } finally {
    global.fetch = originalFetch;
    console.warn = originalWarn;
    config.GEMINI.consecutive429Limit = originalConsecutive429Limit;
    config.GEMINI.maxRetries = originalMaxRetries;
  }
});

await test("単発の429では安全停止しない", async () => {
  config.GEMINI.consecutive429Limit = 3;
  const originalFetch = global.fetch;
  const { analyzeCandidates } = await import("../src/gemini.js");
  global.fetch = async (url, opts) => {
    const code = extractCode(opts);
    if (code === "B1") return jsonResponse({ message: "rate limited" }, 429);
    return jsonResponse(tradeableOutput(code));
  };
  try {
    // B1で1回だけ429が起きるが、その後リトライで成功する想定(config.GEMINI.maxRetries>=1が前提)
    config.GEMINI.maxRetries = Math.max(originalMaxRetries, 1);
    let callCountB1 = 0;
    global.fetch = async (url, opts) => {
      const code = extractCode(opts);
      if (code === "B1") {
        callCountB1++;
        if (callCountB1 === 1) return jsonResponse({ message: "rate limited" }, 429);
      }
      return jsonResponse(tradeableOutput(code));
    };
    const results = await analyzeCandidates("key", [makeFeature("B1"), makeFeature("B2")], {
      cutoffDate: "2026-09-19", predictionExecutedAt: "t",
    });
    assert.equal(results.length, 2, "単発429はリトライで回復し、両方成功するはず");
  } finally {
    global.fetch = originalFetch;
    config.GEMINI.consecutive429Limit = originalConsecutive429Limit;
    config.GEMINI.maxRetries = originalMaxRetries;
  }
});

await test("成功(または除外)すると連続429カウンタが0にリセットされる", async () => {
  config.GEMINI.consecutive429Limit = 3;
  config.GEMINI.maxRetries = 0;
  const originalFetch = global.fetch;
  const { analyzeCandidates } = await import("../src/gemini.js");
  // 429, 429, 成功, 429, 429 という並び。リセットが効いていれば5件処理完了するまで停止しない。
  const sequence = [429, 429, "ok", 429, 429];
  let idx = 0;
  global.fetch = async (url, opts) => {
    const step = sequence[idx++];
    if (step === "ok") return jsonResponse(tradeableOutput(extractCode(opts)));
    return jsonResponse({ message: "rate limited" }, 429);
  };
  try {
    const candidates = Array.from({ length: 5 }, (_, i) => makeFeature(`C${i}`));
    const results = await analyzeCandidates("key", candidates, { cutoffDate: "2026-09-19", predictionExecutedAt: "t" });
    assert.equal(idx, 5, "リセットが効いていれば5件全て処理されるはず(途中停止しない)");
    assert.equal(results.length, 1);
  } finally {
    global.fetch = originalFetch;
    config.GEMINI.consecutive429Limit = originalConsecutive429Limit;
    config.GEMINI.maxRetries = originalMaxRetries;
  }
});

console.log("[verify] Rate limit: 日次上限");

await test("dailyRequestLimitに達したら残りの銘柄には着手しない", async () => {
  config.GEMINI.dailyRequestLimit = 2;
  const originalFetch = global.fetch;
  const { analyzeCandidates } = await import("../src/gemini.js");
  let callCount = 0;
  global.fetch = async (url, opts) => {
    callCount++;
    return jsonResponse(tradeableOutput(extractCode(opts)));
  };
  try {
    const candidates = [makeFeature("D1"), makeFeature("D2"), makeFeature("D3"), makeFeature("D4")];
    const results = await analyzeCandidates("key", candidates, { cutoffDate: "2026-09-19", predictionExecutedAt: "t" });
    assert.equal(callCount, 2);
    assert.equal(results.length, 2);
  } finally {
    global.fetch = originalFetch;
    config.GEMINI.dailyRequestLimit = originalDailyLimit;
  }
});

console.log("[verify] 1銘柄の失敗/除外で全体を中断しない・最終集計ログ");

await test("1銘柄目が失敗・2銘柄目が除外でも、3銘柄目は処理される", async () => {
  const originalFetch = global.fetch;
  const { analyzeCandidates } = await import("../src/gemini.js");
  global.fetch = async (url, opts) => {
    const code = extractCode(opts);
    if (code === "E1") return jsonResponse({ message: "err" }, 500);
    if (code === "E2") return jsonResponse(notTradeableOutput(code));
    return jsonResponse(tradeableOutput(code));
  };
  try {
    const results = await analyzeCandidates(
      "key",
      [makeFeature("E1"), makeFeature("E2"), makeFeature("E3")],
      { cutoffDate: "2026-09-19", predictionExecutedAt: "t" }
    );
    assert.deepEqual(results.map((r) => r.code), ["E3"]);
  } finally {
    global.fetch = originalFetch;
  }
});

await test("最終集計ログにtotal/success/failed/excluded/429/503/requestsMade等が出る", async () => {
  const originalFetch = global.fetch;
  const { analyzeCandidates } = await import("../src/gemini.js");
  global.fetch = async (url, opts) => jsonResponse(tradeableOutput(extractCode(opts)));
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));
  try {
    await analyzeCandidates("key", [makeFeature("F1"), makeFeature("F2")], { cutoffDate: "2026-09-19", predictionExecutedAt: "t" });
    const summaryLine = logs.find((l) => l.includes("total=2") && l.includes("success=2") && l.includes("excluded=") && l.includes("requestsMade="));
    assert.ok(summaryLine, "集計ログが出力されていない: " + JSON.stringify(logs));
  } finally {
    global.fetch = originalFetch;
    console.log = originalLog;
  }
});

// ============ Persistence: onCandidateCompleteフック経由の即時保存/除外時スキップ ============
console.log("[verify] Persistence: onCandidateCompleteフック(即時D1保存・除外時スキップ)");

await test("成功時はonCandidateCompleteでexcluded=false・success=trueとして通知される", async () => {
  const originalFetch = global.fetch;
  const { analyzeCandidates } = await import("../src/gemini.js");
  global.fetch = async (url, opts) => jsonResponse(tradeableOutput(extractCode(opts)));
  const outcomes = [];
  try {
    await analyzeCandidates("key", [makeFeature("G1")], { cutoffDate: "2026-09-19", predictionExecutedAt: "t" }, {
      onCandidateComplete: (o) => outcomes.push(o),
    });
    assert.equal(outcomes[0].success, true);
    assert.equal(outcomes[0].excluded, false);
  } finally {
    global.fetch = originalFetch;
  }
});

await test("tradeable=false時はonCandidateCompleteでexcluded=trueとして通知される(D1保存フックが呼び出し側でスキップできる)", async () => {
  const originalFetch = global.fetch;
  const { analyzeCandidates } = await import("../src/gemini.js");
  global.fetch = async (url, opts) => jsonResponse(notTradeableOutput(extractCode(opts)));
  const outcomes = [];
  try {
    await analyzeCandidates("key", [makeFeature("G2")], { cutoffDate: "2026-09-19", predictionExecutedAt: "t" }, {
      onCandidateComplete: (o) => outcomes.push(o),
    });
    assert.equal(outcomes[0].excluded, true);
    assert.equal(outcomes[0].success, false);
  } finally {
    global.fetch = originalFetch;
  }
});

// ============ 観測ログ: 429の原因調査情報・トークン数・APIキー非漏洩 ============
console.log("[verify] 観測ログ: 429クォータ詳細・トークン数・APIキー非漏洩");

await test("429のbodyにQuotaFailure情報があれば、lastError.quotaDetailsとして保持される(情報を捨てない)", async () => {
  const originalFetch = global.fetch;
  const { analyzeWithGemini } = await import("../src/gemini.js");
  config.GEMINI.maxRetries = 0;
  const errorBody = {
    code: 429,
    message: "Resource has been exhausted",
    status: "RESOURCE_EXHAUSTED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }],
      },
    ],
  };
  global.fetch = async () => new Response(JSON.stringify({ error: errorBody }), { status: 429 });
  try {
    const outcome = await analyzeWithGemini("key", makeFeature("QD1"));
    assert.equal(outcome.success, false);
    assert.equal(outcome.lastError.status, 429);
    assert.equal(outcome.lastError.quotaDetails.status, "RESOURCE_EXHAUSTED");
    assert.ok(outcome.lastError.quotaDetails.violations[0].quotaId.includes("PerMinute"));
  } finally {
    global.fetch = originalFetch;
    config.GEMINI.maxRetries = originalMaxRetries;
  }
});

await test("429のbodyがJSONとして解釈できない場合でも、クラッシュせずquotaDetails=nullになる(推測で情報を作らない)", async () => {
  const originalFetch = global.fetch;
  const { analyzeWithGemini } = await import("../src/gemini.js");
  config.GEMINI.maxRetries = 0;
  global.fetch = async () => new Response("plain text error, not json", { status: 429 });
  try {
    const outcome = await analyzeWithGemini("key", makeFeature("QD2"));
    assert.equal(outcome.lastError.quotaDetails, null);
  } finally {
    global.fetch = originalFetch;
    config.GEMINI.maxRetries = originalMaxRetries;
  }
});

await test("成功レスポンスのusageMetadata(入出力トークン数)がoutcome.usageに含まれる", async () => {
  const originalFetch = global.fetch;
  const { analyzeWithGemini } = await import("../src/gemini.js");
  global.fetch = async (url, opts) => {
    const envelope = {
      candidates: [{ content: { parts: [{ text: JSON.stringify(tradeableOutput(extractCode(opts))) }] } }],
      usageMetadata: { promptTokenCount: 1234, candidatesTokenCount: 56 },
    };
    return new Response(JSON.stringify(envelope), { status: 200 });
  };
  try {
    const outcome = await analyzeWithGemini("key", makeFeature("TK1"));
    assert.equal(outcome.usage.promptTokens, 1234);
    assert.equal(outcome.usage.outputTokens, 56);
  } finally {
    global.fetch = originalFetch;
  }
});

await test("APIキー文字列がコンソールログに一切出力されない(429/成功/除外いずれも)", async () => {
  const originalFetch = global.fetch;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const { analyzeWithGemini } = await import("../src/gemini.js");
  const SECRET = "SECRET-API-KEY-SHOULD-NEVER-APPEAR";
  const captured = [];
  console.log = (...args) => captured.push(args.join(" "));
  console.warn = (...args) => captured.push(args.join(" "));
  config.GEMINI.maxRetries = 1;
  let n = 0;
  global.fetch = async (url, opts) => {
    n++;
    if (n === 1) return jsonResponse({ message: "rate limited" }, 429);
    return jsonResponse(tradeableOutput(extractCode(opts)));
  };
  try {
    await analyzeWithGemini(SECRET, makeFeature("KEY1"));
    assert.ok(!captured.some((line) => line.includes(SECRET)), "APIキーがログに出力されている");
  } finally {
    global.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
    config.GEMINI.maxRetries = originalMaxRetries;
  }
});

// 設定値を元に戻す
config.GEMINI.requestIntervalMs = originalIntervalMs;
config.GEMINI.retryBackoffBaseMs = originalRetryBackoffBaseMs;
config.GEMINI.backoff429Ms = originalBackoff429Ms;
config.GEMINI.maxRetries = originalMaxRetries;
config.GEMINI.dailyRequestLimit = originalDailyLimit;
config.GEMINI.consecutive429Limit = originalConsecutive429Limit;

console.log(`\n[verify] ${passed}件成功`);
if (process.exitCode) {
  console.error("[verify] 失敗あり");
} else {
  console.log("[verify] 全て成功");
}
