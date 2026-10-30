// 版本号单一来源：编译期由 vite.config.ts 的 define 注入 package.json 的 version。
// 界面上所有版本展示（App 侧栏、设置·关于）都引用这里，避免多处硬编码漂移。
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
