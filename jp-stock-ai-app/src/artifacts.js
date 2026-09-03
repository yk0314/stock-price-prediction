import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * 各処理段階の中間データをJSONファイルとして保存する。
 * 目的:
 * - J-Quants取得だけ再実行 / 特徴量計算だけ再実行 / スクリーニングだけ再実行 / Geminiだけ再実行
 *   を将来的に容易にすること
 * - GitHub Actions の workflow artifact としてアップロードし、デバッグできるようにすること
 */
export async function writeArtifact(name, data) {
  await mkdir(config.ARTIFACTS_DIR, { recursive: true });
  const path = join(config.ARTIFACTS_DIR, name);
  await writeFile(path, JSON.stringify(data, null, 2), "utf-8");
  console.log(`[artifacts] 保存: ${path}`);
  return path;
}

export async function readArtifact(name) {
  const path = join(config.ARTIFACTS_DIR, name);
  const text = await readFile(path, "utf-8");
  return JSON.parse(text);
}
