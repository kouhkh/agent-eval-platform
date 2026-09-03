# Browser Runner

这是与 DSH 和被测应用解耦的 Playwright 执行服务。它把浏览器操作变成有截止时间、可追踪、可取消的结构化操作，并保存用例、断言、环境和执行证据。

## 边界

- 使用 Playwright 的 Browser/Context/Page，不自研浏览器内核。
- 默认使用独立临时 context。保留登录态时可传 `profileDir`，但必须位于 `data/profiles` 内，且由用户手动登录。
- 服务不接收或记录密码、cookie、localStorage、请求头和 POST 数据。
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

`/api/test-cases` 提供第一版 CRUD。资产包含 `steps`、人工确认后的 `assertions`、`environment`、`sourceRevision` 和 `policy.gate/nightly`。`POST /api/test-cases/:id/runs` 按这些权威断言执行并记录历史。轨迹不直接等于测试，浏览器运行器也不负责 Agent 自主规划。

## 验证

```sh
npm test
```

测试覆盖 stale session 的亚秒级结构化失败、deadline、取消、同 tab single-flight、浏览器断线后的 stale 标记、脱敏证据、测试资产持久化和一次完整用例执行。
