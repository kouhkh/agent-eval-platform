# DSH Bridge

这是无前端的 Coding Agent 桥接服务。它把轨迹、人工确认内容或 PinAsk 界面标注交给 DeepSeek Harness（DSH），并向控制平面暴露异步任务状态、已脱敏的实时进度、结果和用量指标。

主要接口：

- `POST /api/test-proposals`：只读映射轨迹与代码，生成待人工编辑的确认项和初步测试分层。
- `POST /api/test-scripts`：根据人工确认后的提案生成门禁/夜间测试；默认只读预览，只有 `applyChanges: true` 才允许写工作区。
- `POST /api/hitl-ui-changes`：接收 PinAsk 点选/框选元素和自然语言意图，使用隔离 Git worktree 并行修改白名单工作区。
- `GET /api/jobs`、`GET /api/jobs/:id` 和 `POST /api/jobs/:id/actions`：查看、恢复或重试任务。

调用方不接触 DSH 或 DeepSeek API Key。密钥只存在服务进程环境中；服务消费 DSH 的标准 Session JSONL，在进入任务历史前生成有界的脱敏展示投影。

## 开发启动

DSH 必须先在同一台机器安装依赖并构建。

```sh
export DSH_ROOT=/absolute/path/to/deepseek-harness
export DSH_AGENT_WORKSPACE_ROOTS=/absolute/path/to/allowed/code
npm start
```

服务优先继承启动进程中的 `DEEPSEEK_API_KEY`；若未设置，则使用 Node 内置 env 文件加载器读取 `DSH_ROOT/.env`。默认监听 `http://127.0.0.1:4319`，建议只通过本机或 SSH 端口转发访问。`GET /api/health` 查看 DSH 构建和工作区配置，`GET /api/spec` 查看接口。

Windows PowerShell：

```powershell
$env:DSH_ROOT = 'D:\dev\deepseek-harness'
$env:DSH_AGENT_WORKSPACE_ROOTS = 'D:\dev\workspaces'
npm start
```

## 安全与 Git 边界

- 服务端只接受 `DSH_AGENT_WORKSPACE_ROOTS` 白名单下的真实目录。
- 提案任务强制 `read-only`；脚本任务默认 `read-only`；写任务只能修改隔离 worktree。
- 轨迹和人工输入在进入 DSH 前脱敏；DSH 事件在进入用户可见历史前再脱敏和截断。
- 每次代码修改形成独立 Git 提交和 `refs/dsh/jobs/...` 引用。目标工作区已有并发改动时，由任务自动整合，不把手工合并留给用户。
- 不提交 `data/`、`.env`、API Key、会话 profile 或证据文件。

## 验证

```sh
npm test
DSH_AGENT_FAKE=1 npm start
```

Windows 搬迁脚本位于 `deploy/windows/`。搬迁包不得包含 DSH 根目录 `.env`、API Key、`.git` 或 Mac 的 `node_modules`。
