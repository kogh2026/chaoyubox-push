# 06: cardLayout 布局引擎单测

**What to build:** 为 computeLayout 补单元测试：核心布局算法（给定纸/照片/边距/间隙的行×列）、边界（间隙为 0、照片比可用区还大、margin 吃掉半张纸）、异常输入（负数、0、NaN、Infinity）。只测公共接口，预期值手工演算。用户视角：排版算错一张纸能排几张的概率被测试压住。

**Blocked by:** None (can start immediately)

**Status:** done (2026-10-24)

- [ ] 典型值：A4 排 1 寸照片的行列与每纸张数
- [ ] gap=0 与 gap 很大的对比
- [ ] 照片尺寸 ≥ 可用区时降级为 1×1 不返回 0
- [ ] margin 过大导致可用区为负仍返回 ≥1
- [ ] 异常输入（0/负数/NaN）不抛且结果有界
- [ ] vitest 全绿
