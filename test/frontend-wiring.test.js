import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

// 画面(public/)の配線チェック。実機で起きた「読み込まれていない・未定義」系の不具合を、
// デプロイ前に静的に検出するためのテスト。
const publicDir = new URL("../public/", import.meta.url);
const html = readFileSync(new URL("index.html", publicDir), "utf8");
const app = readFileSync(new URL("app.js", publicDir), "utf8");

test("index.html が読み込む <script src> / <link href> のファイルが public/ に実在する(デプロイ漏れの検出)", () => {
  const refs = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((ref) => !/^https?:\/\//.test(ref));
  assert.ok(refs.includes("app.js") && refs.includes("style.css"));
  for (const ref of refs) {
    assert.ok(existsSync(new URL(ref, publicDir)), `${ref} が public/ にありません`);
  }
});

test("app.js が getElementById で参照するidは、すべて index.html に存在する", () => {
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...app.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, []);
});

test("app.js は OrderAssist を別ファイルのグローバル(globalThis.OrderAssist)に依存せず、自分の中で定義している", () => {
  assert.ok(!/globalThis\.OrderAssist/.test(app));
  assert.match(app, /const OrderAssist = \(function \(\)/);
  assert.match(app, /const OA = OrderAssist;/);
  assert.ok(!/orderAssist\.js/.test(html), "index.html が別ファイルの orderAssist.js を読み込んでいます");
});

test("ランキングの各銘柄に「買う」ボタン(data-action=buy-assist)があり、BUY登録は既存の POST /api/trades を使う", () => {
  assert.match(app, /data-action="buy-assist" data-code="\$\{item\.code\}">買う<\/button>/);
  assert.match(app, /postJson\("\/api\/trades", \{\s*code: buyAssistTarget\.code,\s*transactionType: "buy"/);
});
