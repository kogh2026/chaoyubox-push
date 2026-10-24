import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// WorkBuddy 的 fs shim 会拦截 %TEMP% 写入（vitest SSR 缓存 EPERM，且会吞掉测试文件）。
// 把临时目录指到项目内；本配置在 worker fork 前执行，环境变量随子进程继承。
const TMP = resolve(process.cwd(), '.tmp/vitest');
try {
  mkdirSync(TMP, { recursive: true });
} catch {
  /* 忽略 */
}
process.env.TEMP = TMP;
process.env.TMP = TMP;
process.env.TMPDIR = TMP;

export default defineConfig({
  // 缓存目录同样指到项目内，双保险
  cacheDir: 'node_modules/.vite-test',
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 单线程：多 worker 并发写同一 SSR 缓存文件会被 fs shim 拦（EPERM），
    // 且失败时会静默少收测试文件（假绿）。155 个用例顺序跑也只 1-2 秒。
    pool: 'threads',
    poolOptions: {
      threads: { singleThread: true },
    },
  },
});
