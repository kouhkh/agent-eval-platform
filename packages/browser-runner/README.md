# Browser Runner

这是与 DSH 和被测应用解耦的 Playwright 执行服务。它把浏览器操作变成有截止时间、可追踪、可取消的结构化操作，并保存用例、断言、环境和执行证据。

服务启动后访问 `http://127.0.0.1:4321/` 可打开独立评测控制台。控制台与 REST API 同源，不依赖 Planora 或其他被测应用发布；它展示测试资产的草稿门禁、执行时版本快照、执行状态与业务结论，以及清理失败证据。

这里是正式浏览器运行时的唯一 source of truth。旧 `agent-browser-runtime` 仅作为迁移历史保留，不再作为可并行演进的第二套实现。具体边界见 [`docs/browser-runtime-consolidation.md`](../../docs/browser-runtime-consolidation.md)。

## 边界

- 使用 Playwright 的 Browser/Context/Page，不自研浏览器内核。
- 默认使用独立临时 context。保留登录态时可传 `profileDir`，但必须位于 `data/profiles` 内。
- 服务不通过 REST 接收密码、cookie、localStorage、授权请求头或 POST 数据。自动登录使用通用 setup fixture：资产只保存环境变量名或不透明 `secretRef`，值由 browser-runner 进程或注册的凭据解析器在运行时解析。
- 同一 session/tab 只允许一个操作。并发请求返回 `TAB_BUSY`，不会在原 tab 上盲目重试。
- 浏览器断线会把 session 标记为 `stale`，由调用方显式 reconnect，不产生幽灵 tab。
- 每个操作都保存标注后截图；写动作保存操作前/后两张。像素证据默认最多占用 5 秒，`evidenceTimeoutMs` 可调但不超过 15 秒；操作前截图超时返回 `EVIDENCE_CAPTURE_TIMEOUT` 且不执行写动作，不静默降级。DOM 只保存交互元素摘要和最多 8,000 字符可见文本，不保存完整 HTML。
- `click`、`fill`、`upload` 等写动作必须传 `approvedScope`。原生弹框必须显式传 `dialogAction: "accept" | "dismiss"`；未声明时先安全驳回，再返回 `DIALOG_REQUIRED`。
- deadline 或 cancel 会淘汰旧 tab 并把 session 置为 `stale`；后续动作只能由调用方显式 `reconnect`。
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

需要让用户在专用 profile 中手动登录时，以有头模式启动：

```sh
AGENT_EVAL_HEADLESS=false npm start
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
GET  /api/checks
GET  /api/checks/:id
POST /api/checks/:id/runs
```

操作成功和失败都返回包含 `operationId`、`sessionId`、`tabId`、`status`、`elapsedMs`、`phase`、`errorCode` 和 `evidenceRefs` 的统一 envelope。
`act` 还记录 `before-evidence`、`perform`、`dialog`、`postcondition` 和 `after-evidence` 阶段；超时错误的 `details.operationPhase` 指明最后阶段及已完成阶段耗时，不再只返回笼统的整体 deadline。

需要把异步 HTTP 响应纳入同一动作证据窗口时，可在 `act` 中声明精确的 `waitFor.response`：

```json
{
  "action": "click",
  "target": { "role": "button", "name": "生成内容" },
  "approvedScope": "执行已确认的本地回归步骤",
  "waitFor": { "type": "response", "url": "/api/generate", "method": "POST" }
}
```

响应监听在动作前安装，URL 和 method 都必须精确匹配；相对 URL 按用例的 `environment.baseUrl` 解析。任何 HTTP 状态（包括 4xx/5xx）都会结束等待并保留状态码，但不读取或落盘 body、headers 或 cookie；产品是否通过仍由独立断言决定。
`inspect.elements` 把 `textContent`、`ariaLabel`、`nameAttribute` 分开，不把展示文本冒充成 accessible name。`accessibleNameStatus: "not-computed"` 表示本轮未计算可访问名；调用方应原样使用 `recommendedTarget.target`。优先级为 testId/uiKey/id/显式 aria-label；都缺失时返回标记为 `ephemeral` 的当前 DOM CSS 路径，不应直接固化为长期资产。

## CLI / MCP

```sh
npm run eval -- test run ./case.json
npm run eval -- test suite ./fixtures/fixed-suite.example.json
npm run eval -- browser health
npm run eval -- browser create '{"url":"https://example.com"}'
npm run eval -- browser inspect <sessionId>
npm run eval -- browser act <sessionId> '{"action":"click","target":{"role":"button","name":"Save"},"approvedScope":"approved local test change"}'
npm run eval -- browser reconnect <sessionId>
npm run eval -- browser cancel <sessionId> [operationId]
npm run eval -- browser trace <sessionId>
npm run mcp
```

CLI 通过 `AGENT_EVAL_URL` 指定服务地址；JSON 参数也可用 `@/absolute/path/request.json`。MCP 服务使用 stdio JSON-RPC，暴露 `createSession`、`navigate`、`inspect`、`act`、`assert`、`cancel`、`reconnect`、`close` 和 `getTrace`。

`test suite` 只负责编排已经存在的测试资产，不创建项目副本，也不运行部署。输入必须提供精确的应用 revision；工作区有未提交改动时还必须提供 `dirtyDiffRef`。每个场景用稳定 `benchmarkKey` 与 `scenarioType` 标识业务资料和“目录生成/章节生成”，当次 `projectBinding`、`baselineRef` 与 `copyRef` 由外部 prepare 阶段传入。单项失败、超时或未执行不会阻断后续场景，也不会自动重试；结果索引将失败副本标记为 `retained_for_investigation`，并保存 case run id、版本、业务/执行状态和全部 evidenceRefs。默认索引写入 `data/suite-runs/<runId>/index.json`，可用 `AGENT_EVAL_SUITE_RUN_ROOT` 指定其他目录。

## 测试资产

`/api/test-cases` 提供第一版 CRUD。资产包含 `assetState`、`draftIssues`、`setup`、`steps`、`cleanup`、人工确认后的 `assertions`、`environment`、`sourceRevision` 和 `policy.gate/nightly`。`assetState: "draft"` 或仍有 `draftIssues` 的资产会在创建浏览器 session 前以 `TEST_CASE_NOT_EXECUTABLE` 阻断；只有 `runnable` 且待补全项清零的版本可以执行。轨迹不直接等于测试，浏览器运行器也不负责 Agent 自主规划。

资产另有独立的 `evaluation` 元数据，供控制台区分持续主干回归和本地探索，不替代页面写操作的 `approvedScope`：

```json
{
  "evaluation": {
    "track": "experiment",
    "lifecycle": "blocked",
    "blockedReason": "导出 DOCX 缺失图片关系，保留失败现场等待修复。",
    "target": { "name": "OnlyOffice 本地实验台", "instance": "local-3041", "baseUrl": "http://127.0.0.1:3041" },
    "fixturePolicy": "每轮新建合成项目；失败保留，成功后清理",
    "promotion": { "targetAssetId": "future-mainline-onlyoffice", "note": "稳定重跑后再晋升候选回归" }
  }
}
```

`track` 只能是 `mainline`、`experiment` 或 `candidate`；旧资产默认 `mainline/active`，因此保留原有 `runnable` 语义。`lifecycle` 为 `draft`、`active`、`blocked` 或 `retired`；`blocked` 与 `retired` 会在创建浏览器 session 前阻断运行，控制台展示原因与最近一次运行。实验资产无需专用 adapter，除非它确实需要通用浏览器步骤之外的受控文件或业务检查。

每次 run 固化 `caseVersion`、不含运行历史的 `caseSnapshot` 及其 SHA-256 摘要。主步骤执行状态由 `executionStatus` 表达；业务判定由 `businessVerdict` 单独表达。没有权威断言的成功重放返回 `status: "completed"`、`executionStatus: "completed"`、`businessVerdict: "not_evaluated"`，不能写成业务通过。含权威断言且断言全部成功时才保留兼容字段 `status: "passed"`。HTTP 对 `completed` 和 `passed` 都返回 200。

`cleanup.steps` 与 setup 使用相同的通用操作结构，在主步骤完成或中断后运行。清理操作、证据、错误以及平台拥有 session 的关闭结果都保存在同一 run 的 `cleanup` 字段；清理失败会让兼容字段 `status` 为 `failed`，不会被吞掉。

### 外部固定回归检查

`/api/checks` 把固定回归资产、历史和执行状态放入控制平面，但核心服务不内置业务映射。部署时注册可信 adapter，每项资产预绑定 executor id 和参数；HTTP 请求不能传入 shell 命令。执行状态与检查结果分开，重启前未完成的记录标记为 `interrupted`，不自动重跑。导入历史保留原始任务时间和来源，不把导入时间冒充执行时间。

本地固定回归演示是外部组合，需显式指向已有资产根目录：

```sh
AGENT_EVAL_FIXED_ROOT=/absolute/path/to/fixed-assets npm run start:fixed
```

本机 OnlyOffice v2 实验资产只在显式设置 `AGENT_EVAL_DANGEROUS_V2_ROOT` 时接入同一控制台。它导入该目录的 `asset.json` 和最新证据；当前失败现场显示为 `experiment / blocked`。控制台不会自动重跑、恢复或删除保留现场。人工点击执行时，适配器仅调用仓库内固定的、已审查 driver，且不接受 HTTP 传入命令、项目编号或凭据。

`adapters/planora-fixed-regression.mjs` 是第一个外部配置/检查实例，不是平台核心对 Planora 的硬编码。它只判断基线绑定、请求证据、新 job 绑定、任务终态和产物存在/非空；目录覆盖范围和正文质量保留为待人工确认提案。

多个独立回归集通过 `adapters/external-check-adapter-registry.mjs` 组合：每个适配器只声明自己拥有的稳定 `executorIds`，并由其 `load()` 导入资产、历史和任意业务元数据，由其 `execute()` 产出 `executionStatus`、`checkVerdict`、`businessVerdict`、逐项 `checkResults` 和 `evidenceRefs`。注册层拒绝重复 executor、重复资产 id 以及“资产 executor 属于另一适配器”的错误；它不接受 HTTP 传入的 shell 命令。OnlyOffice 等新回归集应新增独立适配器并注册，而不是修改 Planora 固定回归适配器。

### 通用 setup fixture

`environment.baseUrl` 定义当次环境的基址，`startUrl`、setup 导航和 URL 断言都可以使用相对路径。`setup.steps` 只接受通用 `navigate`、`act`、`assert` 操作：

```json
{
  "title": "authenticated workspace smoke",
  "approvedScope": "use the dedicated test account and modify isolated fixture data",
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

本地 Planora 的无明文调用样例和当前 4321 运行时核对见 [`docs/local-planora-generic-login-20260908.md`](docs/local-planora-generic-login-20260908.md)。

### 可交错的测试步骤

顶层 `steps` 与 setup 使用同一组 `operation: navigate | act | assert` 语义，因此可以表达“保存 → 刷新 → 断言持久化 → 恢复原值”这类有顺序要求的验收。旧资产中没有 `operation` 的步骤仍按 `act` 执行。

```json
{
  "approvedScope": "modify and restore the selected test record",
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
- 这类 run 整体关闭 Playwright trace 和像素证据，避免后续步骤的截图仍包含登录页上的运行时输入；仍保留每步脱敏操作证据、断言结果和完整的顺序/耗时记录。
- 普通操作的 Playwright trace 是强制的；trace 无法启动时 session 创建闭合失败。
- 密码、cookie、localStorage、Authorization 请求头和 POST body 不作为浏览器证据采集。

## 验证

```sh
npm test
```

测试覆盖 stale session 的亚秒级结构化失败、deadline、取消、同 tab single-flight、脱敏证据、截图独立上限和测试资产；真实 Chromium 用例另外验证强制授权、弹框策略、文本截断、文件上传、截图和 trace 落盘。
