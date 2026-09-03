# Agent Eval Platform

这是一个与具体业务系统解耦的“评测控制平面 + 可替换执行器”开发仓库。第一版固定两个能独立运行的服务：

- [`packages/dsh-bridge`](packages/dsh-bridge)：管理轨迹分析、测试提案、脚本生成和 HITL 界面修改任务，通过 DeepSeek Harness 理解代码。
- [`packages/browser-runner`](packages/browser-runner)：使用 Playwright 执行已确认的步骤和断言，管理 session、deadline、取消、trace 和证据。

PinAsk 是轨迹/界面指称入口，DSH 是可替换的 Coding Agent，Playwright 是默认浏览器执行器。这三者都不与某个被测应用绑定。

## 边界

```text
PinAsk / REST / CLI / MCP / CI
               |
               v
       评测控制平面
       |              |
       v              v
  DSH Bridge     Browser Runner
  代码理解/生成     Playwright 执行/证据
```

- 轨迹是用户意图和现场上下文，不是权威测试。人工确认后的步骤和断言才能进入门禁或夜间回归。
- 业务差异优先用测试资产中的 URL、locator、API 和文件断言表达，不为每个项目新建 adapter 仓库。只有标准协议无法表达的领域能力才作为可选集成注册。
- 被测应用的版本记在每次用例执行的 `sourceRevision`，不写入平台全局版本清单。
- 平台依赖版本记在 [`compatibility.yaml`](compatibility.yaml)，用于复现 DSH、PinAsk 和 Playwright 的组合。
- `packages/browser-runner` 是浏览器运行时唯一正式实现。旧 `agent-browser-runtime@8917906` 的安全契约已迁入此包，旧仓库只保留历史，不再双轨开发。
- 凭据、会话 profile、任务历史和证据目录均不进入 Git。
- 登录等前置条件用通用 `setup` fixture 表达，而不是被测系统 adapter。输入值可在运行时通过环境变量或可替换的 `secretRef` 解析器注入；明文不写入测试资产、REST 请求、运行结果或证据。

## 开发

需要 Node.js 22.19 或更高版本。

```sh
npm install
npm test
npm run start:browser
```

启动 DSH 桥接前，先构建兼容清单指定的 DSH fork，然后设置：

```sh
export DSH_ROOT=/absolute/path/to/deepseek-harness
export DSH_AGENT_WORKSPACE_ROOTS=/absolute/path/to/allowed/code
npm run start:dsh
```

默认端口是 DSH Bridge `4319`、Browser Runner `4321`，两者均只绑定 `127.0.0.1`。

## 当前状态

当前是开发态 POC：已有桥接服务、并行 Git worktree 修改、任务恢复、浏览器 session 管理、用例 CRUD，以及强制的截图/trace/结构化证据。完整权限模型、多租户隔离、生产排期和稳定的公开 API 仍未定型。
