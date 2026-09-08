# 本地 Planora 通用登录 setup 调用说明（2026-09-08）

## 当前 4321 事实

- 目标：本机 `127.0.0.1:4321`，不是测试环境或内网机。
- 监听进程：PID `93897`，工作目录为本仓库 `packages/browser-runner`，启动时间 `2026-09-08 21:03:44 +0800`。
- 健康检查：Playwright Chromium 已加载，`contextCount=0`、`pageCount=0`；10 条 session 记录均为 `closed`，当前没有占用中的 tab。
- 本地 `main` 当前为 `d158faf494d485da19153e4c727d850363ae9844`；它在 `21:43:56` 才快进到主干。根据 main reflog，进程启动时主干为 `9356168`。服务 API 没有自报构建 revision，因此这是基于进程启动时间与 Git reflog 的可审计推断，不是进程自身证明。
- `9356168..d158faf` 只修改 suite CLI、文档、fixture、suite runner 和测试，没有修改 `server.mjs`、session manager、setup fixture 或 test control plane。当前 4321 的 REST 执行能力与 `d158faf` 一致；从本地最新 `main` 启动的 CLI 可以直接调用它，不需要为 suite 功能重启服务。

## 最小调用路径

示例资产：[`../fixtures/generic-login-planora-local.example.json`](../fixtures/generic-login-planora-local.example.json)。它使用登录页现有的“用户名”“密码”“登录”可访问标签，并使用相对 URL 保留 `/liutianci/` base path。

1. 由本机秘密注入机制把 `EVAL_PLANORA_USERNAME` 和 `EVAL_PLANORA_PASSWORD` 注入 browser-runner 进程环境。不要把值写入 fixture、命令参数、Git、日志或本说明。
2. 将 fixture 的 `environment.baseUrl` 换成 fixture owner 提供的本地隔离 Planora 地址，将 `sourceRevision` 换成该副本的精确 revision。地址应以 `/` 结尾。
3. 创建资产并执行：

```sh
cd /Users/ltc/CodexProject/中交机电局项目/agent-eval-platform
AGENT_EVAL_URL=http://127.0.0.1:4321 npm --workspace @agent-eval-platform/browser-runner run eval -- test run packages/browser-runner/fixtures/generic-login-planora-local.example.json
```

实际链路为：run 新建独立 session → `login` → 运行时填充用户名/密码 → 点击登录 → 断言 `dashboard/projects` → 导航业务起始页 → 执行 steps/assertions → 关闭 session。不要先创建外部 session 再传 `sessionId`；包含运行时凭据的 setup 会以 `SENSITIVE_SETUP_REQUIRES_OWN_SESSION` 闭合失败。

## 凭据与证据边界

- 资产只保存环境变量名 `EVAL_PLANORA_USERNAME`、`EVAL_PLANORA_PASSWORD`，不保存值。
- setup 的 `fill` 禁止内联 `value`。运行时值通过非可枚举属性传入，并用于结果二次脱敏。
- 只要 setup 含运行时值，该次 run 会关闭 Playwright trace 和所有像素证据，避免登录值或登录后的敏感页面状态进入截图/trace。
- 仍保存脱敏后的操作顺序、耗时、断言结果和错误码；不会采集 cookie、localStorage、Authorization 请求头或 POST body。
- 默认独立 `server.mjs` 没有注册 `secretResolver`，所以 `{ "secretRef": "..." }` 在该启动方式下不能解析。第一版本机调用使用 `valueFrom.env` 即可；若以后必须接公司秘密服务，再为进程组合注入 resolver，不需要改变测试资产协议。

## 已有验证

`browser-runner.test.mjs` 的通用 setup 回归已验证：用户名/密码只在内存中进入 fake runner；`test-cases.json`、公开 run、证据文件不包含值；资产仍保留变量名；含运行时值的 run 不生成 PNG。该测试不使用真实账号，也不执行真实 Planora 登录。
