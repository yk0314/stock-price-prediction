import assert from "node:assert/strict";

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

function makeFakeD1Query(rows) {
  return { async query() { return rows; } };
}

console.log("[verify] fetchHeldCodes");

await test("移動平均法で保有数量>0の銘柄コードのみ返す", async () => {
  const { fetchHeldCodes } = await import("../src/d1Repository.js");
  const rows = [
    { id: 1, code: "7203", transaction_type: "buy", transaction_date: "2026-08-01", quantity: 100, price: 2000 },
    { id: 2, code: "7203", transaction_type: "sell", transaction_date: "2026-09-01", quantity: 100, price: 2500 }, // 全部売却済み
    { id: 3, code: "6758", transaction_type: "buy", transaction_date: "2026-08-05", quantity: 50, price: 3000 }, // 保有中
    { id: 4, code: "9999", transaction_type: "buy", transaction_date: "2026-08-10", quantity: 10, price: 100 },
    { id: 5, code: "9999", transaction_type: "sell", transaction_date: "2026-08-20", quantity: 5, price: 120 }, // 一部売却、5株保有中
  ];
  const held = await fetchHeldCodes(makeFakeD1Query(rows));
  assert.deepEqual([...held].sort(), ["6758", "9999"]);
});

await test("取引が無ければ空配列", async () => {
  const { fetchHeldCodes } = await import("../src/d1Repository.js");
  const held = await fetchHeldCodes(makeFakeD1Query([]));
  assert.deepEqual(held, []);
});

console.log("[verify] pipeline.js buildCombinedCandidates(保有優先・isHeld付与)");

await test("buildCombinedCandidates: 保有銘柄が新規候補より先に並ぶ", async () => {
  const { buildCombinedCandidates } = await import("../src/pipeline.js");
  const combined = buildCombinedCandidates(
    [{ code: "H1" }, { code: "H2" }],
    [{ code: "N1" }, { code: "N2" }],
    new Set(["H1", "H2"])
  );
  assert.deepEqual(combined.map((c) => c.code), ["H1", "H2", "N1", "N2"]);
});

await test("buildCombinedCandidates: 通常候補と重複している保有銘柄もisHeld=trueになる", async () => {
  const { buildCombinedCandidates } = await import("../src/pipeline.js");
  const combined = buildCombinedCandidates([{ code: "H1" }], [{ code: "N1" }, { code: "N2" }], new Set(["H1", "N1"]));
  assert.equal(combined.find((c) => c.code === "H1").isHeld, true);
  assert.equal(combined.find((c) => c.code === "N1").isHeld, true);
  assert.equal(combined.find((c) => c.code === "N2").isHeld, false);
});

await test("buildCombinedCandidates: 保有銘柄0件でも正常に新規候補だけを返す", async () => {
  const { buildCombinedCandidates } = await import("../src/pipeline.js");
  const combined = buildCombinedCandidates([], [{ code: "N1" }], new Set());
  assert.deepEqual(combined.map((c) => c.code), ["N1"]);
  assert.equal(combined[0].isHeld, false);
});

console.log("[verify] pipelineD1.js source出し分け(saveEvaluationIncremental)");

await test("heldExtraCodesに含まれる銘柄はsource:holding、それ以外はsource:pipeline", async () => {
  process.env.CF_ACCOUNT_ID = "acc";
  process.env.CF_D1_DATABASE_ID = "db";
  process.env.CF_API_TOKEN = "tok";
  const originalFetch = global.fetch;
  const capturedBodies = [];
  global.fetch = async (url, opts) => {
    capturedBodies.push(JSON.parse(opts.body));
    return new Response(
      JSON.stringify({ success: true, result: [{ results: [], meta: { last_row_id: 1 } }] }),
      { status: 200 }
    );
  };
  try {
    const { saveEvaluationIncremental } = await import("../src/pipelineD1.js");
    const { D1Client } = await import("../src/d1.js");
    const d1 = new D1Client({ accountId: "acc", databaseId: "db", apiToken: "tok" });
    const meta = { predictionExecutedAt: "2026-09-21T06:00:00Z", cutoffDate: "2026-09-19" };
    const heldExtraCodes = new Set(["1301"]);
    await saveEvaluationIncremental(d1, meta, { code: "7203", score: 80, positiveFactors: [], negativeFactors: [] }, heldExtraCodes);
    await saveEvaluationIncremental(d1, meta, { code: "1301", score: 60, positiveFactors: [], negativeFactors: [] }, heldExtraCodes);

    const inserts = capturedBodies.filter((b) => b.sql.includes("INSERT INTO ai_evaluations"));
    assert.equal(inserts.length, 2);
    const toyotaInsert = inserts.find((b) => b.params[0] === "7203");
    const kyokuyoInsert = inserts.find((b) => b.params[0] === "1301");
    // sourceカラムはparams配列の18番目(0-indexで17番目、末尾から2番目)
    const sourceIndex = 17;
    assert.equal(toyotaInsert.params[sourceIndex], "pipeline");
    assert.equal(kyokuyoInsert.params[sourceIndex], "holding");
  } finally {
    global.fetch = originalFetch;
  }
});

await test("heldExtraCodes省略時は全てsource:pipeline(既存動作の回帰確認)", async () => {
  process.env.CF_ACCOUNT_ID = "acc";
  process.env.CF_D1_DATABASE_ID = "db";
  process.env.CF_API_TOKEN = "tok";
  const originalFetch = global.fetch;
  const capturedBodies = [];
  global.fetch = async (url, opts) => {
    capturedBodies.push(JSON.parse(opts.body));
    return new Response(
      JSON.stringify({ success: true, result: [{ results: [], meta: { last_row_id: 1 } }] }),
      { status: 200 }
    );
  };
  try {
    const { saveEvaluationIncremental } = await import("../src/pipelineD1.js");
    const { D1Client } = await import("../src/d1.js");
    const d1 = new D1Client({ accountId: "acc", databaseId: "db", apiToken: "tok" });
    await saveEvaluationIncremental(
      d1,
      { predictionExecutedAt: "2026-09-21T06:00:00Z", cutoffDate: "2026-09-19" },
      { code: "7203", score: 80, positiveFactors: [], negativeFactors: [] },
      undefined
    );
    const insert = capturedBodies.find((b) => b.sql.includes("INSERT INTO ai_evaluations"));
    assert.equal(insert.params[17], "pipeline");
  } finally {
    global.fetch = originalFetch;
  }
});

console.log(`\n[verify] ${passed}件成功`);
if (process.exitCode) {
  console.error("[verify] 失敗あり");
} else {
  console.log("[verify] 全て成功");
}
