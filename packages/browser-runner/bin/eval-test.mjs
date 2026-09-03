#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const baseUrl = String(process.env.AGENT_EVAL_URL || "http://127.0.0.1:4321").replace(/\/$/, "");
const args = process.argv.slice(2);

function usage() {
  console.error("用法：agent-eval test run <case.json> | agent-eval test inspect <sessionId> | agent-eval test cancel <sessionId> [operationId] | agent-eval test trace <sessionId>");
  process.exitCode = 2;
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { "content-type": "application/json", "x-agent-eval-client": "cli", ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}

if (args[0] !== "test" || !args[1]) { usage(); } else {
  try {
    const command = args[1];
    if (command === "run") {
      const file = args[2];
      if (!file) { usage(); throw new Error("缺少 case.json"); }
      const payload = JSON.parse(await readFile(file, "utf8"));
      const created = await request("/api/test-cases", { method: "POST", body: JSON.stringify(payload) });
      const result = await request(`/api/test-cases/${created.testCase.id}/runs`, { method: "POST", body: JSON.stringify({}) });
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "inspect") {
      const sessionId = args[2];
      if (!sessionId) { usage(); throw new Error("缺少 sessionId"); }
      const result = await request(`/api/sessions/${encodeURIComponent(sessionId)}/inspect`, { method: "POST", body: JSON.stringify({ screenshot: true }) });
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "cancel") {
      const sessionId = args[2];
      if (!sessionId) { usage(); throw new Error("缺少 sessionId"); }
      const result = await request(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: "POST", body: JSON.stringify({ operationId: args[3] || undefined }) });
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "trace") {
      const sessionId = args[2];
      if (!sessionId) { usage(); throw new Error("缺少 sessionId"); }
      const result = await request(`/api/sessions/${encodeURIComponent(sessionId)}/trace`, { method: "GET" });
      console.log(JSON.stringify(result, null, 2));
    } else {
      usage();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
