import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 版本号单一来源：package.json 的 version 通过编译期常量注入渲染层，
// 界面（App 侧栏/设置·关于）一律读 APP_VERSION，杜绝多处硬编码漂移。
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // 相对路径，确保 electron loadFile(app.asar/dist/index.html) 时
  // 资源以 ./assets/... 相对解析，而非 /assets/... 绝对解析（否则打包后白屏）
  base: './',
  plugins: [react()],
  // 抠图/透视等 Worker 使用 ES module 格式，配合 new Worker(url,{type:'module'})
  worker: { format: 'es' },
  resolve: {
    alias: [
      // @imgly 会按 device==='gpu' 动态 import onnxruntime-web/webgpu，把我们用不到的
      // jsep(WebGPU) 运行时（含 24MB wasm）打进了 dist。本项目全程 CPU 推理，
      // 统一指向 wasm-only 构建，安装包少 24MB。
      { find: /^onnxruntime-web\/webgpu$/, replacement: 'onnxruntime-web/wasm' },
      // @imgly 非 GPU 分支 import('onnxruntime-web') 会拉全 EP 构建（内含 24MB jsep wasm），
      // 同样收敛到 wasm-only
      { find: /^onnxruntime-web$/, replacement: 'onnxruntime-web/wasm' },
    ],
  },
  server: {
    port: 5173,
    open: false,
    // 开发态也开 crossOriginIsolated：否则 onnxruntime 单线程，无法复现/验证 P0 线程改造
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    rollupOptions: {
      input: {
        // 主应用
        main: 'index.html',
        // 打印载体页：主进程用隐藏窗口加载它，把 PDF 栅格化后静默送印。
        // 独立入口而不是塞进主应用路由 —— 载体页不该跑整个 React 应用（状态恢复、更新检查等）。
        printHelper: 'printHelper.html',
      },
      output: {
        // 代码分割：把「只在渲染进程(main/printHelper)使用、从不进 Worker」的重型库拆成独立 chunk。
        // 好处：主包变小、vendor 可独立缓存；这些库仍随启动加载，但不再挤进主包。
        // 注意：绝不把 Worker 专属库(onnxruntime-web / @imgly 在 matting.worker)抽成共享块，
        // 否则 Worker 解析共享块会失败。xlsx / tesseract 已改动态 import，由 vite 自动分块，这里不强制。
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('pdf-lib')) return 'vendor-pdf-lib';
          if (id.includes('pdfjs-dist')) return 'vendor-pdfjs';
          if (id.includes('jspdf')) return 'vendor-jspdf';
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react';
          return undefined;
        },
      },
    },
  },
});
