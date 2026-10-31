# 超誉工作台 v0.0.12 发布说明

## 新增：证卡拼版卡片圆角（必备特性）

针对「证卡拼版助手」的**输出效果**对齐爱印（AiYin）原版——切割/矫正后的卡片在排版与导出时四角呈现**自然圆角**，不再是直角。这是必备特性，默认即生效。

### 改动范围
- `src/lib/idCardLayout.ts`
  - 新增 `roundRectPath()`（圆角矩形裁剪路径）、`cardCornerRadiusMm()`（半径决策，纯函数）、`CARD_CORNER_FACTOR = 0.08`（短边占比）。
  - `PageStyle` 增加可选 `cornerRadiusMm`；`renderCardPage()` 在每格绘制前对卡片做圆角裁剪。
  - 默认行为：未显式指定时按卡片短边 8% 自动取圆角（身份证 54mm 短边 ≈ 4.3mm，肉眼可见且不过分）。
- `src/lib/vectorSheetPdf.ts`（**首选矢量导出路径**）
  - `VectorSheetStyle` 增加 `cornerRadiusMm`；`defaultEncodeCell()` 在把每个单元格编码为 JPEG 前做圆角裁剪（JPEG 不透明 → 白底白角，正确）。
  - 圆角并入去重指纹 `cellFingerprint()`，改圆角会重新编码（不会串图）。
- `src/tools/CardLayout.tsx`
  - 新增「圆角」滑块（0–8mm，默认 **4mm**）。预览、导 PDF、打印三条路径统一传入 `cornerRadiusMm`。

### 覆盖范围（两条导出路径都已生效）
1. 屏幕预览（`renderCardPage`）——已加圆角裁剪。
2. **矢量导出 PDF（首选路径）** `saveVectorSheetPdf` —— 单元格编码阶段裁剪。
3. 位图回退导出 `exportPagesPdf` —— 复用 `renderCardPage` 画布，同样带圆角。
4. 打印 —— 同源矢量 PDF，带圆角。

> 说明：左侧「可编辑」缩略图是源卡，不做圆角（与爱印一致）；圆角只作用于页面排版与导出结果。

### 验证
- 类型检查 `tsc --noEmit`：PASS
- 单元测试：771 passed（含新增 4 项真实画布集成验证）
  - `renderCardPage` 真实渲染：角点像素=白（圆角生效）、中心=红（卡片绘制）；`cornerRadiusMm=0` 时角点=红（直角，开关有效）。
  - `exportVectorSheetPdf` 真实单元格编码：导出的嵌入 JPEG 解码后角点≈白、中心仍为主红 → 导出文件实际带圆角。
  - 并生成 `.tmp/rounded-proof.png` 供人工核对。
- 像素采样确认：圆角裁剪在裁剪排除区为白、卡片区为红，证明圆角真正落到输出像素。

### 仍待处理（与本次无关）
- P0 日志清理（1.33GB）仍待手动执行（权限规则拦截，需你在终端跑命令）。
- 重启 explorer 让新程序解包到 D 盘（避免 _MEI 再次污染 C 盘）。
- P1/P2（4 个更新器安装包 1.86GB、traces 520MB）尚未处理。
