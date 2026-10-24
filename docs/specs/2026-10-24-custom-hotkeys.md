# 规格：可自定义全局快捷键系统

- 日期：2026-10-24
- 状态：ready-for-agent（本地 tracker 模式，未配置 GitHub/GitLab issue）
- 关联：超誉工作台 clone

## Problem Statement

设置中心的「快捷键」页现在是一张写死的展示表：列出了 Ctrl K / Ctrl O / Ctrl P / Ctrl S / Ctrl 加减 / Ctrl 0 六个快捷键，但用户改不了，页面背后也没有任何注册机制——App 里只硬编码了 Ctrl K（聚焦搜索）和 Ctrl 0（缩放复位）两个，其余四个（导入、打印、导出、放大、缩小）纯属摆设。对打印店用户来说，左手键盘右手活是常态，键位不合手只能忍着；更麻烦的是想用的组合被系统或输入法占了，也没有地方避开。

## Solution

把快捷键从「说明文档」变成「可配置的功能」：设置中心快捷键页变成可编辑表格，每个动作可以录制新键位、检测冲突、恢复默认；App 级动作（搜索、缩放）直接生效，工具级动作（导入、打印、导出）通过事件总线派发给当前打开的工具。键位存在本地，跨会话保留，多组件同步。

## User Stories

1. As a 打印店操作员, I want 在设置里看到每个快捷键当前绑定的按键, so that 我知道按什么键会触发什么。
2. As a 打印店操作员, I want 点击某个动作的「录制」后按一组新按键完成改键, so that 键位贴合我的左手习惯。
3. As a 打印店操作员, I want 改键时如果和已绑定的动作冲突会被明确阻止并指出冲突方, so that 不会出现一个组合触发两个功能。
4. As a 打印店操作员, I want 把动作改回默认键位, so that 改乱了能一键复原。
5. As a 打印店操作员, I want 全部快捷键一次性恢复默认, so that 不用逐条点恢复。
6. As a 打印店操作员, I want 我改的键位关掉软件再打开还在, so that 不用每次重新配。
7. As a 打印店操作员, I want 在设置页改键位后不用重启就生效, so that 改完立刻能用。
8. As a 用户, I want 按搜索快捷键立刻回到首页并聚焦搜索框, so that 快速找工具。
9. As a 用户, I want 界面能继续用快捷键放大缩小和复位, so that 高分屏不用去设置里拖滑杆。
10. As a 批量打印用户, I want 在批量打印页按打印快捷键触发打印、按导出快捷键保存报价 PDF、按导入快捷键弹出文件选择, so that 不用鼠标点来点去。
11. As a 证卡拼版用户, I want 在证卡拼版页按导入快捷键选图、按导出快捷键导出 PDF, so that 排版流程全键盘可走。
12. As a 用户, I want 在输入框里打字时按快捷键不误触功能, so that 输文件名不会突然弹出打印。
13. As a 用户, I want 录制过程中按 Esc 取消本次录制, so that 误点了录制能退出。
14. As a 用户, I want 看到键位的友好显示（如「Ctrl K」而不是 "ctrl+k"）, so that 表格读起来自然。
15. As a 用户, I want 缩放有上下限（80%–150%）, so that 快捷键连按不会缩到看不见。
16. As a 开发者, I want 快捷键的解析、匹配、冲突检测是与 DOM 无关的纯函数, so that 全部逻辑可单测。
17. As a 开发者, I want 默认键位集中在一处定义, so that 新增动作只改一个表。
18. As a 用户, I want 未绑定（被清空）的动作不触发任何东西, so that 我可以主动禁用某个快捷键。

## Implementation Decisions

- **新增纯逻辑模块 hotkeys**：集中定义动作表（id → 默认组合）、组合串规范化（`ctrl+shift+k`， modifiers 固定顺序 ctrl/meta/shift/alt + 主键小写）、事件匹配（精确匹配，多按一个修饰符不算命中）、冲突查找（同一组合已被别的动作占用即冲突，占回自己不算）、显示格式化（`Ctrl K`）、默认与存储的合并解析。不依赖 DOM，可整模块单测。
- **存储独立于 AppSettings**：沿用项目现有的「localStorage 键 + CustomEvent 广播」模式（参照 appSettings/store），新键 `chaoyu.hotkeys.v1`、事件 `chaoyu-hotkeys-changed`。不动 AppSettings 大结构，避免波及设置中心其余七页。
- **两级派发**：App 挂全局 keydown，命中后先分流——`search` 与 `zoomIn/zoomOut/zoomReset` 由 App 直接执行；`import/print/export` 派发 CustomEvent `chaoyu-hotkey`（detail 带 action id），由工具自行订阅。这样 App 不认识工具，工具不监听键盘，边界清晰。
- **输入保护**：事件目标落在 input/textarea/select/contenteditable 或录制进行中时，快捷键一律不触发（Esc 取消录制除外）。
- **缩放收敛到设置页既有区间**：80–150%，步进 10，快捷键与设置页滑杆、首页提示共用同一 clamp。
- **录制交互**：设置页每行一个「录制」按钮，进入捕获态后按键即完成绑定（Esc 取消）；组合非法（如纯修饰键）时拒绝并保持捕获态；提交前跑冲突检测，冲突则行内红字提示冲突动作名，不落库。
- **工具接入范围**：批量打印（导入=触发文件选择、打印=既有打印、导出=保存报价 PDF）与证卡拼版（导入=选图、导出=导 PDF）两个旗舰工具接入；其余工具的事件订阅留作后续，规格内不承诺。
- **默认键位表**：search=ctrl+k, import=ctrl+o, print=ctrl+p, export=ctrl+s, zoomIn=ctrl+equal, zoomOut=ctrl+minus, zoomReset=ctrl+0。与现有设置页展示的六个一致，另补放大/缩小两个真实生效项。

## Testing Decisions

- 好测试的标准沿用已入库的 tdd 技能与既有三套单测：只测公共接口的行为，预期值独立演算，不测实现细节。
- **主要缝点（唯一新缝点）**：hotkeys 纯逻辑模块——规范化、匹配、合并解析、冲突查找、显示格式化、缩放 clamp。这是最高缝点，UI 与 DOM 全在其次。
- **既有缝点复用**：cardLayout 的 computeLayout 按用户要求补测（核心布局算法、边界、异常输入）。
- UI 录制流与端到端触发（改键后真按出新行为）用 Playwright E2E 覆盖，不强行塞进 jsdom——与 BatchPrint/CardLayout 的既有测试策略一致。
- 先例：src/lib/quote.test.ts / pdfAnalyze.test.ts / appSettings.test.ts 的结构与断言风格。

## Out of Scope

- Electron globalShortcut（OS 级全局热键，需主进程与打包配合）
- 每个工具各自独立的键位上下文（当前是全局一套）
- 其余五个工具（证件照/图片拼版/批量制卡/Office 转 PDF）的快捷键接入
- 键位方案的导入导出、云同步
- macOS 上 meta 键的显示细节（存 meta，显示统一按 Ctrl 风格处理）

## Further Notes

- 设置中心快捷键页现有的静态 SHORTCUT 数组即被本规格替换为可编辑表格，这是页面级重写而非增量。
- App.tsx 里硬编码的 Ctrl K / Ctrl 0 逻辑删除，改走绑定表——默认键位不变，用户无感。
- 事件名与存储键沿用 chaoyu 前缀，与品牌替换保持一致。
