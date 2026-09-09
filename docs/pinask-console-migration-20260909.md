# PinAsk 接回评测控制台

## 资产与边界

| 字段 | 值 | 证据 |
|---|---|---|
| 源资产 | `/Users/ltc/CursorProject/中交机电局项目/pinask` | Git `main@57df332`，clean |
| 源实现 | 静态 overlay + Python 服务 | `overlay/pinask.js`、`overlay/pinask.css`、`server/server.py` |
| 源服务 | `http://127.0.0.1:8788` | 已有 LaunchAgent，本轮未重复启动 |
| 目标 | `agent-eval-platform/packages/browser-runner` | 外部评测控制台 4373 |
| DSH | 既有 4374 bridge | 本轮未新建后端，未提交真实修改意见 |

## 交互合同与映射

| ID | 状态 | 行为 | 目标实现 | 验收 |
|---|---|---|---|---|
| C-01 | Observed + Required | F9 或显式按钮打开标注层 | 复用 8788 overlay；4373 常驻悬浮球提供“开始标注” | 悬浮球可见，点击后入口可见，标注层可打开 |
| C-02 | Observed | 点选单元素，拖框多选，分组标记 | 原样复用 PinAsk overlay | 单元素点选产生 chip；源/目标均显示框选与分组控件 |
| C-03 | Required | 填写自然语言修改意见 | 复用 `#pinask-question` | 填写后 value 断言通过 |
| C-04 | Required | 用户明确提交后修改当前评测前端 | 4373 先写 8788，再以服务端固定 workspace 调 4374 HITL | fake PinAsk/DSH 集成测试通过；客户端 workspace 不能覆盖目标 |
| C-05 | Required | 查看正在进行和历史任务 | 悬浮球面板轮询 `GET /api/hitl-ui/jobs` | 空历史态实页可见；fake job 列表集成测试通过 |
| C-06 | Required | 延续评测控制台视觉身份 | 复用三柱 SVG favicon、原侧栏品牌和“——刘天赐开发” | HTML/SVG Content-Type 测试与实页断言通过 |

## 运行时证据

| 场景 | 源证据 | 目标证据 | 结果 |
|---|---|---|---|
| 关闭 → F9 打开 → Esc 关闭 | session `99090a5f-1cb4-4225-8f06-f3882d061c7e`，ops `74535bbd`、`28f985af`、`b550d5b4`、`1d9ea068`、`81c2d0f7`、`2eafd4eb` | 目标同样复用已验证 overlay | Matched |
| 悬浮球 → 历史面板 → 标注层 | N/A | session `08cb3556-00bd-4085-88cf-c99fc6601fc3`，ops `e6d7ea0f`、`f0314a11`、`1a34f4e3`、`9c878558`、`96bd7178` | Adapted：增加显式可见入口 |
| 点选元素与填写意见 | N/A | ops `ed5bfc00`、`2ac8347e`、`b2604249`、`6977c1ea`、`38aa8150`、`356ce820` | Matched；未提交，退出后丢弃 fixture |
| Playwright trace | `evidence://99090a5f-1cb4-4225-8f06-f3882d061c7e/trace-1788949204097/trace.zip` | `evidence://08cb3556-00bd-4085-88cf-c99fc6601fc3/trace-1788949204253/trace.zip` | 已保存 |

## 已知差异与未知项

- 真实“提交并修改”未在当前工作区点击，避免代用户创建代码修改；保存、固定 workspace 和 job 状态用独立 fake 服务验证。
- 4374 当前没有 `hitl-ui-change` 历史，因此真页只验证了空历史和轮询；有任务后面板显示真实状态、进度和结果。
- 保留现有 DSH 测试提案功能；未恢复旧原型中的 fake 流程数据或 Planora 专属录制器。
