// 用 esbuild 把 TS 测试脚本就地打包为 ESM，再用当前 node 执行。
// 测试脚本放在 scripts/（不在前端 tsc 工程 include 内），不影响 npm run build。
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, 'intake.test.ts');
const outfile = path.join(here, '.intake.test.mjs');

await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  logLevel: 'warning',
});

try {
  const mod = await import(pathToFileURL(outfile).href);
  await mod.main();
} finally {
  await rm(outfile, { force: true }).catch(() => {});
}
