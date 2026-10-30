# 03: App 全局派发器（绑定表驱动，删硬编码）

**What to build:** App 挂全局 keydown，按当前绑定表匹配：search（回首页+聚焦搜索框）、zoomIn/zoomOut/zoomReset（按 80–150 clamp 改缩放）由 App 直接执行；import/print/export 派发 CustomEvent（detail 带动作 id）交给当前工具。删除现有硬编码的 Ctrl K / Ctrl 0 逻辑，默认行为不变。输入框/下拉/录制中不触发。用户视角：设置里改的键位立刻管用，默认键位与以前手感一致。

**Blocked by:** 01 hotkeys 纯逻辑模块 + 单测

**Status:** ready-for-agent

- [ ] keydown 走绑定表匹配，命中即 preventDefault
- [ ] search/zoom 三个动作 App 内直接执行
- [ ] import/print/export 派发 CustomEvent
- [ ] 输入类元素聚焦时屏蔽（Esc 除外场景不涉及）
- [ ] 删除 App.tsx 硬编码 Ctrl K / Ctrl 0
- [ ] zoom 与设置页滑杆、首页提示同一区间
