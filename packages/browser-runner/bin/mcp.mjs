#!/usr/bin/env node
import readline from "node:readline";

const baseUrl = String(process.env.AGENT_EVAL_URL || "http://127.0.0.1:4321").replace(/\/$/, "");

async function call(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { "content-type": "application/json", "x-agent-eval-client": "mcp", ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  return { ...body, ...(response.ok ? {} : { httpStatus: body.httpStatus || response.status }) };
}

const tools = [
  { name: "createSession", description: "创建独立 Playwright session/tab。", inputSchema: { type: "object", properties: { url: { type: "string" }, profileDir: { type: "string" } } } },
  { name: "getSession", description: "读取 session/tab 状态。", inputSchema: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" } } } },
  { name: "health", description: "读取运行器和 session 健康状态。", inputSchema: { type: "object", properties: {} } },
  { name: "navigate", description: "导航 session 到 URL。", inputSchema: { type: "object", required: ["sessionId", "url"], properties: { sessionId: { type: "string" }, url: { type: "string" }, deadlineMs: { type: "number" } } } },
  { name: "inspect", description: "读取有界的脱敏 DOM 摘要并保存强制截图证据。", inputSchema: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" }, limit: { type: "number" }, deadlineMs: { type: "number" } } } },
  { name: "act", description: "执行浏览器动作；写动作必须携带 approvedScope。", inputSchema: { type: "object", required: ["sessionId", "action"], properties: { sessionId: { type: "string" }, action: { enum: ["click", "dblclick", "fill", "select", "check", "uncheck", "hover", "press", "scroll", "upload"] }, target: { type: ["object", "string"] }, value: {}, file: { type: "string" }, files: { type: "array", items: { type: "string" } }, approvedScope: { type: "string" }, dialogAction: { enum: ["accept", "dismiss"] }, dialogPromptText: { type: "string" }, deadlineMs: { type: "number" } } } },
  { name: "assert", description: "执行浏览器断言。", inputSchema: { type: "object", required: ["sessionId", "type"], properties: { sessionId: { type: "string" }, type: { type: "string" }, target: { type: "object" }, expected: {} } } },
  { name: "cancel", description: "取消当前 session 操作。", inputSchema: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" }, operationId: { type: "string" } } } },
  { name: "reconnect", description: "显式淘汰旧 tab 并重建 stale session。", inputSchema: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" }, url: { type: "string" }, deadlineMs: { type: "number" } } } },
  { name: "close", description: "关闭 session/tab。", inputSchema: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" } } } },
  { name: "getTrace", description: "停止并读取当前 session 的 Playwright trace 引用。", inputSchema: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" } } } },
];

async function handle(message) {
  if (message.method === "initialize") return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "agent-eval-browser-runner", version: "0.2.0" } };
  if (message.method === "notifications/initialized") return null;
  if (message.method === "tools/list") return { tools };
  if (message.method !== "tools/call") throw new Error(`不支持的 MCP 方法：${message.method}`);
  const name = message.params?.name;
  const input = message.params?.arguments || {};
  let value;
  if (name === "createSession") value = await call("/api/sessions", { method: "POST", body: JSON.stringify(input) });
  else if (name === "health") value = await call("/api/health");
  else if (name === "getSession") value = await call(`/api/sessions/${encodeURIComponent(input.sessionId)}`);
  else if (name === "navigate") value = await call(`/api/sessions/${encodeURIComponent(input.sessionId)}/navigate`, { method: "POST", body: JSON.stringify(input) });
  else if (name === "inspect") value = await call(`/api/sessions/${encodeURIComponent(input.sessionId)}/inspect`, { method: "POST", body: JSON.stringify(input) });
  else if (name === "act") value = await call(`/api/sessions/${encodeURIComponent(input.sessionId)}/act`, { method: "POST", body: JSON.stringify(input) });
  else if (name === "assert") value = await call(`/api/sessions/${encodeURIComponent(input.sessionId)}/assert`, { method: "POST", body: JSON.stringify(input) });
  else if (name === "cancel") value = await call(`/api/sessions/${encodeURIComponent(input.sessionId)}/cancel`, { method: "POST", body: JSON.stringify(input) });
  else if (name === "reconnect") value = await call(`/api/sessions/${encodeURIComponent(input.sessionId)}/reconnect`, { method: "POST", body: JSON.stringify(input) });
  else if (name === "close") value = await call(`/api/sessions/${encodeURIComponent(input.sessionId)}/close`, { method: "POST", body: JSON.stringify(input) });
  else if (name === "getTrace") value = await call(`/api/sessions/${encodeURIComponent(input.sessionId)}/trace`);
  else throw new Error(`未知工具：${name}`);
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
    const result = await handle(message);
    if (message.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  } catch (error) {
    if (message?.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } })}\n`);
  }
});
