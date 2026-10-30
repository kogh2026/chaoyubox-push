# 证件照：批量导出失败 + 抠图默认值（2026-10-29）

三个问题，一个根因链：**默认值改在代码里不等于生效**、**参数能过 tsc 不等于能过 IPC**。

---

## 1. 导出失败：`An object could not be cloned.`

### 现象
导入 50+ 张照片、点「开始导出」→ 立刻红字「导出失败：An object could not be cloned.」，一份都没写出去。

### 根因（结构体克隆边界）

`src/lib/exporter.ts` 的 `saveBatch` 原先是这么把参数交给主进程的：

```ts
const res = await bridge!.saveFiles({ files: planned, ...(await dirOpts(opts)) });
```

调用方（`IdPhoto.tsx` 的 `exportAll`）传的 opts 是：

```ts
saveBatch(payload, { onProgress: (p) => setProgress(`正在写入 ${p.done}/${p.total}…`) })
```

`saveBatch` 的形参类型是 `SaveOpts & { onProgress?: ... }`，`dirOpts()` 把它原样返回，
`{ ...opts }` 展开后 **`onProgress` 这个函数就进了 `ipcRenderer.invoke` 的参数**。

Electron 的 IPC 走 V8 结构化克隆（structured clone）。函数不在可克隆类型里，直接抛
`DataCloneError: function(...s) {...} could not be cloned.` —— 就是用户看到的那句
（Electron 把它渲染成 `An object could not be cloned.`）。

**为什么单张导出没事**：`saveBytes` 的 `SaveOpts` 只有 `dir / defaultDir / filters`，没有回调。
所以只有「批量导出」这条路径必挂，且与照片数量无关（1 张也会挂，只是通常没人用批量导 1 张）。

**为什么门禁全绿却漏了**：`verify:export` 跑在 http 静态服务 + Chromium 里，
`window.electronAPI` 不存在 → 走的是浏览器 `<a download>` 回退分支，**根本不经过 IPC**。
也就是说这条路径从上线起就没有任何自动化覆盖。

### 修复

`src/lib/exporter.ts` 新增 `ipcArgs()` 白名单，`saveBytes` / `saveBlob` / `saveBatch` 全部改用它：

```ts
function ipcArgs(opts: SaveOpts): SaveOpts {
  const out: SaveOpts = {};
  if (typeof opts.dir === 'string' && opts.dir) out.dir = opts.dir;
  if (typeof opts.defaultDir === 'string' && opts.defaultDir) out.defaultDir = opts.defaultDir;
  if (Array.isArray(opts.filters) && opts.filters.length) out.filters = opts.filters.map(...);
  return out;
}
```

为什么不写成「过滤掉函数」：白名单重建能保证**对象结构本身就是纯数据**，
而不是「看起来干净、下次又混进一个 Symbol/Proxy/DOM 节点」。新增字段时必须显式加进来，
漏了是「静默不生效」（好定位），比「整批失败」轻得多。

### 护栏

| 层级 | 手段 | 结果 |
|---|---|---|
| 单测 | `exporter.test.ts` 用 `structuredClone(args)` 精确复现克隆边界：`saveBatch(items, { onProgress })` 传出去的参数必须能克隆；顺带断言 `saveBytes` 的 opts 混入函数也只保留 `data/dir/name` | 3 条新用例 |
| 负向对照 | 把 `ipcArgs(...)` 改回 `...(await dirOpts(opts))` → 立刻红，报的正是 `DataCloneError: function(...s) ... could not be cloned.`；还原后 42/42 | ✅ |
| 打包版 | 新增 `npm run verify:packaged:export`（`tools/packaged_export_smoke.py`）：直接跑 exe，验证纯字节过桥 + 原子写盘（文件真落盘、2048 字节完整），并**反向验证**「带函数过桥必抛 DataCloneError」——把因果钉住而不是靠推测 | 见运行结果 |

---

## 2. 抠图质量默认「快速」

`engine` 默认从 `isnet` 改为 `modnet`。

顺带把默认值收到一处：新增 `src/lib/matteEngine.ts`（只有类型 + `DEFAULT_MATTE_ENGINE` + 取值域，
**不 import @imgly / worker**），`mattingPool.ts` 的 `currentEngine` 初始值与
`DEFAULT_PHOTO_OPTIONS.engine` 都引它。此前是两处字面量，理论上存在
「面板显示快速、池子跑精细」的分叉空间（上一轮靠挂载时 `setMatteEngine` 兜着，现在连兜都不需要）。

代价口径：MODNet vs ISNet 在「纯色底 + 半身」证件照场景下肉眼几乎不可辨，
而 50 张实测 45s vs 288s。要更精细在面板点「精细」，且会被记住。

## 3. 去边缘默认开

`defringeOn` 代码里本来就是 `true` —— 用户截图里没高亮，说明**旧存档里存着 `false`**（此前点过「保留发丝」）。

---

## 4. 为什么「只改默认值」不够 —— 存档迁移

设置项已经落盘（`chaoyu.idphoto.options.v1`）。老用户存档里是 `engine: 'isnet'`，
`normalizePhotoOptions` 会原样读回来 → **装上新版，面板还是「精细」**。
于是「改了默认值」这件事在真实用户机器上等于没改。

`idphotoOptionsStorage.ts`：

- `CURRENT_OPTIONS_SCHEMA` 1 → **2**（存储 key 不动，动了就读不到老用户的设置）；
- 新增 `migrateFrom(version, opts)`：`< 2` 时把 `engine` / `defringeOn` **一次性归位到新默认**，
  **其余字段（规格/底色/纸张/间距/美颜…）原样保留**；
- 缺 `schemaVersion` 的更老存档按 v1 处理；
- 迁移结果**立刻写回**，避免每次启动重跑迁移、也让存档与面板长期一致。

已知取舍：本来就用「精细」的用户会被重置一次，切回去只需一次点击 ——
比「新版默认值是假的」轻得多。`v2` 存档不会再被改（用例钉住）。

---

## 5. 验证

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | 0 错 |
| `npm test` | **680 passed / 3 skipped**（671 + 9） |
| `verify:wiring` | OK |
| `verify:export` | 9/9（默认档行为零变化） |
| `verify:persist` | OK（断言已随新默认更新：默认快速 → 改精细 → 重启仍精细 → 恢复默认回快速） |
| `verify:framing` / `preview_multisize` | 通过 / `PREVIEW_OK` |
| `ui:check:fast` | 0 新增（零基线） |
| `verify:packaged` / `:persist` / `:export` | 见打包后运行结果 |
