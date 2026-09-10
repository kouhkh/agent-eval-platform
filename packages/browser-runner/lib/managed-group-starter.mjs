import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { BrowserRunnerError } from "./operation-budget.mjs";

function clean(value) { return typeof value === "string" ? value.trim() : ""; }
function exactUrl(value) { try { return new URL(value).href.replace(/\/$/, ""); } catch { return ""; } }

function normalizePlan(item) {
  if (!item || typeof item !== "object") throw new Error("启动计划必须是对象。");
  const id = clean(item.id), targetUrl = exactUrl(item.targetUrl), cwd = clean(item.cwd);
  if (!id || !targetUrl || !cwd || !path.isAbsolute(cwd)) throw new Error("启动计划需要绝对工作目录、标识和目标地址。");
  const target = new URL(targetUrl);
  if (!["127.0.0.1", "localhost", "::1"].includes(target.hostname)) throw new Error(`启动计划“${id}”只能启动本机环回目标。`);
  const command = clean(item.command);
  const args = Array.isArray(item.args) ? item.args.map(clean).filter(Boolean) : [];
  if (command !== "npm" || !args.length) throw new Error(`启动计划“${id}”未使用受管 npm 命令。`);
  return { id, targetUrl, cwd, command, args, healthPath: clean(item.healthPath) || "/api/health", label: clean(item.label) || id };
}

export class ManagedGroupStarter {
  constructor({ plans = [], onUpdate }) {
    this.plans = new Map(plans.map(normalizePlan).map((plan) => [plan.id, plan]));
    this.onUpdate = onUpdate;
    this.running = new Map();
  }

  async start(group) {
    const plan = this.plans.get(group.startPlanId);
    if (!plan) throw new BrowserRunnerError("CHECK_GROUP_START_PLAN_MISSING", "该分组未绑定可运行的固定启动计划。", { statusCode: 409, phase: "check-groups" });
    if (exactUrl(group.targetUrl) !== plan.targetUrl) throw new BrowserRunnerError("CHECK_GROUP_START_PLAN_TARGET_MISMATCH", "固定启动计划与分组目标地址不一致。", { statusCode: 409, phase: "check-groups" });
    if (this.running.has(group.id)) return { status: "running", reason: `固定启动计划“${plan.label}”仍在启动中。` };
    await access(plan.cwd);
    const child = spawn(plan.command, plan.args, { cwd: plan.cwd, env: process.env, detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    this.running.set(group.id, child.pid || true);
    void this.waitForHealth(group, plan);
    return { status: "running", reason: `正在运行固定启动计划“${plan.label}”，等待 ${new URL(plan.targetUrl).host} 就绪。` };
  }

  async waitForHealth(group, plan) {
    let lastError = null;
    try {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          const response = await fetch(new URL(plan.healthPath, `${plan.targetUrl}/`), { signal: AbortSignal.timeout(1500) });
          if (response.ok) {
            await this.onUpdate(group.id, { status: "completed", reason: `固定启动计划“${plan.label}”已就绪（HTTP ${response.status}）。` });
            return;
          }
          lastError = `HTTP ${response.status}`;
        } catch (error) { lastError = error?.cause?.code || error?.name || "连接失败"; }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      await this.onUpdate(group.id, { status: "failed", reason: `固定启动计划“${plan.label}”未在 30 秒内就绪：${lastError || "未知错误"}。` });
    } finally { this.running.delete(group.id); }
  }
}
