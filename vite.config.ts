import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // 相对路径，确保 electron loadFile(app.asar/dist/index.html) 时
  // 资源以 ./assets/... 相对解析，而非 /assets/... 绝对解析（否则打包后白屏）
  base: './',
  plugins: [react()],
  server: { port: 5173, open: false },
});
