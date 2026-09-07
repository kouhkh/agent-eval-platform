# Planora 123 显式评测项参考（2026-09-08）

## 核心事实

- `.migration/final-main-7a260008-123-20260908/api-db-audit/研发自测-代码API数据库只读矩阵.md` — 代码、API 与数据库只读矩阵。
- `.migration/final-main-7a260008-123-20260908/browser/README.md` — 浏览器关键链、结果、清理动作及 evidenceRefs 索引。
- `.migration/final-main-7a260008-123-20260908/browser/session-f33c0658-engineering-name-blocked/3bb30de2-b4cc-417a-868a-ddc38114908a/` — 用户提供的现场证据只有 `operation.json` 与 `error.json`，60 秒后返回 `DEADLINE_EXCEEDED`；无 screenshot/result/network。

## 调用链 / 约束

- 测试资产使用通用 `setup → navigate → inspect → act → assert → cleanup/restore` 表达，不新增 Planora adapter。
- 写操作保留 `approvedScope`；原生对话框保留 `dialogAction`；清理失败不得通过手工改库伪造成功。
- `packages/browser-runner/lib/browser-runner.mjs:captureAnnotatedScreenshot` — 像素证据改为独立有界阶段；操作前截图超时时禁止写操作。

## 候选显式评测项

| 评测项 | 通用步骤重点 | 交接结果 |
| --- | --- | --- |
| 登录态与导航 | setup 后 navigate/inspect/assert | 通过 |
| 投标、施工、技术响应章节读取 | navigate → act → text assert | 通过 |
| 策略修改持久化 | act 修改/保存 → navigate 重开 → assert → restore | 通过 |
| 知识库 CRUD | 新建/启停/删除后分别 assert，最后 cleanup | 通过 |
| 技术响应启停 | dialogAction 的 dismiss/accept 双分支 → restore | 通过 |
| 技术响应两模式与单选 | 模式切换 → 连续选择 → count/value assert → 取消 | 通过 |
| 危大图片持久化 | upload → save → refresh → image/count assert → cleanup | 通过 |
| 四个研发克隆清理 | 精确对象删除 → href/count=0 | 通过 |
| 431 章模板重新解析 | act 解析 → fresh GET/navigate → 章节数与异常状态 assert | 通过 |
| 工程名称生成入口 | before evidence → act → 生成与持久化 assert | 未通过：交接轨迹未触发 act |

“通过”仅转录交接索引的研发自测结果；本修复任务没有重放这些 Planora 链路。

## 已知边界

- 以上是研发自测资产，不是测试人员验收。
- 本仓只记录来源及通用契约，不复制带登录态的 trace 或 Planora 业务数据。
- 该现场证明整个 act 在写操作前结束；仅凭现有两份 JSON，无法独立证明 60 秒全部耗在 Playwright `page.screenshot`内部。

## 未知项

- 修复后尚未在 123 重项目页重放“2.1工程名称”。
- 页面是否能在 5 秒内生成截图待实测；超时时会显式失败，不点击。
