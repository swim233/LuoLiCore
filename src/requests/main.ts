import { runExport } from './export.js';

// 导出请求记录：pnpm requests（用法见 --help）
process.exitCode = await runExport({
  argv: process.argv.slice(2),
  env: process.env,
  now: new Date(),
  stdout: process.stdout,
  stderr: process.stderr,
});
