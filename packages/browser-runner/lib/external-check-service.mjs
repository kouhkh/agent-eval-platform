import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { BrowserRunnerError } from "./operation-budget.mjs";

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function now() { return new Date().toISOString(); }

export class ExternalCheckService {
  constructor(options = {}) {
    this.statePath = path.resolve(options.statePath || path.join(process.cwd(), "data", "external-check-runs.json"));
    this.adapter = options.adapter || null;
    this.assets = new Map();
    this.runs = new Map();
    this.persistChain = Promise.resolve();
    this.loadPromise = this.load();
  }

  async load() {
    if (!this.adapter) return;
    const initial = await this.adapter.load();
    for (const asset of initial.assets || []) this.assets.set(asset.id, clone(asset));
    for (const [id, runs] of Object.entries(initial.history || {})) this.runs.set(id, runs.map(clone));
    try {
      const saved = JSON.parse(await readFile(this.statePath, "utf8"));
      for (const [id, runs] of Object.entries(saved.runs || {})) {
        const imported = this.runs.get(id) || [];
        const seen = new Set(imported.map((run) => run.id));
        this.runs.set(id, [...imported, ...runs.filter((run) => !seen.has(run.id))]);
      }
      let recovered = false;
      for (const runs of this.runs.values()) for (const run of runs) {
        if (!["pending", "running"].includes(run.executionStatus)) continue;
        run.executionStatus = "interrupted";
        run.checkVerdict = "not_evaluated";
        run.finishedAt = null;
        run.errorCode = "PLATFORM_RESTARTED";
        recovered = true;
      }
      if (recovered) await this.persistNow();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async persistNow() {
    await mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.statePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ schemaVersion: 1, runs: Object.fromEntries(this.runs) }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.statePath);
  }

  async persist() {
    this.persistChain = this.persistChain.catch(() => {}).then(() => this.persistNow());
    return this.persistChain;
  }

  async list() {
    await this.loadPromise;
    return [...this.assets.values()].map((asset) => this.withRuns(asset));
  }

  async get(id) {
    await this.loadPromise;
    const asset = this.assets.get(String(id));
    if (!asset) throw new BrowserRunnerError("CHECK_NOT_FOUND", "找不到指定回归检查。", { statusCode: 404, phase: "check-control" });
    return this.withRuns(asset);
  }

  withRuns(asset) {
    const history = [...(this.runs.get(asset.id) || [])].sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")));
    return { ...clone(asset), history, latestRun: history.at(-1) || null };
  }

  async start(id) {
    const asset = await this.get(id);
    if (asset.history.some((run) => ["pending", "running"].includes(run.executionStatus))) {
      throw new BrowserRunnerError("CHECK_ALREADY_RUNNING", "该检查已在执行。", { statusCode: 409, phase: "check-control" });
    }
    const run = {
      id: randomUUID(),
      checkId: asset.id,
      executionStatus: "pending",
      checkVerdict: "not_evaluated",
      businessVerdict: "not_evaluated",
      startedAt: now(),
      finishedAt: null,
      elapsedMs: null,
      timeSource: "platform",
      importedAt: null,
      sourceResultRef: null,
      evidenceRefs: [],
      checkResults: [],
      logTail: [],
      errorCode: null,
    };
    this.runs.set(asset.id, [...(this.runs.get(asset.id) || []), run]);
    await this.persist();
    queueMicrotask(() => { void this.execute(asset, run); });
    return clone(run);
  }

  async execute(asset, run) {
    const started = Date.now();
    try {
      run.executionStatus = "running";
      await this.persist();
      const result = await this.adapter.execute(asset.executor, {
        onLog: async (line) => {
          run.logTail = [...run.logTail, String(line).slice(0, 2000)].slice(-30);
          await this.persist();
        },
      });
      Object.assign(run, result, {
        executionStatus: "finished",
        finishedAt: result.finishedAt || now(),
        elapsedMs: result.elapsedMs ?? Date.now() - started,
      });
    } catch (error) {
      Object.assign(run, {
        executionStatus: "finished",
        checkVerdict: "failed",
        businessVerdict: "not_evaluated",
        finishedAt: now(),
        elapsedMs: Date.now() - started,
        errorCode: String(error?.code || "CHECK_EXECUTION_FAILED"),
        error: String(error?.message || error).slice(0, 1000),
      });
    }
    await this.persist().catch(() => {});
  }
}
