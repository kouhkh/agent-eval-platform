# Planora 123 显式评测项参考（2026-09-08）

## 核心事实

- `.migration/main-93b8c79c-123-20260908/研发自测轨迹.md` — `main` revision `93b8c79cca9e2d87d2cbd512fe1846cd08fd4d1c` 发布后的完整动作、预期、结果和清理轨迹。
- `.migration/main-93b8c79c-123-20260908/STATUS.md` — 发布、回滚点、最终健康和研发自测状态；明确记录“目录质量评测失败”。
- `.migration/main-93b8c79c-123-20260908/evals/recvsIWh3T1KWe/metrics.json` — 秦皇岛目录指标；唯一 outline job `succeeded`，评测 verdict 为 `failed`，rerunCount 为 `0`。
- `.migration/main-93b8c79c-123-20260908/evals/recvuv8vZpYGLB/metrics.json` — 青岛评分范围指标；唯一 extraction run 为 `partial`，评测 verdict 为 `passed_with_source_filter_warning`，rerunCount 为 `0`。
- `.migration/main-93b8c79c-123-20260908/evals/recvuv8vZpYGLB/score-candidates.json` 与 `scope-decisions.json` — 仅保留 2 条具有文件、页码和 block 来源的技术评分项；4 条无可验证来源候选未写入。
- `.migration/final-main-7a260008-123-20260908/api-db-audit/研发自测-代码API数据库只读矩阵.md` — 代码、API 与数据库只读矩阵。
- `.migration/final-main-7a260008-123-20260908/browser/README.md` — 浏览器关键链、结果、清理动作及 evidenceRefs 索引。
- `.migration/final-main-7a260008-123-20260908/browser/session-f33c0658-engineering-name-blocked/3bb30de2-b4cc-417a-868a-ddc38114908a/` — 用户提供的现场证据只有 `operation.json` 与 `error.json`，60 秒后返回 `DEADLINE_EXCEEDED`；无 screenshot/result/network。
- `outputs/status-todo-20260907/章节激活卡顿调查.md` — 后续重放更正了产品卡顿推断：历史资产把 inspect `textContent` 当成 `getByRole` accessible name，错误 locator 在 postcondition 等待中未 resolved。

## 调用链 / 约束

- 测试资产使用通用 `setup → navigate → inspect → act → assert → cleanup/restore` 表达，不新增 Planora adapter。
- Planora 是当前被测应用；下列内容是应用级测试资产参考，不是 runner 内置能力或项目适配层。
- 写操作保留 `approvedScope`；原生对话框保留 `dialogAction`；清理失败不得通过手工改库伪造成功。
- 模型作业的 `succeeded` 只是执行状态；目录质量、范围和来源完整性必须由独立断言决定。
- 一次性模型评测保留 `rerunCount: 0`；断言失败不通过重跑改写。
- `packages/browser-runner/lib/browser-runner.mjs:captureAnnotatedScreenshot` — 像素证据改为独立有界阶段；操作前截图超时时禁止写操作。
- `packages/browser-runner/lib/browser-runner.mjs:pageSummary/locatorFor` — inspect 显式区分文本与可访问语义，返回可原样往返的 `recommendedTarget`；act 记录匹配数、locator 语义和最后 Playwright 错误。

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

## `main` 93b8c79c 新增显式评测项

| 评测项 | 动作与权威断言 | 已有研发自测结果 |
| --- | --- | --- |
| 投标章节末尾空编号 | 写入 5 项列表且第 5 项为空 → 修改第 1 项 → 切换章节触发自动保存 → 重进断言 5 项仍存在 → 补写第 5 项并再次切换/重进 | 通过；数据库 V1 至 V3，未出现 `&amp;nbsp;` |
| 技术响应设备正文末尾空编号 | 写入标题和 5 项列表且第 5 项为空 → 修改/切换设备自动保存 → 重进 → 补写第 5 项 → 再次读取 | 通过；首尾内容保留，完整列表可规范化为 `（1）` 至 `（5）` |
| 秦皇岛投标目录质量 | 只触发一次目录生成；分别断言根目录、层级、评分档位污染、“评分标准说明”污染和语义覆盖 | 失败；5 个根目录及子节点通过，但混入 13 个评分档位标题、5 个“评分标准说明”，并缺光伏组件、逆变器、电缆、12 个月进度、供货与安装调试衔接、培训和缺陷责任期 |
| 青岛评分要求范围 | 只触发一次抽提；断言仅有 2 条指定技术评分项、报价项为 0，且每条都有文件/页码/block | 目标范围通过并带来源过滤告警；run 为 `partial`，2 条写入，4 条无可验证来源候选被安全丢弃 |
| 输入文件身份 | fixture 同时绑定内容 SHA-256 和业务 `displayName`；创建前断言 UI 文件分类 | 已观察到边界：同一青岛 PDF 使用 UUID 文件名时无法识别为招标资料；使用业务文件名且 SHA 不变时可用 |

投标章节和设备正文的步骤不再定位“保存内容”按钮；当前权威交互是 3 秒自动保存或切换时自动保存。

“通过”仅转录交接索引的研发自测结果；本修复任务没有重放这些 Planora 链路。

## 已知边界

- 以上是研发自测资产，不是测试人员验收。
- 本仓只记录来源及通用契约，不复制带登录态的 trace 或 Planora 业务数据。
- `displayName` 是测试输入的显式身份字段，不是 runner 对 Planora 文件分类的内置逻辑。
- 目录作业成功不代表质量评测通过；青岛 extraction run 的 `partial` 也不等于目标范围失败。
- 该旧现场只能证明整个 act 没有完成；后续证据已证实存在 inspect→act locator 语义不一致，不能将超时归因为 Planora 主线程卡顿。

## 未知项

- 修复后尚未在 123 重项目页重放“2.1工程名称”。
- 页面是否能在 5 秒内生成截图待实测；超时时会显式失败，不点击。
