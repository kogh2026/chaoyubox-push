# UI 回归检查（Impeccable）

给「超誉工作台」加的一道设计质量门禁：**改动引入新的 UI 反模式就失败，历史遗留问题不阻塞**。

- 引擎：[impeccable](https://impeccable.style) 4.8.0（Apache-2.0，62 条确定性规则，本地全离线跑，不消耗 token）
- 入口：`tools/ui-regression.mjs`
- 基线：`.impeccable/baseline.json`（提交进库）

## 一、装了什么

```bash
npm i -D impeccable          # 只装 CLI；真实引擎是随包下载的平台二进制
node node_modules/impeccable/cli/bin/cli.js --version   # → 4.8.0
```

`package.json` 新增 4 个脚本：

| 脚本 | 作用 |
| --- | --- |
| `npm run ui:check` | 回归检查；dist 不存在或落后于 src 时**自动构建**，再和基线比对 |
| `npm run ui:check:fast` | 同上，跳过构建，复用现有 `dist/` |
| `npm run ui:check:static` | 只跑 `src/` 静态扫描（秒级，pre-commit 用） |
| `npm run ui:baseline` | 重建基线（把当前所有问题认作「已知」） |
| `npm run ui:report` | 打印全部已知问题，按规则分组（排查用） |

`.impeccable/config.json` 只做目录忽略，不隐藏任何规则：

```json
{
  "detector": {
    "ignoreRules": [],
    "ignoreFiles": ["dist/**", "node_modules/**", ".tmp/**", "dist-pkg*/**"],
    "ignoreValues": []
  }
}
```

## 二、跑了两遍什么

| 扫描 | 目标 | 覆盖的规则 | 耗时 |
| --- | --- | --- | --- |
| 静态 | `src/`（`.css/.ts/.tsx`，108 个文件） | 正则级：渐变文字、AI 紫、字体选择、间距套路、结构写法 | < 2s |
| 运行时 | `dist/` 起本地静态服务 → Chromium 打开首页 | 元素级：WCAG 对比度、过小字号、嵌套卡片、触摸目标…… | 15-25s |

第二遍是必须的：低对比度、字号过小这类规则**只有算出真实样式才算得出来**，只扫源码会假阴性（CLI 自己也会提示
`findings are an undercount`）。`tools/ui-regression.mjs` 因此自带一个零依赖静态服务（SPA 回退到 `index.html`），
扫完自动关掉，端口用 OS 分配的临时端口，不占固定端口。

加 `--mobile` 会额外跑一遍 `390x844` 窄屏。

## 三、基线怎么工作

每条形如 `sha1(目标 + 规则 + 选择器 + 片段)` 的指纹。检查时三分类：

- **新增** → 打印文件:行 / 选择器 / 具体数值，退出码 **1**
- **已修复** → 打印清单（提醒你顺带 `ui:baseline` 收紧基线）
- **已知** → 只计数，不刷屏

建议级（advisory）规则即使新增也不改退出码，和 Impeccable 自身的语义一致。

```bash
npm run ui:check          # 门禁：只关心「有没有退步」
npm run ui:report         # 想看全量问题
npm run ui:baseline       # 认可一批有意为之的改动
```

报告落在 `.impeccable/reports/ui-<时间戳>.json`（已 gitignore，保留最近 20 份），含 `added`/`fixed`/`all` 三段，便于对比。

## 四、可验证的示例结果（2026-10-29 实跑）

**基线**：41 条主问题 + 2 条建议级。

```
low-contrast        × 35
undersized-ui-text  × 5
overused-font       × 1
```

**1) 干净状态**

```
$ npm run ui:check:fast
[1] --no-build：复用现有 dist
[2] 静态扫描 src/ …
[3]   静态命中 0 条
[4] 运行时扫描 http://127.0.0.1:62089/ @ 1280x800 …
[5]   命中 43 条

已知 41 条 · 新增 0 条 · 修复 0 条 · 建议级 2 条
报告：.impeccable/reports/ui-2026-10-29T03-08-06-828.json
EXIT=0
```

**2) 故意注入一处 UI 反模式**（`src/regression-demo.css` + 一条低对比度元素），门禁立刻拦下：

```
✖ 新增 3 条设计问题（回归）

  gradient-text × 1
  gradient-text @ file:src/regression-demo.css:6
      background-clip: text + gradient

  low-contrast × 1
  low-contrast @ / div.demo-runtime-badge
      1.2:1 (need 4.5:1) — text #e9e9e9 on #ffffff

  overused-font × 1
  overused-font @ file:src/regression-demo.css:9
      font-family: Inter

已知 41 条 · 新增 3 条 · 修复 0 条 · 建议级 2 条
EXIT=1
```

两条来自静态扫描（`file:行号`），一条来自运行时扫描（`选择器` + 实测对比度）——两遍都生效。
撤掉改动后重跑回到 `新增 0 条 / EXIT=0`。

## 五、边界（别高估它）

1. **只覆盖首页视图**。App 用 state 切页（`type Route`），没有 hash 路由，URL 扫描只能看到默认首页。
   其余工具页依赖静态扫描覆盖 CSS 层规则；想做逐页深度检查，得等有 hash 路由，或对运行中的 Electron 用
   `detect --cdp <port>`（本机 Electron GUI 起不来，暂未接）。
2. **不是像素级视觉回归**。它查的是设计反模式与可访问性，查不出「按钮挪了 2px」。
   界面冒烟仍由 `tools/preview_multisize.py`（Playwright）负责。
3. **基线会钝化**。把问题加进基线等于永久静音，所以 `ui:report` 要偶尔跑一次，配合「已修复」清单收紧基线。
4. 规则是确定性的启发式，会误报（例如整页正文用 Arial 被判 `overused-font`）。这类按需
   `impeccable ignores add-value <rule> <value> --reason "..."` 处理，别整条规则忽略。

## 六、CI / 打包前（可选）

```yaml
- run: npm ci
- run: npm run ui:check        # 已有构建产物则自动复用，否则先 build
```

注意 `ui:check` 会跑 `npm run build`（含 `tsc --noEmit`），在 CI 里和构建步骤会重复；
已单独构建过就直接用 `npm run ui:check:fast`。

## 七、提交门禁（husky）

`.husky/pre-commit` / `.husky/pre-push` 只做一行转发，逻辑全在 `tools/git-hooks.mjs`，
方便本地手动复现（`node tools/git-hooks.mjs pre-commit --all`）。

| 触发点 | 跑什么 | 命中条件 | 耗时 |
| --- | --- | --- | --- |
| **pre-commit** | `tsc --noEmit` | 暂存区有 `.ts/.tsx` | ~17s |
| | `vitest related --run <改动文件>` | 同上，只跑受影响的用例 | 2-4s |
| | `impeccable detect src`（静态） | 暂存区有 `.css/.ts/.tsx/.html` | 1s |
| **pre-push** | `vitest run`（全量 584 用例） | 总是 | ~14s |
| | `ui:check`（构建 + 静态 + 运行时） | 总是 | ~50s |

**为什么 pre-commit 不跑运行时扫描**：那需要先构建出 `dist`，而 `--no-build` 会拿旧产物得结论，
等于自欺欺人。要求真实渲染的对比度/字号规则放在 pre-push，先构建再扫。

**失败处理**：

1. 按报错修；类型错误看 `tsc` 行号，单测失败看用例名，反模式会打印「文件:行 / 选择器 / 实测值」。
2. 反模式确属误报 → 按值忽略并写理由：
   `node node_modules/impeccable/cli/bin/cli.js ignores add-value <rule> <value> --reason "原因"`
   （不要整条规则忽略，那会连真问题一起吞掉。）
3. 属于有意变更（例如整体换配色）→ `npm run ui:baseline` 收基线，然后重新提交。
4. 紧急绕过 → `git commit --no-verify` / `git push --no-verify`，并在提交信息里写明原因，事后补修。

暂存区里只有 .md / 图片 / 配置文件时，钩子会直接跳过（打印「没有需要检查的改动」），不会白白等 20 秒。

## 八、首轮整改记录（配色，2026-10-29）

初检 41 条主问题里 35 条是低对比度、5 条是 10px 小字，源头只有两个色值：

| token | 旧值 | 新值 | 对白底 | 对 `#f5f6f8` | 对 `#eceff3` |
| --- | --- | --- | --- | --- | --- |
| `--muted` | `#8a93a0` | `#626b79` | 3.11 → **5.39** | 2.87 → **4.98** | 2.69 → **4.67** |
| `--brand` | `#2f6fed` | `#1e63ec` | — | — | `#eef3fe` 上 4.09 → **4.66** |

配套改动：`::placeholder` 统一用 `--muted`（原来走浏览器默认 `#757575`，4.26:1）；
`.badge` 与 `.brand-ver` 从 10px 提到 11px。改完全量复检：

```
✔ 42 条已修复（low-contrast ×37 含 2 条建议级、undersized-ui-text ×5）
已知 0 条 · 新增 0 条
```

剩 1 条 `overused-font: arial` 属误报（桌面工具刻意跟随系统 UI 字体），
按值忽略并写了理由，基线随后清空——**现在是零基线：任何新反模式都会立刻失败**。
