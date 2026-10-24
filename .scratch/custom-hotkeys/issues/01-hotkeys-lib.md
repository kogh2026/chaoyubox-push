# 01: hotkeys 纯逻辑模块 + 单测

**What to build:** 快捷键的默认键位表、组合串规范化（`ctrl+shift+k`）、事件匹配（精确匹配，多按修饰符不命中）、默认与存储合并解析、冲突查找、显示格式化（`Ctrl K`）、缩放 clamp（80–150）全部作为与 DOM 无关的纯函数落地，并有完整单测。用户视角：键位有了唯一事实来源，后续页面和派发都读它。

**Blocked by:** None (can start immediately)

**Status:** done (2026-10-24)

- [ ] 七个动作的默认键位集中定义（search/import/print/export/zoomIn/zoomOut/zoomReset）
- [ ] normalizeCombo 覆盖字母/数字/特殊键（equal、minus）、修饰符固定顺序、大小写无关
- [ ] matchCombo 精确匹配：组合一致才命中，多按 shift/alt 不命中
- [ ] resolveBindings：存储的部分覆盖与默认合并；空串=解绑
- [ ] findConflict：占回自己不冲突，被别人占冲突并指出对方
- [ ] comboLabel：`ctrl+shift+k` → `Ctrl Shift K`
- [ ] clampZoom：80–150，步进 10
- [ ] vitest 全绿，`npm run build` 不受影响
