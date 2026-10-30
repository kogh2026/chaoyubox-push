# PDF 转曲（字体转轮廓）批处理

印刷厂最常见的返工原因：客户文件里嵌了字体但打印店没装，出片时缺字。转曲（把文字变成路径）之后，
文件在任何机器上都不会再掉字。这一条需求在图文店里比「PDF 合并」高频得多。

## 一、两条路，默认走 Ghostscript

| | Ghostscript `-dNoOutputFonts` | Acrobat Preflight「将字体转换为空心」 |
| --- | --- | --- |
| 依赖 | 装个 gs（本机已有 10.08.0） | Acrobat Pro + 桌面会话 |
| 自动化 | 一条命令，无窗口 | 需注入文档级 JS、管实例、等写盘 |
| 效果 | 文本绘制为路径，字体表清空 | 只转字体，其他对象保持原样 |
| 风险 | pdfwrite 会重写整个 PDF（注释/表单域可能变化） | 需正确 profile 名，否则静默不生效 |
| 分发 | **AGPL**——随程序打包要谨慎，调本机已装的可接受 | 客户需自备 Acrobat Pro |

结论：**日常批量用 gs，遇到 gs 改坏的文件再用 Acrobat 补**。

## 二、Ghostscript 管线（已实测）

```bash
node tools/pdf-outline.mjs <文件或目录...> [--out DIR] [--jobs 4]
```

每个产出都会**正向验证**：用 pdf-lib 逐页读 `/Resources/Font`，字体引用必须归零才算成功——
「看起来转了、其实没转」是这条路最大的坑，绝不能只看退出码。

实测结果（2026-10-29，本机 4 个样例，并发 3）：

```
✔ test-(2份)双面.pdf 1p · 字体 14→0 · 3.1KB→4.4KB · 0.2s
✔ test-a3.pdf        1p · 字体 14→0 · 3.1KB→4.3KB · 0.3s
✔ test-a5.pdf        1p · 字体 14→0 · 3.1KB→5.5KB · 0.3s
✔ test-bp.pdf        3p · 字体 42→0 · 4.6KB→14.6KB · 0.3s

4/4 成功 → outline-out/
```

体积变大是正常的：文字变成路径后指令更多。页数不变、字体归零、能正常预览即可。
**上线前用真客户的复杂文件（带透明、带表单、带专色）再验一遍**，pdfwrite 偶尔会改动这些对象。

## 三、Acrobat Preflight 管线（脚本已写，未在本机跑通）

`tools/acrobat-outline.py` 按 `acrobat-unattended-preflight` 技能的 9 条实测机制实现：

```bash
python tools/acrobat-outline.py --check          # 只探测：Acrobat 路径 / 脚本目录 / 候选 profile
python tools/acrobat-outline.py --run 文件或目录 --out out --batch 12
```

关键机制（都已写进代码，改之前先读技能原文）：

1. 文件夹级脚本只认 `%APPDATA%\Adobe\Acrobat\Privileged\<版本>\JavaScripts\`；
2. 受限 API 必须字面写在 `app.trustedFunction` 函数体里，套一层助手就被拒；
3. `app.openDoc` 在特权函数里也返回 null → **逐文件注入 `/OpenAction`**，源文件只读；
4. 加载时必须同步做完（定时器不触发）；
5. **交给 Acrobat 的路径必须绝对化**，相对路径会弹模态框卡死整批；
6. 单实例上限 40 个文件，脚本默认每批 12；
7. 结果回写只能靠 `Doc.info.Title` + `saveAs`；
8. 收尾：删注入的驱动器脚本、清工作副本、摘 `/OpenAction`、`taskkill /PID`（不带 `/F`）。

**为什么我这边没跑通**：Acrobat 必须以独立实例启动并显示窗口，自动化执行环境禁止启动 GUI 程序，
所以只能验证到「环境探测 + 语法 + 注入逻辑」这一层。你在自己桌面会话语境里跑第一次时，建议：

```bash
pip install pikepdf pymupdf
python tools/acrobat-outline.py --check
python tools/acrobat-outline.py --run 测试.pdf --out .tmp/ao --batch 1
```

看两点：产出 PDF 的字体数是否为 0（脚本会打印），Acrobat 是否自己退出（没退就手动关）。
成功一批后再上量。

## 四、接进产品（下一步）

1. **入口**：PDF 工具箱新增「转曲」动作，和现有「压缩/加密/水印」并列。
2. **引擎探测**：启动时找 `gswin64c`/`gsc`；找不到则提示「安装 Ghostscript」或「用 Acrobat 打开」。
3. **前置校验**：先扫一遍字体列表，全无字体的文件直接跳过并标注「无需转曲」。
4. **结果回执**：每份文件返回「字体数 x→0 / 页数 / 体积变化」，而不是只报成功失败。
5. **许可证**：若打算随安装包分发 gs，必须先确认 AGPL 义务（提供源码等）；
   更稳的做法是检测用户已装的 gs，或改走商业授权渠道。
