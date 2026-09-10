import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const EXECUTOR_ID = "dangerous-v2-onlyoffice-external-driver-v1";
const ASSET_ID = "dangerous-v2-onlyoffice-table-save-reopen-export-v1";

function json(value) { return JSON.parse(value); }
function iso(value) { return value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toISOString() : null; }
function under(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}
function evidence(root, value) {
  if (typeof value !== "string") return null;
  const candidate = path.resolve(value);
  return under(root, candidate) ? candidate : null;
}
function status(value) { return value === true ? "pass" : value === false ? "fail" : "unknown"; }
function verdict(checks) {
  if (checks.some((item) => item.status === "fail")) return "failed";
  if (checks.some((item) => item.status === "unknown")) return "attention_required";
  return "passed";
}

async function readJson(file) { return json(await readFile(file, "utf8")); }

function checkResults(result, exportChecks) {
  const checks = exportChecks?.checks || result?.checkResults || {};
  const labels = {
    saveAdvancedVersion: "保存生成新的 Word 版本",
    statusChecksumEqualsExportSha: "保存版本校验和等于下载 DOCX SHA-256",
    historyContainsSavedHead: "历史包含当前保存版本",
    editedCellText: "导出正文包含已编辑的表格单元格",
    beforeAnchor: "导出正文保留表格前锚点",
    afterAnchor: "导出正文保留表格后锚点",
    tablePresent: "导出正文保留表格",
    tocPresent: "导出正文保留目录标记",
    imageRelationshipPresent: "导出 DOCX 保留图片关系",
    uploadedCalculationBookShaUnchanged: "上传计算书源文件未被正文保存改写",
  };
  const refs = [
    evidence(path.dirname(path.dirname(result.__resultPath)), path.join(path.dirname(result.__resultPath), "export-checks.json")),
    evidence(path.dirname(path.dirname(result.__resultPath)), path.join(path.dirname(result.__resultPath), "export.docx")),
  ].filter(Boolean);
  return Object.entries(labels).map(([checkId, label]) => ({ checkId, label, status: status(checks[checkId]), observed: checks[checkId] ?? null, evidenceRefs: refs }));
}

async function resultFrom(root, resultPath) {
  const result = await readJson(resultPath);
  result.__resultPath = resultPath;
  if (result.id !== ASSET_ID) throw Object.assign(new Error("OnlyOffice driver returned a different asset id."), { code: "DANGEROUS_V2_RESULT_ASSET_MISMATCH" });
  const exportPath = path.join(path.dirname(resultPath), "export-checks.json");
  let exportChecks = null;
  try { exportChecks = await readJson(exportPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const checks = checkResults(result, exportChecks);
  const refs = [resultPath, exportPath, path.join(path.dirname(resultPath), "export.docx")].filter((item) => evidence(root, item));
  return {
    checkVerdict: result.executionStatus === "completed" ? verdict(checks) : "failed",
    businessVerdict: result.businessVerdict || "not_evaluated",
    checkResults: checks,
    startedAt: iso(result.startedAt),
    finishedAt: iso(result.completedAt),
    elapsedMs: null,
    timeSource: "external-driver",
    sourceResultRef: resultPath,
    applicationRevision: result.sourceRevision || null,
    projectId: result.project?.id || null,
    targetId: result.project?.planId || null,
    evidenceRefs: refs,
    errorCode: result.executionStatus === "completed" ? null : "DANGEROUS_V2_MECHANICAL_CHECK_FAILED",
    originalState: result.executionStatus || null,
    originalReason: result.error || null,
  };
}

function assetFrom(asset, latest) {
  const blocked = latest.executionStatus !== "completed";
  return {
    ...asset,
    assetState: asset.assetState || "runnable",
    evaluation: {
      track: blocked ? "experiment" : "candidate",
      lifecycle: blocked ? "blocked" : "active",
      ...(blocked ? { blockedReason: latest.reason || latest.error || "Latest mechanical run did not complete." } : {}),
      target: {
        name: "OnlyOffice 危大 v2 本地实验台",
        instance: latest.environment?.name || "local-dangerous-onlyoffice-v2",
        ...(latest.environment?.baseUrl ? { baseUrl: latest.environment.baseUrl } : {}),
      },
      fixturePolicy: `${asset.fixture?.strategy || "每轮新建合成项目"}；项目代码前缀 ${asset.fixture?.projectCodePrefix || "OO-V2-REG-"}；成功时 driver 核验归属后清理，失败保留现场且平台不删除。`,
      promotion: {
        note: "修复当前机械失败后，在新的干净 OO-V2-REG-* 现场完整稳定重跑；再由人工提升为 candidate。主干环境另行配置，不能以本地 3041 结果替代。",
      },
    },
    executor: { id: EXECUTOR_ID, argument: ASSET_ID },
  };
}

/**
 * Imports a self-owned local OnlyOffice experiment. The platform receives no
 * command, credentials, project id, or cleanup request from HTTP; it can only
 * launch this exact reviewed driver with no resume arguments.
 */
export function createDangerousV2OnlyOfficeAdapter(options = {}) {
  const configuredRoot = options.root || process.env.AGENT_EVAL_DANGEROUS_V2_ROOT;
  if (!configuredRoot) throw new Error("AGENT_EVAL_DANGEROUS_V2_ROOT is required");
  const root = path.resolve(configuredRoot);
  const assetPath = path.join(root, "asset.json");
  const driver = path.join(root, "run-dangerous-v2-onlyoffice.mjs");

  async function loadSource() {
    const asset = await readJson(assetPath);
    if (asset.id !== ASSET_ID || asset.executor?.id !== EXECUTOR_ID) throw new Error("DANGEROUS_V2_ASSET_IDENTITY_MISMATCH");
    const runId = asset.latestRecovery?.runId;
    if (!runId) throw new Error("DANGEROUS_V2_LATEST_RUN_MISSING");
    const resultPath = path.join(root, "evidence", runId, "result.json");
    const result = await readJson(resultPath);
    result.__resultPath = resultPath;
    return { asset, result, resultPath };
  }

  return {
    async load() {
      const source = await loadSource();
      const imported = await resultFrom(root, source.resultPath);
      const historyRun = {
        id: `import-${source.result.runId}`,
        checkId: ASSET_ID,
        executionStatus: "finished",
        executionOutcome: source.result.executionStatus === "completed" ? "completed" : "failed",
        ...imported,
        importedAt: null,
        logTail: [],
      };
      return { assets: [assetFrom(source.asset, source.result)], history: { [ASSET_ID]: [historyRun] } };
    },
    async execute(executor, hooks = {}) {
      if (executor?.id !== EXECUTOR_ID || executor.argument !== ASSET_ID) throw Object.assign(new Error("未在白名单的 OnlyOffice v2 执行入口。"), { code: "EXECUTOR_NOT_ALLOWED" });
      await hooks.onLog?.("Starting the reviewed OnlyOffice v2 driver with a fresh fixture; retained failed fixtures are not resumed or deleted.");
      const startedAt = Date.now();
      let output = "";
      const exit = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [driver], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"], shell: false });
        const ingest = (chunk) => { output = `${output}${chunk.toString("utf8")}`.slice(-20000); };
        child.stdout.on("data", ingest); child.stderr.on("data", ingest); child.on("error", reject); child.on("exit", (code, signal) => resolve({ code, signal }));
      });
      const summary = [...output.matchAll(/"evidenceDir"\s*:\s*"([^"]+)"/g)].at(-1)?.[1];
      const resultPath = summary && evidence(root, path.join(summary, "result.json"));
      if (!resultPath) throw Object.assign(new Error("OnlyOffice driver did not return an owned evidence directory."), { code: "DANGEROUS_V2_RUN_OUTPUT_MISSING" });
      const imported = await resultFrom(root, resultPath);
      await hooks.onLog?.(`OnlyOffice v2 driver exited ${exit.code ?? "null"}; imported its owned evidence result.`);
      return { ...imported, elapsedMs: Date.now() - startedAt, errorCode: exit.code === 0 ? imported.errorCode : (imported.errorCode || "DANGEROUS_V2_DRIVER_NONZERO") };
    },
  };
}
