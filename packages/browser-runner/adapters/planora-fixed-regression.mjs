import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

const NAMES = { jingzhou: "荆州", qidong: "启东", sanming: "三明", qinhuangdao: "秦皇岛" };
const SCENARIOS = { directory: "目录生成", chapter: "正文生成" };
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const exists = async (file) => { try { await access(file); return true; } catch { return false; } };
const iso = (value) => value == null ? null : new Date(value).toISOString();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function verdict(results) {
  if (results.some((item) => item.status === "fail")) return "failed";
  if (results.some((item) => item.status === "unknown")) return "attention_required";
  return results.length > 0 && results.every((item) => item.status === "pass") ? "passed" : "not_evaluated";
}

async function evaluateResult(result, fallback = {}) {
  const observation = result?.observation || {};
  const job = observation.job || {};
  const artifact = observation.artifact || {};
  const expected = fallback.expected || {};
  const evidenceRefs = observation.evidenceRefs || [];
  const readEvidence = async (matcher) => {
    const ref = evidenceRefs.find((item) => typeof matcher === "string" ? String(item).endsWith(matcher) : matcher.test(String(item)));
    if (!ref) return { ref: null, value: null };
    try { return { ref, value: await readJson(ref) }; } catch { return { ref, value: null }; }
  };
  const requestEvidence = await readEvidence("request-reference.json");
  const preparedJobs = await readEvidence(/\/prepare-\d+-jobs\.json$/);
  const artifactRef = observation.artifactEvidenceRef || fallback.artifactRef || null;
  const artifactPresent = Boolean(artifactRef && await exists(artifactRef));
  let artifactDocument = null;
  if (artifactPresent) { try { artifactDocument = await readJson(artifactRef); } catch { artifactDocument = null; } }
  const chapters = Array.isArray(artifactDocument?.chapters) ? artifactDocument.chapters : null;
  const targetChapter = chapters?.find((item) => item.id === observation.plan?.targetId) || null;
  const directoryValid = chapters?.length > 0 && chapters.every((item) => typeof item.id === "string" && typeof item.title === "string" && item.title.trim());
  const chapterContent = typeof targetChapter?.content === "string" ? targetChapter.content : "";
  const nonEmpty = result?.scenario === "directory" ? directoryValid : chapterContent.trim().length > 0;
  const bindingMatches = Boolean(job.id
    && result.projectId === observation.plan?.projectId
    && result.targetId === observation.plan?.targetId
    && observation.projectId === observation.plan?.projectId
    && observation.scenario === result.scenario
    && observation.plan?.actorUserId === expected.actorUserId
    && job.projectId === observation.plan?.projectId
    && job.targetId === observation.plan?.targetId
    && job.type === observation.plan?.jobType
    && job.createdById === observation.plan?.actorUserId);
  const beforeJobsKnown = Array.isArray(preparedJobs.value);
  const terminal = ["succeeded", "failed", "cancelled", "needs_input"].includes(job.status);
  const checks = [
    { checkId: "baseline-binding", label: "固定基线与输入绑定", status: expected.applicationRevision && expected.inputFingerprint ? (result.applicationRevision === expected.applicationRevision && result.inputFingerprint === expected.inputFingerprint ? "pass" : "fail") : "unknown", expected: expected.applicationRevision && expected.inputFingerprint ? `${expected.applicationRevision} / ${expected.inputFingerprint}` : "application revision + pinned input fingerprint", observed: `${result.applicationRevision || "unknown"} / ${result.inputFingerprint || "unknown"}`, reasonCode: expected.applicationRevision && expected.inputFingerprint ? null : "EXPECTED_BASELINE_UNAVAILABLE", evidenceRefs: [fallback.resultRef, expected.ledgerPath].filter(Boolean) },
    { checkId: "request-contract", label: "生成请求方法、路径与响应", status: requestEvidence.value ? (requestEvidence.value.status == null ? "unknown" : requestEvidence.value.method === "POST" && requestEvidence.value.path === observation.plan?.requestPath && requestEvidence.value.status === 200 ? "pass" : "fail") : "unknown", expected: `POST ${observation.plan?.requestPath || "<planned path>"} -> 200`, observed: requestEvidence.value ? `${requestEvidence.value.method} ${requestEvidence.value.path} -> ${requestEvidence.value.status ?? "unknown"}` : null, reasonCode: requestEvidence.value?.status == null ? "REQUEST_HTTP_STATUS_UNKNOWN" : null, evidenceRefs: [requestEvidence.ref].filter(Boolean) },
    { checkId: "new-job-binding", label: "新 job 与项目、目标、类型和执行人一致", status: !job.id || !beforeJobsKnown ? "unknown" : (!preparedJobs.value.some((item) => item.id === job.id) && bindingMatches ? "pass" : "fail"), expected: "new job absent before trigger and all plan bindings match", observed: job.id || null, reasonCode: beforeJobsKnown ? null : "BEFORE_JOB_SET_UNAVAILABLE", evidenceRefs: [preparedJobs.ref, observation.jobEvidenceRef].filter(Boolean) },
    { checkId: "job-completed", label: "后台生成任务完成", status: !terminal || !job.finishedAt ? "unknown" : job.status === "succeeded" ? "pass" : "fail", expected: "terminal job.status = succeeded and finishedAt exists", observed: job.status ? `${job.status} / ${job.finishedAt || "unfinished"}` : null, reasonCode: observation.reason || null, evidenceRefs: observation.jobEvidenceRef ? [observation.jobEvidenceRef] : [] },
    { checkId: "artifact-exists", label: "生成产物可读", status: !artifactRef ? "unknown" : artifactPresent && artifactDocument ? "pass" : "fail", expected: "artifact evidence exists and parses", observed: artifactPresent && Boolean(artifactDocument), reasonCode: artifactRef ? null : "ARTIFACT_REF_MISSING", evidenceRefs: artifactRef ? [artifactRef] : [] },
    { checkId: "artifact-non-empty", label: result?.scenario === "directory" ? "目录结构非空" : "正文内容非空", status: !artifactDocument ? "unknown" : nonEmpty ? "pass" : "fail", expected: result?.scenario === "directory" ? "artifact chapters contain id/title and are non-empty" : "bound target chapter contains non-empty content", observed: result?.scenario === "directory" ? (chapters?.length ?? null) : (chapterContent ? Buffer.byteLength(chapterContent, "utf8") : 0), reasonCode: nonEmpty ? null : "EMPTY_OR_UNOBSERVED_ARTIFACT", evidenceRefs: artifactRef ? [artifactRef] : [] },
  ];
  return checks;
}

function assetFrom(benchmark, scenario, catalog, seedLedger) {
  const spec = scenario === "directory" ? benchmark.directorySpec : benchmark.chapterSpec;
  const id = `fixed-${benchmark.benchmarkKey}-${scenario}`;
  return {
    id,
    title: `${NAMES[benchmark.benchmarkKey]} · ${SCENARIOS[scenario]}`,
    purpose: `确认固定材料和基线下的${SCENARIOS[scenario]}链路能完成，并产生可检查的非空产物。`,
    project: "Planora 固定回归集（外部适配）",
    benchmarkKey: benchmark.benchmarkKey,
    scenario,
    baseline: {
      version: "verified-materials-20260908",
      applicationRevision: catalog.applicationRevision,
      configSha256: catalog.configSha256,
      inputSha256: benchmark.inputs.map((item) => item.sha256),
      ledgerSha256: { A: benchmark.A.sha256, B: benchmark.B.sha256 },
      inputFingerprint: seedLedger.inputFingerprint,
      actorUserId: seedLedger.actorUserId,
      ledgerPath: scenario === "directory" ? benchmark.A.ledgerPath : benchmark.B.ledgerPath,
      ...(spec.chapterKey ? { chapterKey: spec.chapterKey } : {}),
    },
    method: "调用已有固定回归执行器；核对新 job 的终态、目标绑定和产物证据，再对目录结构或正文内容做非空检查。",
    basis: "固定基线材料、执行器 observation/result 以及产物证据；不以进程退出码代替业务结果。",
    objectiveChecks: ["后台 job 成功完成", "产物证据存在且可读", scenario === "directory" ? "目录节点数大于 0" : "正文字节数或字符数大于 0"],
    proposedQualityChecks: [{ id: `${id}-quality`, status: "pending_confirmation", title: scenario === "directory" ? "目录范围、层级与必备章节是否符合业务预期" : "正文是否准确覆盖该章节要求且内容可用" }],
    executor: { id: "planora-fixed-regression-v1", argument: `${benchmark.benchmarkKey}-${scenario}` },
  };
}

async function historicalRun(item, asset, suffix = "first") {
  const result = await readJson(item.resultRef);
  const checkResults = await evaluateResult(result, { ...item, expected: asset.baseline });
  const startedAt = iso(result.observation?.job?.startedAt || item.startedAt);
  const finishedAt = iso(result.observation?.job?.finishedAt || item.finishedAt);
  return {
    id: `import-${item.benchmark || "sanming"}-${item.scenario}-${suffix}`,
    checkId: `fixed-${item.benchmark || "sanming"}-${item.scenario}`,
    executionStatus: "finished",
    checkVerdict: verdict(checkResults),
    businessVerdict: "not_evaluated",
    startedAt,
    finishedAt,
    elapsedMs: startedAt && finishedAt ? new Date(finishedAt) - new Date(startedAt) : null,
    timeSource: "job",
    importedAt: null,
    sourceResultRef: item.resultRef,
    applicationRevision: result.applicationRevision || null,
    inputFingerprint: result.inputFingerprint || null,
    projectId: result.projectId || item.projectId || null,
    targetId: result.targetId || item.targetId || null,
    jobId: result.observation?.job?.id || item.jobId || null,
    evidenceRefs: [...new Set([item.resultRef, item.artifactRef, ...(result.observation?.evidenceRefs || [])].filter(Boolean))],
    checkResults,
    source: suffix === "first" ? "first-eight-results.json" : "repeat-verification-summary.json",
    originalState: result.state || item.state || null,
    originalReason: result.observation?.reason || null,
    logTail: [],
    errorCode: null,
  };
}

export function createPlanoraFixedRegressionAdapter(options = {}) {
  const configuredRoot = options.root || process.env.AGENT_EVAL_FIXED_ROOT;
  if (!configuredRoot) throw new Error("AGENT_EVAL_FIXED_ROOT is required");
  const root = path.resolve(configuredRoot);
  const generationRoot = path.join(root, "replay", "generation");
  const runnerUrl = options.runnerUrl || process.env.AGENT_EVAL_RUNNER_URL || process.env.PLANORA_BENCHMARK_RUNNER_URL;
  const runnerEvidenceRoot = options.runnerEvidenceRoot || process.env.AGENT_EVAL_RUNNER_EVIDENCE_ROOT || process.env.PLANORA_BENCHMARK_RUNNER_EVIDENCE_ROOT;
  return {
    async load() {
      const catalog = await readJson(path.join(generationRoot, "fixed-catalog.json"));
      const configBytes = await readFile(catalog.configPath);
      if (sha256(configBytes) !== catalog.configSha256) throw new Error("CONFIG_CHANGED");
      const first = await readJson(path.join(root, "runs", "first-eight-results.json"));
      const repeat = await readJson(path.join(root, "runs", "repeat-verification-summary.json"));
      const assets = [];
      for (const benchmark of catalog.benchmarks) {
        for (const scenario of ["directory", "chapter"]) {
          const ledgerRef = scenario === "directory" ? benchmark.A : benchmark.B;
          const ledgerBytes = await readFile(ledgerRef.ledgerPath);
          if (sha256(ledgerBytes) !== ledgerRef.sha256) throw new Error("PINNED_INPUT_CHANGED");
          assets.push(assetFrom(benchmark, scenario, catalog, JSON.parse(ledgerBytes)));
        }
      }
      const history = Object.fromEntries(assets.map((asset) => [asset.id, []]));
      const byId = new Map(assets.map((asset) => [asset.id, asset]));
      for (const item of first) { const id = `fixed-${item.benchmark}-${item.scenario}`; history[id].push(await historicalRun(item, byId.get(id))); }
      for (const item of repeat) { const id = `fixed-sanming-${item.scenario}`; history[id].push(await historicalRun({ ...item, benchmark: "sanming", artifactRef: item.outputRef }, byId.get(id), "repeat")); }
      return { assets, history };
    },
    async execute(executor, hooks = {}) {
      if (executor?.id !== "planora-fixed-regression-v1" || !/^(jingzhou|qidong|sanming|qinhuangdao)-(directory|chapter)$/.test(executor.argument || "")) throw Object.assign(new Error("未在白名单的回归执行入口。"), { code: "EXECUTOR_NOT_ALLOWED" });
      const script = path.join(generationRoot, "run-local.mjs");
      let outputDir = null;
      let tail = "";
      const startedAt = Date.now();
      const exit = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, executor.argument], { cwd: generationRoot, env: { ...process.env, ...(runnerUrl ? { PLANORA_BENCHMARK_RUNNER_URL: runnerUrl } : {}), ...(runnerEvidenceRoot ? { PLANORA_BENCHMARK_RUNNER_EVIDENCE_ROOT: runnerEvidenceRoot } : {}) }, stdio: ["ignore", "pipe", "pipe"], shell: false });
        const ingest = (chunk) => {
          const text = chunk.toString("utf8"); tail = `${tail}${text}`.slice(-40000);
          const match = tail.match(/Run output: (.+)/); if (match) outputDir = match[1].trim().split(/\r?\n/)[0];
          for (const line of text.split(/\r?\n/).filter(Boolean)) void hooks.onLog?.(line);
        };
        child.stdout.on("data", ingest); child.stderr.on("data", ingest); child.on("error", reject); child.on("exit", (code, signal) => resolve({ code, signal }));
      });
      if (!outputDir) throw Object.assign(new Error("执行器未返回产物目录。"), { code: "RUN_OUTPUT_MISSING" });
      const scenarioResultRef = path.join(outputDir, executor.argument, "scenario-result.json");
      const scenarioResult = await readJson(scenarioResultRef);
      if (!scenarioResult.resultRef) {
        return {
          checkVerdict: "attention_required", businessVerdict: "not_evaluated",
          checkResults: [{ checkId: "execution-observation", label: "既有执行链返回可判定观测", status: "unknown", expected: "scenario result contains an objective result reference", observed: scenarioResult.state || null, reasonCode: scenarioResult.errorCode || "RESULT_REFERENCE_UNAVAILABLE", evidenceRefs: [scenarioResultRef] }],
          startedAt: scenarioResult.startedAt || new Date(startedAt).toISOString(), finishedAt: scenarioResult.finishedAt || new Date().toISOString(), elapsedMs: Date.now() - startedAt,
          timeSource: "runner", sourceResultRef: scenarioResultRef, evidenceRefs: [scenarioResultRef], errorCode: scenarioResult.errorCode || (exit.code === 0 ? null : "RUNNER_REPORTED_NONZERO"), originalState: scenarioResult.state || null, originalReason: null,
        };
      }
      const result = await readJson(scenarioResult.resultRef);
      const catalog = await readJson(path.join(generationRoot, "fixed-catalog.json"));
      const benchmark = catalog.benchmarks.find((item) => `${item.benchmarkKey}-${result.scenario}` === executor.argument);
      const ledgerRef = result.scenario === "directory" ? benchmark?.A : benchmark?.B;
      const ledger = ledgerRef ? await readJson(ledgerRef.ledgerPath) : null;
      const checkResults = await evaluateResult(result, { ...scenarioResult, expected: { applicationRevision: catalog.applicationRevision, inputFingerprint: ledger?.inputFingerprint, actorUserId: ledger?.actorUserId, ledgerPath: ledgerRef?.ledgerPath } });
      return {
        checkVerdict: verdict(checkResults), businessVerdict: "not_evaluated", checkResults,
        startedAt: scenarioResult.startedAt || new Date(startedAt).toISOString(), finishedAt: scenarioResult.finishedAt || new Date().toISOString(),
        elapsedMs: Date.now() - startedAt, timeSource: "runner", sourceResultRef: scenarioResult.resultRef,
        applicationRevision: result.applicationRevision || null, inputFingerprint: result.inputFingerprint || null,
        projectId: result.projectId || null, targetId: result.targetId || null, jobId: result.observation?.job?.id || null,
        evidenceRefs: [scenarioResultRef, scenarioResult.resultRef, ...(result.observation?.evidenceRefs || [])],
        errorCode: exit.code === 0 ? null : "RUNNER_REPORTED_NONZERO", originalState: result.state || null, originalReason: result.observation?.reason || null,
      };
    },
  };
}
