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

export function normalizedTargetUrl(target) {
  return target.href.replace(/\/$/, "");
}

export function parseAllowedGroupProbeTargets(value) {
  if (typeof value !== "string") return new Set();
  const allowed = new Set();
  for (const candidate of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    try { allowed.add(normalizedTargetUrl(parseGroupTarget(candidate))); }
    catch { /* Invalid administrator configuration never broadens the probe allowlist. */ }
  }
  return allowed;
}

export function isLoopbackTarget(target) {
  return target.hostname.toLowerCase() === "localhost" || target.hostname === "127.0.0.1";
}

export function isProbeAllowed(target, configuredTargets) {
  return isLoopbackTarget(target) || parseAllowedGroupProbeTargets(configuredTargets).has(normalizedTargetUrl(target));
}

export async function probeGroupTarget(value, options = {}) {
  const target = parseGroupTarget(value);
  if (!isProbeAllowed(target, options.allowedTargets)) {
    throw probeError("CHECK_GROUP_TARGET_PROBE_FORBIDDEN", "非本机目标需要管理员在 AGENT_EVAL_ALLOWED_GROUP_PROBE_TARGETS 中精确配置后才能探测；该地址已保存但不会被探测。", 403);
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
      const finishResponse = () => {
        if (settled) return;
        settled = true;
        const httpStatus = response.statusCode || null;
        resolve({ status: httpStatus && httpStatus < 400 ? "online" : "error", checkedAt: startedAt, elapsedMs: Date.now() - started, httpStatus, errorCode: httpStatus && httpStatus >= 400 ? `HTTP_${httpStatus}` : null });
      };
      response.on("end", finishResponse);
      response.on("close", finishResponse);
      response.resume();
    });
    let settled = false;
    const finishOffline = (error) => {
      if (settled) return;
      settled = true;
      const code = error?.code || "NETWORK_ERROR";
      resolve({ status: code === "ECONNREFUSED" ? "offline" : "error", checkedAt: startedAt, elapsedMs: Date.now() - started, errorCode: code });
    };
    request.once("error", finishOffline);
    request.once("timeout", () => { request.destroy(new Error("timeout")); });
    request.end();
  });
}
