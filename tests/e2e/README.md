# E2E 测试（Playwright + Python）

对构建产物（`dist/`）做真实浏览器端到端验证。前置条件：`npm install`、`npm run build`、
`pip install playwright`、`playwright install chromium`。

## 一键运行

```bash
npm run test:e2e
# 等价于 python tests/e2e/run_all.py
```

runner 会自动：检查 `dist/` → 起 `vite preview`（端口 4173，已被占用则复用）→
依次跑下面三个脚本 → 汇总 PASS/FAIL → 关闭自己拉起的服务。

## 用例

| 脚本 | 覆盖 |
|---|---|
| `test_hotkeys.py` | 快捷键全链路：默认键位触发、录制改键生效/旧键失效、冲突拒绝、Esc 取消、刷新持久化、恢复默认、设置页「当前工具支持情况」在场感 |
| `test_drop.py` | 批量打印拖放导入：扩展名兜底、多文件、toast 提示、文件行显示 |
| `test_detect.py` | 证卡拼版：证件边缘检测 + 手动角点校正冒烟 |

## 约定

- `BASE` 统一为 `http://localhost:4173/`（vite preview 默认即此端口）；
- 测试素材放 `fixtures/`（测试 PDF）；
- 运行中产生的截图写 `.out/`（已 gitignore，不污染仓库）；
- 新增用例：往 `tests/e2e/` 丢一个 `test_*.py`，并把文件名加进 `run_all.py` 的 `SCRIPTS`。
