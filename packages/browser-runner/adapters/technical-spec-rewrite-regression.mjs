import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTOR_ID = "technical-spec-rewrite-regression-v1";
const ASSET_ID = "technical-spec-rewrite-offline-goldens-v1";
const hash = (v) => createHash("sha256").update(v).digest("hex");
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const verdict = (checks) => checks.some(x => x.status === "fail") ? "failed" : checks.some(x => x.status === "unknown") ? "attention_required" : "passed";

async function run(root, script, hooks) {
  let output = "";
  const exit = await new Promise((resolve, reject) => {
    const child = spawn("npm", ["exec", "--", "tsx", script], { cwd: root, env: { ...process.env, PLANORA_TECHNICAL_SPEC_GRAMMAR_URL: "" }, stdio: ["ignore", "pipe", "pipe"], shell: false });
    const ingest = chunk => { const text = chunk.toString("utf8"); output = `${output}${text}`.slice(-8000); for (const line of text.split(/\r?\n/u).filter(Boolean)) void hooks.onLog?.(`[${script}] ${line}`); };
    child.stdout.on("data", ingest); child.stderr.on("data", ingest); child.on("error", reject); child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return { ...exit, output };
}

export function createTechnicalSpecRewriteRegressionAdapter(options = {}) {
  const assetRoot = path.resolve(options.assetRoot || process.env.AGENT_EVAL_TECH_SPEC_REWRITE_ASSET_ROOT || fileURLToPath(new URL("../fixtures/technical-spec-rewrite-regression", import.meta.url)));
  const sourceRoot = options.sourceRoot || process.env.AGENT_EVAL_TECH_SPEC_REWRITE_ROOT || null;
  const manifestPath = path.join(assetRoot, "manifest.json");
  async function manifest() {
    const raw = await readFile(manifestPath, "utf8"); const value = JSON.parse(raw);
    const canonical = { ...value }; delete canonical.fixtureSha256;
    if (value.id !== ASSET_ID || value.executor?.id !== EXECUTOR_ID || hash(JSON.stringify(canonical)) !== value.fixtureSha256) throw new Error("TECH_SPEC_ASSET_MANIFEST_INVALID_OR_CHANGED");
    return value;
  }
  async function sourceChecks(value, root) {
    const checks = [];
    const revision = await new Promise((resolve, reject) => { const child = spawn("git", ["rev-parse", "HEAD"], { cwd: root, stdio: ["ignore", "pipe", "ignore"], shell: false }); let out = ""; child.stdout.on("data", x => { out += x; }); child.on("error", reject); child.on("exit", code => code === 0 ? resolve(out.trim()) : reject(new Error("TECH_SPEC_REVISION_UNAVAILABLE"))); });
    checks.push({ checkId: "source-revision", label: "改写源码版本与冻结基线一致", status: revision === value.sourceRevision ? "pass" : "fail", expected: value.sourceRevision, observed: revision, reasonCode: revision === value.sourceRevision ? null : "SOURCE_REVISION_MISMATCH", evidenceRefs: [] });
    for (const file of value.sourceFiles) { const target = path.join(root, file.path); const bytes = await readFile(target).catch(() => null); const actual = bytes && hash(bytes); checks.push({ checkId: `source:${file.id}`, label: `${file.label} SHA-256`, status: actual === file.sha256 ? "pass" : "fail", expected: file.sha256, observed: actual || null, reasonCode: actual ? "SOURCE_FILE_HASH_MISMATCH" : "SOURCE_FILE_MISSING", evidenceRefs: [target] }); }
    return checks;
  }
  function asset(value) { return { id: ASSET_ID, title: "技术规格书语气改写 · 离线金标与白盒回归", purpose: "冻结飞书句级金标和装船机金标；只验证离线规则、路由、保护与审计。", project: "Planora 技术规格书改写", benchmarkKey: "technical-spec-rewrite-offline-goldens", assetState: sourceRoot ? "runnable" : "blocked", ...(sourceRoot ? {} : { blockedReason: "需配置 AGENT_EVAL_TECH_SPEC_REWRITE_ROOT；不会调用远端、3033或模型。" }), baseline: { sourceRevision: value.sourceRevision, fixtureSha256: value.fixtureSha256, sourceFiles: value.sourceFiles, fullDocumentSlots: value.fullDocumentSlots }, method: "校验版本和 SHA-256 后执行已检入离线测试；句法使用注入夹具。", basis: "冻结输入/期望/路由/保护/审计元数据；不以真实LLM作稳定pass。", objectiveChecks: ["版本和资产哈希", "离线改写/装船机金标", "路由", "白盒审计", "飞书金标"], proposedQualityChecks: [{ id: "customer-full-document-quality", status: "pending_confirmation", title: "7份客户全文等待人工确认的期望统计和白盒证据。" }], executor: { id: EXECUTOR_ID, argument: ASSET_ID } }; }
  return {
    async load() { const value = await manifest(); return { assets: [asset(value)], history: { [ASSET_ID]: [] } }; },
    async execute(executor, hooks = {}) {
      if (executor?.id !== EXECUTOR_ID || executor.argument !== ASSET_ID) throw Object.assign(new Error("未在白名单的技术规格书离线回归入口。"), { code: "EXECUTOR_NOT_ALLOWED" });
      if (!sourceRoot) throw Object.assign(new Error("未配置技术规格书本地工作树。"), { code: "TECH_SPEC_SOURCE_ROOT_REQUIRED", reviewRequired: true });
      const root = path.resolve(sourceRoot), value = await manifest(), startedAt = Date.now(), checks = await sourceChecks(value, root);
      for (const [id, label, script] of [["rewrite-offline", "离线改写及装船机金标", "scripts/test-technical-spec-rewrite.ts"], ["routing", "显式路由契约", "scripts/test-technical-spec-rewrite-routing.ts"], ["audit", "白盒审计契约", "scripts/test-technical-spec-rewrite-audit.ts"], ["feishu", "飞书句级金标", "scripts/test-technical-spec-rewrite-feishu-quality.ts"]]) { const result = await run(root, script, hooks); checks.push({ checkId: id, label, status: result.code === 0 ? "pass" : "fail", expected: "exit code 0", observed: `exit=${result.code}; ${result.output.slice(-1000)}`, reasonCode: result.code === 0 ? null : "OFFLINE_REGRESSION_FAILED", evidenceRefs: [path.join(root, script)] }); }
      return { checkVerdict: verdict(checks), businessVerdict: "not_evaluated", checkResults: checks, startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt, timeSource: "local-offline", sourceResultRef: manifestPath, applicationRevision: value.sourceRevision, evidenceRefs: [manifestPath, ...value.sourceFiles.map(x => path.join(root, x.path))], errorCode: checks.some(x => x.status === "fail") ? "TECH_SPEC_OFFLINE_REGRESSION_FAILED" : null };
    },
  };
}
