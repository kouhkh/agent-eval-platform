import http from "node:http";
import https from "node:https";
import { BrowserRunnerError } from "./operation-budget.mjs";

const TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 8 * 1024;

function probeError(code, message, statusCode = 422) {
  return new BrowserRunnerError(code, message, { statusCode, phase: "check-group-probe" });
}

export function parseGroupTarget(value) {
  if (typeof value !== "string" || !value) throw probeError("CHECK_GROUP_TARGET_MISSING", "该分组还没有目标地址。");
  let target;
  try { target = new URL(value); }
  catch { throw probeError("CHECK_GROUP_TARGET_INVALID", "分组目标地址无效。"); }
  if (!/^https?:$/.test(target.protocol) || target.username || target.password || target.search || target.hash) {
    throw probeError("CHECK_GROUP_TARGET_INVALID", "分组目标地址必须是无凭据、无查询参数的 http(s) 基础地址。");
  }
  return target;
}

export function isLoopbackTarget(target) {
  return target.hostname.toLowerCase() === "localhost" || target.hostname === "127.0.0.1";
}

export async function probeGroupTarget(value) {
  const target = parseGroupTarget(value);
  if (!isLoopbackTarget(target)) {
    throw probeError("CHECK_GROUP_TARGET_PROBE_FORBIDDEN", "为避免控制台被用作网络探针，只允许探测 localhost 或 127.0.0.1；该地址已保存但不会被探测。", 403);
  }
  const client = target.protocol === "https:" ? https : http;
  const startedAt = new Date().toISOString();
  const started = Date.now();
  return new Promise((resolve) => {
    const request = client.request(target, {
      method: "GET",
      headers: { accept: "*/*", "user-agent": "agent-eval-group-health/1" },
      timeout: TIMEOUT_MS,
    }, (response) => {
      let received = 0;
      response.on("data", (chunk) => {
        received += chunk.length;
        if (received >= MAX_RESPONSE_BYTES) response.destroy();
      });
      response.on("error", () => {});
      const finishOnline = () => {
        if (settled) return;
        settled = true;
        resolve({ status: "online", checkedAt: startedAt, elapsedMs: Date.now() - started, httpStatus: response.statusCode || null });
      };
      response.on("end", finishOnline);
      response.on("close", finishOnline);
      response.resume();
    });
    let settled = false;
    const finishOffline = (error) => {
      if (settled) return;
      settled = true;
      resolve({ status: "offline", checkedAt: startedAt, elapsedMs: Date.now() - started, errorCode: error?.code || "NETWORK_ERROR" });
    };
    request.once("error", finishOffline);
    request.once("timeout", () => { request.destroy(new Error("timeout")); });
    request.end();
  });
}
