/**
 * data/ 目录 JSON 校验（Phase 0：语法级校验）。
 * Zod Schema 深度校验（含 meta.sourceIds / confirmation 强制字段）在 Phase 2 实现。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const dataRoot = fileURLToPath(new URL("../data", import.meta.url));

let total = 0;
let failed = 0;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.endsWith(".json")) continue;
    total++;
    try {
      JSON.parse(readFileSync(full, "utf8"));
    } catch (error) {
      failed++;
      console.error(`FAIL ${relative(dataRoot, full)}: ${error.message}`);
    }
  }
}

walk(dataRoot);

if (failed > 0) {
  console.error(`数据校验失败：${failed}/${total} 个文件存在 JSON 语法错误`);
  process.exit(1);
}
console.log(`数据校验通过：${total} 个 JSON 文件`);
