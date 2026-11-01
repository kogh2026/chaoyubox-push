// 测试环境全局垫片（防御性，零业务影响）
//
// 部分第三方库（如 jspdf 的 node 构建）在模块加载期直接引用全局 `atob`/`btoa`。
// 现代 Node（≥16）原生提供这两个全局，但为兼容旧 Node、并避免 vitest 环境下偶发
// 缺失导致「收集期崩溃」（pre-commit 门禁的 vitest related 聚合模式曾偶发此类失败），
// 在此兜底保证它们存在。仅当全局缺失时才赋值，绝不覆盖原生实现。

const g = globalThis as unknown as {
  atob?: (data: string) => string;
  btoa?: (data: string) => string;
};

if (typeof g.atob !== 'function') {
  g.atob = (data: string) => Buffer.from(data, 'base64').toString('binary');
}
if (typeof g.btoa !== 'function') {
  g.btoa = (data: string) => Buffer.from(data, 'binary').toString('base64');
}
