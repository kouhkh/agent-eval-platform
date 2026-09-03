import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentServiceError,
  buildHitlUiChangePrompt,
  buildJsonRepairPrompt,
  buildProposalPrompt,
  buildScriptPrompt,
  classifyHitlUiTask,
  extractStructuredOutputDetails,
  fingerprintHitlUiAnnotation,
  normalizeTrace,
  normalizeHitlUiAnnotation,
  normalizeStructuredOutput,
  resolveAllowedWorkspace,
  sanitizePayload,
  validateStructuredOutput,
} from "./lib/agent-service.mjs";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function parseInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function emptyUsage() {
  return { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: 0 };
}

function mergeMetrics(...values) {
  const usage = emptyUsage();
  let modelSteps = 0;
  let toolCalls = 0;
  let modelRuns = 0;
  let model = null;
  for (const value of values.filter(Boolean)) {
    const source = value.usage || {};
    usage.inputTokens += Number(source.inputTokens || 0);
    usage.cacheReadTokens += Number(source.cacheReadTokens || 0);
    usage.outputTokens += Number(source.outputTokens || 0);
    usage.reasoningTokens += Number(source.reasoningTokens || 0);
    modelSteps += Number(value.modelSteps || 0);
    toolCalls += Number(value.toolCalls || 0);
    modelRuns += Number(value.modelRuns || 1);
    if (value.model) model = value.model;
  }
  return { usage, modelSteps, toolCalls, modelRuns, model };
}

function isPeakPrice(at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(at);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value || 0);
  const time = hour * 60 + minute;
  return !["Sat", "Sun"].includes(weekday) && ((time >= 540 && time < 720) || (time >= 840 && time < 1080));
}

function estimateCost(metrics, at = new Date()) {
  if (!metrics?.model?.id) return null;
  const pro = String(metrics.model.id).includes("pro");
  const peak = isPeakPrice(at);
  const prices = pro
    ? { cacheRead: peak ? 0.30 : 0.15, input: peak ? 9.0 : 4.5, output: peak ? 27.0 : 13.5 }
    : { cacheRead: peak ? 0.10 : 0.05, input: peak ? 3.0 : 1.5, output: peak ? 9.0 : 4.5 };
  const usage = metrics.usage || emptyUsage();
  const cny = (Number(usage.cacheReadTokens || 0) * prices.cacheRead
    + Number(usage.inputTokens || 0) * prices.input
    + (Number(usage.outputTokens || 0) + Number(usage.reasoningTokens || 0)) * prices.output) / 1_000_000;
  return {
    currency: "CNY",
    amount: Number(cny.toFixed(6)),
    priceBand: peak ? "peak" : "off-peak",
    priceVersion: "2026-09-01",
    estimated: true,
  };
}

function defaultConfig(overrides = {}) {
  const dshRoot = path.resolve(overrides.dshRoot || process.env.DSH_ROOT || "");
  const dshEnv = path.join(dshRoot, ".env");
  if (!process.env.DEEPSEEK_API_KEY && existsSync(dshEnv)) process.loadEnvFile(dshEnv);
  const workspaceText = overrides.workspaceRoots ? null : process.env.DSH_AGENT_WORKSPACE_ROOTS || "";
  return {
    host: overrides.host || process.env.DSH_AGENT_HOST || "127.0.0.1",
    port: overrides.port || parseInteger(process.env.PORT, 4319, 1, 65535),
    dshRoot,
    workspaceRoots: overrides.workspaceRoots || workspaceText.split(path.delimiter).filter(Boolean).map((entry) => path.resolve(entry)),
    timeoutMs: overrides.timeoutMs || parseInteger(process.env.DSH_AGENT_TIMEOUT_MS, 900000, 1000, 3600000),
    maxOutputBytes: overrides.maxOutputBytes || 4 * 1024 * 1024,
    fake: overrides.fake === true || process.env.DSH_AGENT_FAKE === "1",
    maxConcurrent: overrides.maxConcurrent || parseInteger(process.env.DSH_AGENT_MAX_CONCURRENT, 3, 1, 6),
    sessionRoot: path.resolve(overrides.sessionRoot || process.env.DSH_AGENT_SESSION_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "sessions")),
    sessionPoolSize: overrides.sessionPoolSize || parseInteger(process.env.DSH_AGENT_SESSION_POOL_SIZE, overrides.maxConcurrent || parseInteger(process.env.DSH_AGENT_MAX_CONCURRENT, 3, 1, 6), 1, 6),
    isolateWrites: overrides.isolateWrites ?? (overrides.runner === undefined && overrides.fake !== true && process.env.DSH_AGENT_FAKE !== "1" && process.env.DSH_AGENT_ISOLATE_WRITES !== "0"),
    prepareDependencies: overrides.prepareDependencies ?? (overrides.runner === undefined && overrides.fake !== true && process.env.DSH_AGENT_FAKE !== "1"),
    jobStatePath: overrides.jobStatePath || process.env.DSH_AGENT_JOB_STATE_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "jobs.json"),
  };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env || process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = appendLimited(stdout, chunk, 4 * 1024 * 1024); });
    child.stderr.on("data", (chunk) => { stderr = appendLimited(stderr, chunk, 4 * 1024 * 1024); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new AgentServiceError(`${command} ${args.join(" ")} 失败：${stderr.slice(-1200) || `退出码 ${code}`}`, 502)));
  });
}

async function gitCommit(workspace, message) {
  const status = await runCommand("git", ["status", "--porcelain"], { cwd: workspace });
  if (!status.stdout.trim()) return null;
  await runCommand("git", ["add", "-A"], { cwd: workspace });
  await runCommand("git", ["-c", "user.name=DSH Automation", "-c", "user.email=dsh@local", "commit", "-m", message], { cwd: workspace });
  return (await runCommand("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim();
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new AgentServiceError("请求体超过 2 MiB 限制。", 413));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new AgentServiceError("请求体不是有效 JSON。", 400));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function appendLimited(current, chunk, maximum) {
  const combined = current + chunk.toString("utf8");
  return Buffer.byteLength(combined) <= maximum ? combined : combined.slice(-maximum);
}

function progressTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function progressText(value, maximum = 2400) {
  let source = value;
  if (typeof value === "string" && /^[\s]*[\[{]/.test(value)) {
    try { source = JSON.parse(value); } catch { /* retain non-JSON tool text */ }
  }
  const sanitized = sanitizePayload(source).value;
  const text = typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized);
  return text.length <= maximum ? text : `${text.slice(0, maximum)}…`;
}

/** Convert canonical DSH Session events into a bounded, redacted UI projection. */
export function sessionEventProgress(event) {
  if (!event || typeof event !== "object") return null;
  const base = { at: progressTime(event.time), sourceSeq: event.seq, sourceType: event.type };
  if (event.type === "turn/start") return { ...base, kind: "phase", text: `开始处理（第 ${event.data?.turn || 1} 轮）` };
  if (event.type === "step/start") return { ...base, kind: "phase", text: `正在执行第 ${event.data?.step || 1} 步` };
  if (event.type === "assistant/chunk") {
    const chunk = event.data?.chunk;
    if (chunk?.type === "reasoning-delta" && chunk.text) return { ...base, kind: "reasoning_delta", text: progressText(chunk.text, 1200) };
    if (chunk?.type === "text-delta" && chunk.text) return { ...base, kind: "assistant_delta", text: progressText(chunk.text, 1200) };
    return null;
  }
  if (event.type === "tool/call") {
    return { ...base, kind: "tool_call", tool: String(event.data?.name || "tool"), text: progressText(event.data?.arguments || "", 1800) };
  }
  if (event.type === "tool/result") {
    return {
      ...base,
      kind: event.data?.error ? "tool_error" : "tool_result",
      tool: String(event.data?.message?.source?.callId || "tool"),
      text: progressText(event.data?.message?.content || event.data?.error || "", 2000),
    };
  }
  if (event.type === "assistant/message") {
    const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
    const text = blocks.filter((block) => block?.type === "text").map((block) => block.text).join("");
    return text ? { ...base, kind: "assistant", text: progressText(text) } : null;
  }
  if (event.type === "turn/end") return { ...base, kind: "phase", text: event.data?.reason?.kind === "completed" ? "本轮完成" : `本轮结束：${event.data?.reason?.kind || "unknown"}` };
  return null;
}

async function collectUiCodeCandidates(workspace, annotation) {
  const terms = [...new Set((annotation.ui_elements || []).flatMap((element) => [
    element.id,
    element.selector?.match(/\[data-(?:ui-key|testid)="([^"]+)"\]/)?.[1],
    element.semantic?.stableKey,
    element.semantic?.label,
    element.name,
  ]).filter((value) => typeof value === "string" && value.trim().length >= 3).map((value) => value.trim()))].slice(0, 6);
  const candidates = [];
  for (const term of terms) {
    const output = await new Promise((resolve) => {
      const child = spawn("rg", ["-n", "-F", "-m", "4", "--glob", "!node_modules/**", "--glob", "!.next/**", "--glob", "!*.lock", term, "."], { cwd: workspace, stdio: ["ignore", "pipe", "ignore"] });
      let text = "";
      child.stdout.on("data", (chunk) => { text = appendLimited(text, chunk, 6000); });
      child.on("close", () => resolve(text));
      child.on("error", () => resolve(""));
    });
    for (const line of String(output).split("\n").filter(Boolean)) candidates.push({ term, match: line.slice(0, 700) });
    if (candidates.length >= 12) break;
  }
  return candidates.slice(0, 12);
}

export function createDshRunner(config) {
  const entry = path.join(config.dshRoot, "apps", "cli", "lib", "bin.js");
  async function runOnce(workspace, prompt, permissionMode, timeoutMs, onProgress, reasoningEffort) {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entry, "--profile", "headless", prompt], {
        cwd: workspace,
        env: { ...process.env, DSH_PERMISSION_MODE: permissionMode, DSH_STREAM_JSON: "1", DSH_REASONING_EFFORT: reasoningEffort || "" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let resultText = "";
      let resultMetrics = null;
      let pendingStdout = "";
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() => reject(new AgentServiceError(`DSH 任务超过 ${Math.round(config.timeoutMs / 1000)} 秒。`, 504)));
      }, timeoutMs);
      const consumeStdoutLine = (line) => {
        if (!line.trim()) return;
        try {
          const row = JSON.parse(line);
          if (row?.type === "session_event" && row.event && typeof row.event === "object") {
            const progress = sessionEventProgress(row.event);
            if (progress) onProgress?.({ stream: "dsh-event", event: progress });
            return;
          }
          if (row?.type === "event" && row.event && typeof row.event === "object") {
            onProgress?.({ stream: "dsh-event", event: sanitizePayload(row.event).value });
            return;
          }
          if (row?.type === "result") {
            resultText = typeof row.output === "string" ? row.output : typeof row.text === "string" ? row.text : "";
            const metrics = row.metrics && typeof row.metrics === "object" ? row.metrics : {};
            const model = metrics.model && typeof metrics.model === "object"
              ? { ...metrics.model, id: metrics.model.id || metrics.model.model }
              : null;
            resultMetrics = { ...metrics, ...(row.usage && typeof row.usage === "object" ? { usage: row.usage } : {}), ...(model ? { model } : {}) };
            onProgress?.({ stream: "system", text: "DSH 已完成本次 Agent 执行。" });
            return;
          }
        } catch { /* older DSH builds retain their plain-text fallback */ }
        stdout = appendLimited(stdout, `${line}\n`, config.maxOutputBytes);
        onProgress?.({ stream: "stdout", text: `${line}\n` });
      };
      child.stdout.on("data", (chunk) => {
        pendingStdout += chunk.toString("utf8");
        const lines = pendingStdout.split(/\r?\n/);
        pendingStdout = lines.pop() || "";
        for (const line of lines) consumeStdoutLine(line);
      });
      child.stderr.on("data", (chunk) => { stderr = appendLimited(stderr, chunk, config.maxOutputBytes); onProgress?.({ stream: "stderr", text: chunk.toString("utf8") }); });
      child.on("error", (error) => finish(() => reject(new AgentServiceError(`无法启动 DSH：${error.message}`, 502))));
      child.on("close", (code) => finish(() => {
        if (pendingStdout) consumeStdoutLine(pendingStdout);
        if (code !== 0) {
          reject(new AgentServiceError(`DSH 退出码 ${code}：${stderr.slice(-2000)}`, 502));
          return;
        }
        resolve({ text: (resultText || stdout).trim(), metrics: resultMetrics });
      }));
    });
  }

  return async ({ kind, workspace, prompt, permissionMode, reasoningEffort, timeoutMs, onProgress }) => {
    if (!existsSync(entry)) throw new AgentServiceError(`DSH 尚未构建，缺少 ${entry}`, 503);
    const startedAt = Date.now();
    let attempts = 1;
    onProgress?.({ stream: "system", text: "已启动 DSH。" });
    const effectiveTimeoutMs = Math.min(config.timeoutMs, Number(timeoutMs || config.timeoutMs));
    const firstRun = await runOnce(workspace, prompt, permissionMode, effectiveTimeoutMs, onProgress, reasoningEffort);
    let rawOutput = firstRun.text;
    let metrics = mergeMetrics(firstRun.metrics);
    let parsed = extractStructuredOutputDetails(rawOutput);
    let normalized = normalizeStructuredOutput(kind, parsed.value);
    let validation = validateStructuredOutput(kind, normalized.value);
    let repairs = [...parsed.repairs, ...normalized.repairs];
    if (!validation.valid) {
      const remainingMs = effectiveTimeoutMs - (Date.now() - startedAt);
      if (remainingMs < 1000) throw new AgentServiceError(`DSH 输出不是完整的 ${kind} JSON，且没有剩余重试时间。`, 502);
      attempts = 2;
      onProgress?.({ stream: "system", text: "正在修复结构化输出格式。" });
      const repairRun = await runOnce(
        workspace,
        buildJsonRepairPrompt(kind, rawOutput, validation.violations),
        "read-only",
        remainingMs, onProgress,
        "off",
      );
      rawOutput = repairRun.text;
      metrics = mergeMetrics(metrics, repairRun.metrics);
      parsed = extractStructuredOutputDetails(rawOutput);
      normalized = normalizeStructuredOutput(kind, parsed.value);
      validation = validateStructuredOutput(kind, normalized.value);
      repairs = ["model-json-repair", ...parsed.repairs, ...normalized.repairs];
    }
    if (!validation.valid) {
      throw new AgentServiceError(`DSH 两次输出均不是完整的 ${kind} JSON：${validation.violations.join("; ")}`, 502);
    }
    return {
      rawOutput,
      structuredOutput: normalized.value,
      structuredOutputRepairs: repairs,
      attempts,
      metrics: { ...metrics, modelRuns: attempts },
      elapsedMs: Date.now() - startedAt,
    };
  };
}

function createFakeRunner() {
  return async ({ prompt, permissionMode }) => ({
    rawOutput: JSON.stringify({ fake: true, permissionMode, promptDigest: prompt.slice(0, 80) }),
    structuredOutput: { fake: true, permissionMode },
    elapsedMs: 1,
  });
}

function decision(job, phase, text, details = null) {
  const item = { at: new Date().toISOString(), phase, text };
  if (details && typeof details === "object") item.details = details;
  job.decisionTrace = [...(Array.isArray(job.decisionTrace) ? job.decisionTrace : []), item].slice(-80);
}

function deriveVerificationLevel(result) {
  const verification = result?.structuredOutput?.verification;
  const text = JSON.stringify(Array.isArray(verification) ? verification : []).toLowerCase();
  if (/(playwright|浏览器|browser|e2e|curl|http|运行时|runtime)/.test(text)) return { key: "runtime", label: "运行链路验证", evidence: verification };
  if (/(test|测试|spec|回归)/.test(text)) return { key: "tests", label: "相关自动测试", evidence: verification };
  if (/(tsc|typescript|lint|类型|静态|syntax|语法)/.test(text)) return { key: "static", label: "静态检查", evidence: verification };
  return { key: "unrecorded", label: "未记录机器验证", evidence: verification || [] };
}

function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    workspace: job.workspace,
    permissionMode: job.permissionMode,
    redactions: job.redactions,
    result: job.result,
    error: job.error,
    sourceAnnotationId: job.sourceAnnotationId || null,
    question: job.question || job.request?.annotation?.question || null,
    requestHash: job.requestHash || null,
    routing: job.routing || null,
    decisionTrace: job.decisionTrace || [],
    verificationLevel: job.verificationLevel || null,
    runNumber: job.runNumber || 1,
    priorRuns: job.priorRuns || [],
    dedupeHits: job.dedupeHits || 0,
    taskCommit: job.taskCommit || null,
    taskRef: job.taskRef || null,
    integrationStatus: job.integrationStatus || null,
    integrationMethod: job.integrationMethod || null,
    hostVerification: job.hostVerification || null,
    metrics: job.metrics || null,
    costEstimate: job.costEstimate || null,
    timing: job.timing || null,
    workspaceReuse: job.workspaceReuse || null,
    live: job.status === "running" ? { input: job.liveInput || job.runnerInput?.prompt || "", events: job.liveEvents || [] } : null,
  };
}

async function preparePooledWorkspace(config, job, slot) {
  const startedAt = Date.now();
  const poolRoot = path.join(config.sessionRoot, "pool");
  mkdirSync(poolRoot, { recursive: true });
  const directory = slot.directory;
  const head = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: job.workspace })).stdout.trim();
  const worktreeReused = existsSync(path.join(directory, ".git"));
  if (!worktreeReused) {
    rmSync(directory, { recursive: true, force: true });
    await runCommand("git", ["worktree", "prune"], { cwd: job.workspace });
    await runCommand("git", ["worktree", "add", "--detach", directory, head], { cwd: job.workspace });
  }
  try {
    await runCommand("git", ["reset", "--hard", head], { cwd: directory });
    await runCommand("git", ["clean", "-fdx", "-e", "node_modules"], { cwd: directory });
    await runCommand("rsync", ["-a", "--checksum", "--delete", "--exclude=.git", "--exclude=node_modules", "--exclude=.next", "--exclude=.dsh-sessions", `${job.workspace}/`, `${directory}/`]);
    let dependenciesReused = false;
    if (config.prepareDependencies && existsSync(path.join(directory, "package-lock.json"))) {
      const lockHash = createHash("sha256").update(readFileSync(path.join(directory, "package-lock.json"))).digest("hex");
      const markerPath = path.join(poolRoot, `${slot.id}.lock-hash`);
      const previousHash = existsSync(markerPath) ? readFileSync(markerPath, "utf8").trim() : "";
      dependenciesReused = previousHash === lockHash && existsSync(path.join(directory, "node_modules"));
      if (!dependenciesReused) {
        await runCommand("npm", ["ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"], { cwd: directory });
        writeFileSync(markerPath, `${lockHash}\n`, { mode: 0o600 });
      }
    }
    const baselineCommit = await gitCommit(directory, `dsh snapshot ${job.id}`) || head;
    return { directory, baselineCommit, slotId: slot.id, worktreeReused, dependenciesReused, prepareMs: Date.now() - startedAt };
  } catch (error) {
    throw error;
  }
}

async function preserveTaskCommit(job) {
  if (!job.taskCommit) return null;
  const ref = `refs/dsh/jobs/${job.id}/run-${job.runNumber || 1}`;
  await runCommand("git", ["update-ref", ref, job.taskCommit], { cwd: job.workspace });
  job.taskRef = ref;
  return ref;
}

async function runHostVerification(job, session) {
  if (!job.taskCommit) return { status: "skipped", elapsedMs: 0, checks: [] };
  const startedAt = Date.now();
  const checks = [];
  const run = async (label, command, args, cwd = session.directory) => {
    const checkStartedAt = Date.now();
    try {
      const result = await runCommand(command, args, { cwd });
      checks.push({ label, status: "passed", elapsedMs: Date.now() - checkStartedAt, output: `${result.stdout}\n${result.stderr}`.trim().slice(-1200) });
    } catch (error) {
      checks.push({ label, status: "failed", elapsedMs: Date.now() - checkStartedAt, output: error instanceof Error ? error.message.slice(-1600) : "未知错误" });
      throw error;
    }
  };
  try {
    await run("补丁格式检查", "git", ["diff", "--check", `${job.taskBaseCommit || session.baselineCommit}..${job.taskCommit}`]);
    if (existsSync(path.join(session.directory, "package.json"))) await run("TypeScript", "npm", ["run", "lint"]);
    if (job.routing?.key === "complex-ui") await run("评测目录回归", "npm", ["run", "test:evaluation-regression"]);
    return { status: "passed", elapsedMs: Date.now() - startedAt, checks };
  } catch {
    return { status: "failed", elapsedMs: Date.now() - startedAt, checks };
  }
}

async function applyTaskPatch(workspace, sessionWorkspace, baseCommit, taskCommit) {
  const patch = await runCommand("git", ["diff", "--binary", `${baseCommit}..${taskCommit}`], { cwd: sessionWorkspace });
  if (!patch.stdout.trim()) return { applied: true, changed: false, patch: "" };
  const patchPath = path.join(sessionWorkspace, ".dsh-integration.patch");
  writeFileSync(patchPath, patch.stdout, { mode: 0o600 });
  try {
    await runCommand("git", ["apply", "--whitespace=nowarn", patchPath], { cwd: workspace });
    return { applied: true, changed: true, patch: patch.stdout };
  } catch (error) {
    return { applied: false, changed: true, error, patchPath, patch: patch.stdout };
  }
}

export function createAgentService(options = {}) {
  const config = defaultConfig(options);
  const runner = options.runner || (config.fake ? createFakeRunner() : createDshRunner(config));
  const jobs = new Map();
  const queue = [];
  let activeCount = 0;
  let integrationTail = Promise.resolve();
  const sessionSlots = Array.from({ length: config.sessionPoolSize }, (_, index) => ({
    id: `slot-${index + 1}`,
    directory: path.join(config.sessionRoot, "pool", `slot-${index + 1}`),
    busy: false,
  }));
  const slotWaiters = [];

  function acquireSessionSlot() {
    const available = sessionSlots.find((slot) => !slot.busy);
    if (available) {
      available.busy = true;
      return Promise.resolve(available);
    }
    return new Promise((resolve) => slotWaiters.push(resolve));
  }

  function releaseSessionSlot(slot) {
    const waiter = slotWaiters.shift();
    if (waiter) waiter(slot);
    else slot.busy = false;
  }

  function persistJobs() {
    const saved = [...jobs.values()];
    const directory = path.dirname(config.jobStatePath);
    mkdirSync(directory, { recursive: true });
    const temporary = `${config.jobStatePath}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 2, jobs: saved }, null, 2), { mode: 0o600 });
    renameSync(temporary, config.jobStatePath);
  }

  try {
    if (existsSync(config.jobStatePath)) {
      const saved = JSON.parse(readFileSync(config.jobStatePath, "utf8"));
      for (const job of Array.isArray(saved.jobs) ? saved.jobs : []) {
        if (!job?.id) continue;
        if (["pending", "running"].includes(job.integrationStatus) && ["failed", "succeeded"].includes(job.status)) job.integrationStatus = "failed";
        if (job.status === "running" && job.runnerInput) {
          job.status = "queued";
          job.startedAt = null;
          job.error = "服务重启后自动恢复执行。";
          decision(job, "recovery", "服务重启后保留原任务并重新入队");
        }
        jobs.set(job.id, job);
        if (job.status === "queued" && job.runnerInput) queue.push(job);
      }
      persistJobs();
    }
  } catch (error) {
    console.warn(`无法恢复 DSH 任务状态：${error instanceof Error ? error.message : "未知错误"}`);
  }

  function runnerInputFor(job, effectiveWorkspace = job.workspace) {
    if (job.kind === "hitl-ui-change" && job.request?.annotation) {
      return {
        kind: job.kind,
        workspace: effectiveWorkspace,
        permissionMode: job.permissionMode,
        reasoningEffort: job.routing?.reasoningEffort,
        timeoutMs: job.routing?.timeoutMs,
        prompt: buildHitlUiChangePrompt(effectiveWorkspace, job.request.annotation, job.routing),
      };
    }
    return { ...job.runnerInput, workspace: effectiveWorkspace };
  }

  function queueExistingJob(job, traceText) {
    if (!job.runnerInput) job.runnerInput = runnerInputFor(job, job.workspace);
    job.status = "queued";
    job.startedAt = null;
    job.completedAt = null;
    job.result = null;
    job.error = null;
    job.taskCommit = null;
    job.taskRef = null;
    job.taskBaseCommit = null;
    job.integrationStatus = null;
    job.integrationMethod = null;
    job.verificationLevel = null;
    job.hostVerification = null;
    job.metrics = null;
    job.costEstimate = null;
    job.timing = null;
    job.workspaceReuse = null;
    decision(job, "lifecycle", traceText);
    if (!queue.includes(job)) queue.push(job);
    persistJobs();
    queueMicrotask(drain);
  }

  async function execute(job) {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.error = null;
    job.liveEvents = [{ at: new Date().toISOString(), kind: "phase", text: "任务已从队列取出，正在启动 DSH。" }];
    decision(job, "lifecycle", `第 ${job.runNumber || 1} 次执行开始`);
    persistJobs();
    let session = null;
    let slot = null;
    let runInput = null;
    const executionStartedAt = Date.now();
    job.timing = {
      queueMs: Math.max(0, executionStartedAt - new Date(job.createdAt).getTime()),
      setupMs: 0,
      agentMs: 0,
      integrationMs: 0,
      verificationMs: 0,
      totalMs: 0,
    };
    try {
      const reportProgress = (event) => {
        const item = event.stream === "dsh-event" && event.event
          ? event.event
          : { at: new Date().toISOString(), kind: event.stream === "stderr" ? "stderr" : "phase", text: String(event.text || "") };
        const current = Array.isArray(job.liveEvents) ? job.liveEvents : [];
        job.liveEvents = [...current, item].slice(-300);
        persistJobs();
      };
      if (config.isolateWrites && job.permissionMode === "workspace-write") {
        job.liveEvents.push({ at: new Date().toISOString(), kind: "phase", text: "正在取得并行工作槽并准备隔离工作区。" });
        persistJobs();
        slot = await acquireSessionSlot();
        session = await preparePooledWorkspace(config, job, slot);
        job.sessionWorkspace = session.directory;
        job.workspaceReuse = {
          slotId: session.slotId,
          worktreeReused: session.worktreeReused,
          dependenciesReused: session.dependenciesReused,
        };
        job.timing.setupMs = session.prepareMs;
        job.liveEvents.push({ at: new Date().toISOString(), kind: "phase", text: session.worktreeReused ? "已复用隔离工作槽；可与其他任务并行修改。" : "已初始化隔离工作槽；可与其他任务并行修改。" });
        decision(job, "workspace", session.worktreeReused ? "已复用并行 Git 工作槽" : "已初始化并行 Git 工作槽", { isolation: "pooled-git-worktree", ...job.workspaceReuse, prepareMs: session.prepareMs });
        persistJobs();
      }
      runInput = runnerInputFor(job, session?.directory || job.workspace);
      job.liveInput = runInput.prompt;
      const agentStartedAt = Date.now();
      job.result = await runner({ ...runInput, onProgress: reportProgress });
      job.timing.agentMs = Date.now() - agentStartedAt;
      if (session) {
        job.taskCommit = await gitCommit(session.directory, `dsh change ${job.id}`);
        if (job.taskCommit) {
          job.taskBaseCommit = session.baselineCommit;
          await preserveTaskCommit(job);
          job.integrationStatus = "pending";
          job.liveEvents.push({ at: new Date().toISOString(), kind: "phase", text: "修改已提交，正在执行宿主确定性验证。" });
          decision(job, "commit", "Agent 改动已形成独立 Git 提交并保留任务引用", { commit: job.taskCommit, ref: job.taskRef });
          persistJobs();
          const verificationStartedAt = Date.now();
          job.hostVerification = await runHostVerification(job, session);
          job.timing.verificationMs += Date.now() - verificationStartedAt;
          decision(job, "verification", job.hostVerification.status === "passed" ? "宿主确定性验证通过" : "宿主确定性验证失败", { checks: job.hostVerification.checks.map((check) => ({ label: check.label, status: check.status, elapsedMs: check.elapsedMs })) });
          if (job.hostVerification.status !== "passed") throw new AgentServiceError("宿主确定性验证失败，改动没有自动合入；独立提交仍已保留。", 422);
          const integrationStartedAt = Date.now();
          const integrate = async () => {
            job.integrationStatus = "running";
            job.liveEvents.push({ at: new Date().toISOString(), kind: "phase", text: "正在检查当前工作区并自动整合。" });
            decision(job, "integration", "目标工作区可能已有并行改动，开始自动整合");
            persistJobs();
            let applied = await applyTaskPatch(job.workspace, session.directory, session.baselineCommit, job.taskCommit);
            let integrationMethod = "git-apply";
            if (!applied.applied) {
              integrationMethod = "semantic-merge";
              job.liveEvents.push({ at: new Date().toISOString(), kind: "phase", text: "检测到并发改动冲突，正在由 DSH 自动整合。" });
              decision(job, "integration", "直接应用发生冲突，转入 DSH 语义整合路径", { error: applied.error instanceof Error ? applied.error.message.slice(-1200) : null });
              await runCommand("rsync", ["-a", "--checksum", "--delete", "--exclude=.git", "--exclude=node_modules", "--exclude=.next", "--exclude=.dsh-sessions", `${job.workspace}/`, `${session.directory}/`]);
              const integrationBase = await gitCommit(session.directory, `dsh integration base ${job.id}`) || job.taskCommit;
              job.taskBaseCommit = integrationBase;
              writeFileSync(path.join(session.directory, ".dsh-integration.patch"), applied.patch, { mode: 0o600 });
              await runCommand("git", ["apply", "--reject", "--whitespace=nowarn", ".dsh-integration.patch"], { cwd: session.directory }).catch(() => {});
              const integrationPrompt = `${runInput.prompt}\n\n你正在处理并发整合：当前目录已是最新工作区快照；.dsh-integration.patch 和可能的 *.rej 是本任务先前的改动。请在当前代码基础上完成原始需求，解决所有冲突并删除 *.rej / .dsh-integration.patch。不要撤销其他任务已经合入的改动。最后仍按原格式输出 JSON。`;
              const integrationResult = await runner({ ...runInput, workspace: session.directory, prompt: integrationPrompt, onProgress: reportProgress });
              job.result.integration = integrationResult;
              const integratedCommit = await gitCommit(session.directory, `dsh integration ${job.id}`);
              if (!integratedCommit) throw new AgentServiceError("DSH 自动整合没有产生可提交的改动。", 409);
              job.taskCommit = integratedCommit;
              await preserveTaskCommit(job);
              const integrationVerificationStartedAt = Date.now();
              job.hostVerification = await runHostVerification(job, session);
              job.timing.verificationMs += Date.now() - integrationVerificationStartedAt;
              decision(job, "verification", job.hostVerification.status === "passed" ? "语义整合后的宿主验证通过" : "语义整合后的宿主验证失败", { checks: job.hostVerification.checks.map((check) => ({ label: check.label, status: check.status, elapsedMs: check.elapsedMs })) });
              if (job.hostVerification.status !== "passed") throw new AgentServiceError("语义整合后的宿主确定性验证失败，独立提交仍已保留。", 422);
              applied = await applyTaskPatch(job.workspace, session.directory, integrationBase, integratedCommit);
              if (!applied.applied) {
                const detail = applied.error instanceof Error ? ` ${applied.error.message.slice(-1200)}` : "";
                throw new AgentServiceError(`DSH 自动整合后仍无法应用，请检查保留的独立提交。${detail}`, 409);
              }
            }
            job.integrationMethod = integrationMethod;
            job.integrationStatus = applied.changed ? "integrated" : "no_changes";
            decision(job, "integration", applied.changed ? "改动已自动合入当前工作区" : "没有需要合入的代码改动", { method: integrationMethod });
          };
          const current = integrationTail.then(integrate);
          integrationTail = current.catch(() => {});
          await current;
          job.timing.integrationMs = Date.now() - integrationStartedAt;
        } else {
          job.integrationStatus = "no_changes";
          decision(job, "commit", "Agent 没有产生代码差异");
        }
      }
      job.metrics = mergeMetrics(job.result?.metrics, job.result?.integration?.metrics);
      job.costEstimate = estimateCost(job.metrics);
      job.verificationLevel = deriveVerificationLevel(job.result);
      decision(job, "verification", `验证层级：${job.verificationLevel.label}`, { key: job.verificationLevel.key });
      job.status = "succeeded";
      decision(job, "lifecycle", `第 ${job.runNumber || 1} 次执行完成`);
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : "未知 DSH 错误";
      if (["pending", "running"].includes(job.integrationStatus)) job.integrationStatus = "failed";
      decision(job, "lifecycle", `第 ${job.runNumber || 1} 次执行失败`, { error: job.error });
    } finally {
      job.completedAt = new Date().toISOString();
      if (!job.metrics && job.result) job.metrics = mergeMetrics(job.result?.metrics, job.result?.integration?.metrics);
      if (!job.costEstimate && job.metrics) job.costEstimate = estimateCost(job.metrics, new Date(job.completedAt));
      if (job.timing) job.timing.totalMs = Date.now() - executionStartedAt;
      if (slot) releaseSessionSlot(slot);
      delete job.sessionWorkspace;
      delete job.runnerInput;
      delete job.liveInput;
      delete job.liveEvents;
      persistJobs();
      activeCount -= 1;
      queueMicrotask(drain);
    }
  }

  function drain() {
    while (activeCount < config.maxConcurrent && queue.length > 0) {
      const job = queue.shift();
      if (!job || job.status !== "queued") continue;
      activeCount += 1;
      void execute(job);
    }
  }

  function enqueue(kind, workspace, permissionMode, redactions, prompt, sourceAnnotationId = null, metadata = {}) {
    const job = {
      id: randomUUID(),
      kind,
      status: "queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      workspace,
      permissionMode,
      redactions,
      result: null,
      error: null,
      sourceAnnotationId,
      question: metadata.question || null,
      request: metadata.request || null,
      requestHash: metadata.requestHash || null,
      routing: metadata.routing || null,
      decisionTrace: [],
      runNumber: 1,
      priorRuns: [],
      dedupeHits: 0,
      runnerInput: { kind, workspace, prompt, permissionMode },
    };
    if (job.routing) decision(job, "classification", `自动分类为“${job.routing.label}”`, { key: job.routing.key, reasons: job.routing.reasons });
    if (job.routing?.matched?.candidateFiles?.length) decision(job, "matching", `预检命中 ${job.routing.matched.candidateFiles.length} 个候选代码文件`, { files: job.routing.matched.candidateFiles });
    else if (kind === "hitl-ui-change") decision(job, "matching", "预检没有命中明确代码文件，将由 Agent 根据页面语义继续定位");
    decision(job, "lifecycle", "任务已入队，等待可用并发槽位", { maxConcurrent: config.maxConcurrent });
    jobs.set(job.id, job);
    queue.push(job);
    persistJobs();
    queueMicrotask(drain);
    return job;
  }

  function archiveCurrentRun(job) {
    const snapshot = {
      runNumber: job.runNumber || 1,
      status: job.status,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error,
      taskCommit: job.taskCommit,
      taskRef: job.taskRef,
      integrationStatus: job.integrationStatus,
      integrationMethod: job.integrationMethod,
      verificationLevel: job.verificationLevel,
      hostVerification: job.hostVerification,
      metrics: job.metrics,
      costEstimate: job.costEstimate,
      timing: job.timing,
      workspaceReuse: job.workspaceReuse,
    };
    job.priorRuns = [...(Array.isArray(job.priorRuns) ? job.priorRuns : []), snapshot].slice(-10);
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/api/health") {
        const entry = path.join(config.dshRoot, "apps", "cli", "lib", "bin.js");
        sendJson(response, 200, {
          ok: true,
          service: "agent-eval-dsh-bridge",
          provider: "deepseek-harness",
          mode: config.fake ? "fake" : "dev",
          loopbackOnly: config.host === "127.0.0.1" || config.host === "::1",
          ready: config.fake || (config.workspaceRoots.length > 0 && existsSync(entry) && Boolean(process.env.DEEPSEEK_API_KEY)),
          dshBuilt: config.fake || existsSync(entry),
          credentialConfigured: config.fake || Boolean(process.env.DEEPSEEK_API_KEY),
          workspaceRootCount: config.workspaceRoots.length,
          queueDepth: queue.length,
          running: activeCount > 0,
          activeCount,
          maxConcurrent: config.maxConcurrent,
          sessionPool: {
            size: sessionSlots.length,
            busy: sessionSlots.filter((slot) => slot.busy).length,
            ready: sessionSlots.filter((slot) => existsSync(path.join(slot.directory, ".git"))).length,
          },
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/spec") {
        sendJson(response, 200, {
          endpoints: {
            "POST /api/test-proposals": "DSH 只读检查轨迹与代码，生成待确认项及自动化分层建议。",
            "POST /api/test-scripts": "DSH 按人工确认后的提案生成脚本；applyChanges=false 时只给方案，true 时允许写工作区。",
            "POST /api/hitl-ui-changes": "接收 PinAsk 界面标注，限白名单工作区内由 DSH 修改 UI 源码。",
            "GET /api/jobs?kind=hitl-ui-change": "列出当前开发服务会话中该类型的任务历史。",
            "GET /api/jobs/:id": "查询异步任务状态和最终输出。",
            "POST /api/jobs/:id/actions": "暂停排队任务、继续同一任务或重试失败任务。",
          },
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/jobs") {
        const kind = url.searchParams.get("kind");
        const limit = parseInteger(url.searchParams.get("limit"), 100, 1, 200);
        const items = [...jobs.values()]
          .filter((job) => !kind || job.kind === kind)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .slice(0, limit)
          .map(publicJob);
        sendJson(response, 200, { jobs: items });
        return;
      }
      const jobMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)$/i);
      if (request.method === "GET" && jobMatch) {
        const job = jobs.get(jobMatch[1]);
        if (!job) throw new AgentServiceError("任务不存在。", 404);
        sendJson(response, 200, { job: publicJob(job) });
        return;
      }
      const jobActionMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)\/actions$/i);
      if (request.method === "POST" && jobActionMatch) {
        const job = jobs.get(jobActionMatch[1]);
        if (!job) throw new AgentServiceError("任务不存在。", 404);
        if (job.kind !== "hitl-ui-change") throw new AgentServiceError("只有界面修改任务支持该操作。", 409);
        const body = await readJsonBody(request);
        const action = String(body.action || "");
        if (action === "pause") {
          if (job.status !== "queued") throw new AgentServiceError("只有仍在排队的任务可以暂停。", 409);
          job.status = "paused";
          decision(job, "lifecycle", "任务已在服务端暂停，保留原任务标识和排队上下文");
          persistJobs();
          sendJson(response, 200, { job: publicJob(job) });
          return;
        }
        if (action === "resume") {
          if (job.status !== "paused") throw new AgentServiceError("只有已暂停任务可以继续。", 409);
          if (!job.request?.annotation) throw new AgentServiceError("旧任务没有保留可恢复的标注输入。", 409);
          const requestedQuestion = typeof body.question === "string" ? body.question.trim() : "";
          if (requestedQuestion) {
            const normalized = normalizeHitlUiAnnotation({ ...job.request.annotation, question: requestedQuestion });
            const sanitized = sanitizePayload({ ...normalized, codeCandidates: job.request.annotation.codeCandidates || [] });
            job.request.annotation = sanitized.value;
            job.question = sanitized.value.question;
            job.redactions = [...(job.redactions || []), ...sanitized.redactions];
            job.routing = classifyHitlUiTask(sanitized.value);
            job.requestHash = fingerprintHitlUiAnnotation(sanitized.value);
            decision(job, "classification", `继续前重新分类为“${job.routing.label}”`, { key: job.routing.key, reasons: job.routing.reasons });
          }
          queueExistingJob(job, "继续原任务；没有创建新的任务记录");
          sendJson(response, 202, { job: publicJob(job), pollUrl: `/api/jobs/${job.id}` });
          return;
        }
        if (action === "retry") {
          if (job.status !== "failed") throw new AgentServiceError("只有失败任务可以重试。", 409);
          if (!job.request?.annotation) throw new AgentServiceError("旧任务没有保留可重试的标注输入，请重新提交原标注。", 409);
          archiveCurrentRun(job);
          job.runNumber = (job.runNumber || 1) + 1;
          queueExistingJob(job, `重试原任务，进入第 ${job.runNumber} 次执行`);
          sendJson(response, 202, { job: publicJob(job), pollUrl: `/api/jobs/${job.id}` });
          return;
        }
        throw new AgentServiceError("不支持的任务操作。", 422);
      }
      if (request.method === "POST" && url.pathname === "/api/test-proposals") {
        const body = await readJsonBody(request);
        const workspace = await resolveAllowedWorkspace(body.workspace, config.workspaceRoots);
        const normalized = normalizeTrace(body.trace);
        const sanitized = sanitizePayload(normalized);
        const job = enqueue("test-proposal", workspace, "read-only", sanitized.redactions, buildProposalPrompt(workspace, sanitized.value, body.context));
        sendJson(response, 202, { job: publicJob(job), pollUrl: `/api/jobs/${job.id}` });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/test-scripts") {
        const body = await readJsonBody(request);
        const workspace = await resolveAllowedWorkspace(body.workspace, config.workspaceRoots);
        const sanitized = sanitizePayload({ trace: body.trace, proposal: body.proposal, context: body.context });
        const applyChanges = body.applyChanges === true;
        const permissionMode = applyChanges ? "workspace-write" : "read-only";
        const job = enqueue("test-script", workspace, permissionMode, sanitized.redactions, buildScriptPrompt(workspace, sanitized.value, applyChanges));
        sendJson(response, 202, { job: publicJob(job), pollUrl: `/api/jobs/${job.id}` });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/hitl-ui-changes") {
        const body = await readJsonBody(request);
        const workspace = await resolveAllowedWorkspace(body.workspace, config.workspaceRoots);
        const annotation = normalizeHitlUiAnnotation(body.annotation);
        const sanitized = sanitizePayload(annotation);
        sanitized.value.codeCandidates = await collectUiCodeCandidates(workspace, sanitized.value);
        const routing = classifyHitlUiTask(sanitized.value);
        const requestHash = fingerprintHitlUiAnnotation(sanitized.value);
        const existing = annotation.id ? [...jobs.values()]
          .filter((candidate) => candidate.kind === "hitl-ui-change" && candidate.sourceAnnotationId === annotation.id && candidate.requestHash === requestHash)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .find((candidate) => ["queued", "running", "paused", "succeeded"].includes(candidate.status)) : null;
        if (existing) {
          existing.dedupeHits = (existing.dedupeHits || 0) + 1;
          decision(existing, "deduplication", `命中相同标注和请求内容，沿用任务 ${existing.id.slice(0, 8)}`, { requestHash: requestHash.slice(0, 12), status: existing.status });
          persistJobs();
          sendJson(response, 200, { job: publicJob(existing), pollUrl: `/api/jobs/${existing.id}`, deduplicated: true });
          return;
        }
        const job = enqueue(
          "hitl-ui-change",
          workspace,
          "workspace-write",
          sanitized.redactions,
          buildHitlUiChangePrompt(workspace, sanitized.value, routing),
          annotation.id || null,
          { question: sanitized.value.question, request: { annotation: sanitized.value }, requestHash, routing },
        );
        sendJson(response, 202, { job: publicJob(job), pollUrl: `/api/jobs/${job.id}` });
        return;
      }
      throw new AgentServiceError("接口不存在。", 404);
    } catch (error) {
      const statusCode = error instanceof AgentServiceError ? error.statusCode : 500;
      sendJson(response, statusCode, { error: error instanceof Error ? error.message : "未知错误" });
    }
  });

  if (queue.length > 0) queueMicrotask(drain);
  return { server, config, jobs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, config } = createAgentService();
  server.listen(config.port, config.host, () => console.log(`DSH 测试 agent dev 服务：http://${config.host}:${config.port}`));
}
