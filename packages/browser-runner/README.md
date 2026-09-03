# Browser Runner

这是与 DSH 和被测应用解耦的 Playwright 执行服务。它把浏览器操作变成有截止时间、可追踪、可取消的结构化操作，并保存用例、断言、环境和执行证据。

## 边界

- 使用 Playwright 的 Browser/Context/Page，不自研浏览器内核。
- 默认使用独立临时 context。保留登录态时可传 `profileDir`，但必须位于 `data/profiles` 内。
- 服务不通过 REST 接收密码、cookie、localStorage、授权请求头或 POST 数据。自动登录使用通用 setup fixture：资产只保存环境变量名或不透明 `secretRef`，值由 browser-runner 进程或注册的凭据解析器在运行时解析。
- 同一 session/tab 只允许一个操作。并发请求返回 `TAB_BUSY`，不会在原 tab 上盲目重试。
- 浏览器断线会把 session 标记为 `stale`，由调用方显式 reconnect，不产生幽灵 tab。
- 默认不截图；`inspect` 传 `screenshot: true` 才保存 PNG。DOM 只保存交互元素摘要，不保存完整 HTML。
- 核心不内置任何项目适配器。被测系统直接使用标准 URL、locator、HTTP 与文件断言；确有领域扩展时，由部署组合注册元数据，无需新建一个 adapter 仓库。

## 启动

```sh
cd packages/browser-runner
npm install
npx playwright install chromium
npm start
```

如果复用已安装的 Chrome：

```sh
AGENT_EVAL_BROWSER_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm start
```

默认监听 `http://127.0.0.1:4321`。可用 `PORT`、`HOST`、`AGENT_EVAL_BROWSER` 和 `AGENT_EVAL_BROWSER_EXECUTABLE` 调整；服务默认仅绑定环回地址。

## REST 最小接口

```text
POST /api/sessions
GET  /api/sessions/:id
GET  /api/sessions/:id/health
POST /api/sessions/:id/navigate
POST /api/sessions/:id/inspect
POST /api/sessions/:id/act
POST /api/sessions/:id/assert
POST /api/sessions/:id/cancel
POST /api/sessions/:id/reconnect
POST /api/sessions/:id/close
GET  /api/sessions/:id/trace
GET  /api/test-cases
POST /api/test-cases
POST /api/test-cases/:id/runs
```

操作成功和失败都返回包含 `operationId`、`sessionId`、`tabId`、`status`、`elapsedMs`、`phase`、`errorCode` 和 `evidenceRefs` 的统一 envelope。

## CLI / MCP

```sh
npm run eval -- test inspect <sessionId>
npm run eval -- test cancel <sessionId> [operationId]
npm run eval -- test trace <sessionId>
npm run eval -- test run ./case.json
npm run mcp
```

CLI 通过 `AGENT_EVAL_URL` 指定服务地址。MCP 服务使用 stdio JSON-RPC，暴露 `createSession`、`navigate`、`inspect`、`act`、`assert`、`cancel`、`close` 和 `getTrace`。

## 测试资产

`/api/test-cases` 提供第一版 CRUD。资产包含 `setup`、`steps`、人工确认后的 `assertions`、`environment`、`sourceRevision` 和 `policy.gate/nightly`。`POST /api/test-cases/:id/runs` 按这些权威断言执行并记录历史。轨迹不直接等于测试，浏览器运行器也不负责 Agent 自主规划。

### 通用 setup fixture

`environment.baseUrl` 定义当次环境的基址，`startUrl`、setup 导航和 URL 断言都可以使用相对路径。`setup.steps` 只接受通用 `navigate`、`act`、`assert` 操作：

```json
{
  "title": "authenticated workspace smoke",
  "environment": {
    "name": "local",
    "baseUrl": "http://127.0.0.1:3000"
  },
  "setup": {
    "steps": [
      { "operation": "navigate", "url": "/login" },
      {
        "operation": "act",
        "action": "fill",
        "target": { "label": "Username" },
        "valueFrom": { "env": "EVAL_TEST_USERNAME" }
      },
      {
        "operation": "act",
        "action": "fill",
        "target": { "label": "Password" },
        "valueFrom": { "secretRef": "qa/login/password" }
      },
      {
        "operation": "act",
        "action": "click",
        "target": { "role": "button", "name": "Sign in" }
      },
      { "operation": "assert", "type": "url", "expected": "/dashboard" }
    ]
  },
  "startUrl": "/workspace",
  "steps": [],
  "assertions": [
    { "type": "visible", "target": { "testId": "workspace" } }
  ]
}
```

`valueFrom.env` 直接读取 browser-runner 进程的同名环境变量。`valueFrom.secretRef` 是不透明引用，由嵌入服务时传入的 `secretResolver(ref)` 解析；未注册解析器时闭合失败，不会回退到明文。

### 可交错的测试步骤

顶层 `steps` 与 setup 使用同一组 `operation: navigate | act | assert` 语义，因此可以表达“保存 → 刷新 → 断言持久化 → 恢复原值”这类有顺序要求的验收。旧资产中没有 `operation` 的步骤仍按 `act` 执行。

```json
{
  "environment": { "baseUrl": "http://127.0.0.1:3000" },
  "steps": [
    { "operation": "act", "action": "click", "target": { "role": "button", "name": "Save" } },
    { "operation": "navigate", "url": "/record/1" },
    { "operation": "assert", "type": "text", "target": { "label": "Name" }, "expected": "saved value" },
    { "operation": "act", "action": "click", "target": { "role": "button", "name": "Restore" } }
  ]
}
```

步骤失败后立即短路，后续步骤和最终 `assertions` 不会执行；已执行步骤的成功/失败证据按原顺序保留。

安全约束：

- setup 中的 `fill` 禁止持久化 `value`，必须使用 `valueFrom.env` 或 `valueFrom.secretRef`。
- 解析后的值使用非可枚举的运行时属性传给 Playwright，不进入测试资产、操作请求证据或 run 历史。运行结果还会使用当次解析值做二次脱敏。
- 含运行时输入的 setup 必须由该次 run 新建独立 session；不允许复用已开启 trace 的外部 session。
- 这类 run 关闭 Playwright trace，并且不保存携带运行时输入的操作所返回的截图，避免 trace snapshot/action 或像素证据泄露输入值；仍保留每步脱敏操作证据、断言结果和完整的顺序/耗时记录。
- 密码、cookie、localStorage、Authorization 请求头和 POST body 不作为浏览器证据采集。

## 验证

```sh
npm test
```

测试覆盖 stale session 的亚秒级结构化失败、deadline、取消、同 tab single-flight、浏览器断线后的 stale 标记、脱敏证据、测试资产持久化和一次完整用例执行。
