#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const baseUrl = String(process.env.AGENT_EVAL_URL || "http://127.0.0.1:4321").replace(/\/$/, "");
const args = process.argv.slice(2);

function usage() {
  console.error(`用法：
  agent-eval test run <case.json>
  agent-eval browser health
  agent-eval browser create [JSON|@file.json]
  agent-eval browser get <sessionId>
  agent-eval browser navigate|inspect|act|assert <sessionId> [JSON|@file.json]
  agent-eval browser cancel <sessionId> [operationId]
  agent-eval browser reconnect <sessionId> [JSON|@file.json]
  agent-eval browser close|trace <sessionId>`);
  process.exitCode = 2;
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { "content-type": "application/json", "x-agent-eval-client": "cli", ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  return { ...body, ...(response.ok ? {} : { httpStatus: body.httpStatus || response.status }) };
}

async function payload(token) {
  if (!token) return {};
  const text = token.startsWith("@") ? await readFile(token.slice(1), "utf8") : token;
  return JSON.parse(text);
}

function output(value) {
  console.log(JSON.stringify(value, null, 2));
  if (value?.status === "failed" || value?.errorCode) process.exitCode = 1;
}

if (!args[0] || !args[1]) { usage(); } else {
  try {
    const namespace = args[0];
    const command = args[1];
    if (namespace === "test" && command === "run") {
      const file = args[2];
      if (!file) { usage(); throw new Error("缺少 case.json"); }
      const payload = JSON.parse(await readFile(file, "utf8"));
      const created = await request("/api/test-cases", { method: "POST", body: JSON.stringify(payload) });
      if (!created.testCase?.id) { output(created); throw new Error("测试资产创建失败。"); }
      const result = await request(`/api/test-cases/${created.testCase.id}/runs`, { method: "POST", body: JSON.stringify({}) });
      output(result);
    } else if (namespace === "browser" && command === "health") {
      output(await request("/api/health"));
    } else if (namespace === "browser" && command === "create") {
      output(await request("/api/sessions", { method: "POST", body: JSON.stringify(await payload(args[2])) }));
    } else if (namespace === "browser" && command === "get") {
      const sessionId = args[2];
      if (!sessionId) { usage(); throw new Error("缺少 sessionId"); }
      output(await request(`/api/sessions/${encodeURIComponent(sessionId)}`));
    } else if (namespace === "browser" && ["navigate", "inspect", "act", "assert", "reconnect"].includes(command)) {
      const sessionId = args[2];
      if (!sessionId) { usage(); throw new Error("缺少 sessionId"); }
      output(await request(`/api/sessions/${encodeURIComponent(sessionId)}/${command}`, { method: "POST", body: JSON.stringify(await payload(args[3])) }));
    } else if (namespace === "browser" && command === "cancel") {
      const sessionId = args[2];
      if (!sessionId) { usage(); throw new Error("缺少 sessionId"); }
      output(await request(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: "POST", body: JSON.stringify({ operationId: args[3] || undefined }) }));
    } else if (namespace === "browser" && command === "close") {
      const sessionId = args[2];
      if (!sessionId) { usage(); throw new Error("缺少 sessionId"); }
      output(await request(`/api/sessions/${encodeURIComponent(sessionId)}/close`, { method: "POST", body: "{}" }));
    } else if (namespace === "browser" && command === "trace") {
      const sessionId = args[2];
      if (!sessionId) { usage(); throw new Error("缺少 sessionId"); }
      output(await request(`/api/sessions/${encodeURIComponent(sessionId)}/trace`));
    } else {
      usage();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
