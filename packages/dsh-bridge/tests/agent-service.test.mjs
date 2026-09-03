import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AgentServiceError,
  buildJsonRepairPrompt,
  buildHitlUiChangePrompt,
  buildProposalPrompt,
  buildScriptPrompt,
  classifyHitlUiTask,
  extractStructuredOutput,
  extractStructuredOutputDetails,
  fingerprintHitlUiAnnotation,
  normalizeTrace,
  normalizeHitlUiAnnotation,
  normalizeStructuredOutput,
  resolveAllowedWorkspace,
  sanitizePayload,
  validateStructuredOutput,
} from "../lib/agent-service.mjs";
import { createAgentService, sessionEventProgress } from "../server.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const exec = promisify(execFile);
const sample = JSON.parse(await readFile(path.join(ROOT, "fixtures", "sample-trace.json"), "utf8"));

test("trace normalization rejects empty input", () => {
  assert.throws(() => normalizeTrace({ events: [] }), (error) => error instanceof AgentServiceError && error.statusCode === 422);
});

test("payload sanitization removes API credentials and personal fields", () => {
  const { value, redactions } = sanitizePayload({
    apiKey: "company-secret",
    authorization: "Bearer abc.def",
    events: [{ action: "change", inputType: "email", value: "tester@example.com" }],
  });
  assert.equal(value.apiKey, "<redacted:sensitive>");
  assert.equal(value.authorization, "<redacted:sensitive>");
  assert.equal(value.events[0].value, "<redacted:email>");
  assert.equal(redactions.length, 3);
});

test("canonical DSH tool events become bounded redacted progress", () => {
  const progress = sessionEventProgress({
    type: "tool/call",
    seq: 12,
    time: Date.UTC(2026, 8, 3),
    data: { name: "shell", arguments: '{"command":"run","apiKey":"company-secret"}' },
  });
  assert.equal(progress.kind, "tool_call");
  assert.equal(progress.sourceType, "tool/call");
  assert.equal(progress.sourceSeq, 12);
  assert.match(progress.text, /<redacted:sensitive>/);
  assert.doesNotMatch(progress.text, /company-secret/);
});

test("structured output accepts raw and fenced JSON", () => {
  assert.deepEqual(extractStructuredOutput('{"ok":true}'), { ok: true });
  assert.deepEqual(extractStructuredOutput('result\n```json\n{"ok":true}\n```'), { ok: true });
  assert.deepEqual(
    extractStructuredOutput('result\n```json\n{"description":"supports ```json inner fences"}\n```\ncomplete'),
    { description: "supports ```json inner fences" },
  );
  assert.deepEqual(
    extractStructuredOutputDetails('prefix {"summary":"ok","items":[],""} suffix'),
    { value: { summary: "ok", items: [] }, repairs: ["removed-dangling-empty-property"] },
  );
  assert.equal(extractStructuredOutput("plain text"), null);
});

test("structured output validation rejects missing required fields", () => {
  assert.equal(validateStructuredOutput("test-script", { summary: "partial", gateTests: [] }).valid, false);
  assert.equal(validateStructuredOutput("test-proposal", {
    summary: "ok",
    codeEvidence: [],
    observedSteps: [],
    confirmations: [],
    proposedSuites: {},
    unknowns: [],
  }).valid, true);
  const repairPrompt = buildJsonRepairPrompt("test-script", "not-json", ["output is not a JSON object"]);
  assert.match(repairPrompt, /gateTests\(array\)/);
  assert.match(repairPrompt, /untrusted_invalid_output/);
  assert.equal(validateStructuredOutput("hitl-ui-change", {
    summary: "ok",
    filesChanged: [],
    verification: [],
    remainingUnknowns: [],
  }).valid, true);
  const normalized = normalizeStructuredOutput("hitl-ui-change", { summary: "ok", filesChanged: [] });
  assert.deepEqual(normalized.value.verification, []);
  assert.deepEqual(normalized.value.remainingUnknowns, []);
  assert.deepEqual(normalized.repairs, ["defaulted-verification", "defaulted-remainingUnknowns"]);
});

test("prompts separate read-only proposal from optional workspace writes", () => {
  const proposal = buildProposalPrompt("/workspace", sample, null);
  assert.match(proposal, /只读检查代码/);
  assert.match(proposal, /不得修改任何文件/);
  const preview = buildScriptPrompt("/workspace", { proposal: {} }, false);
  assert.match(preview, /保持完全只读/);
  const apply = buildScriptPrompt("/workspace", { proposal: {} }, true);
  assert.match(apply, /workspace-write/);
  const annotation = normalizeHitlUiAnnotation({
    question: "把按钮变得更清晰",
    ui_elements: [{ selector: "#save", name: "保存", groups: [
      { id: "red", label: "红组", color: "#e05a5a" },
      { id: "blue", label: "蓝组", color: "#3978d4" },
    ] }],
    selection_groups: [
      { id: "red", label: "红组", color: "#e05a5a" },
      { id: "blue", label: "蓝组", color: "#3978d4" },
    ],
  });
  assert.deepEqual(annotation.ui_elements[0].groups.map((group) => group.id), ["red", "blue"]);
  assert.equal(annotation.selection_groups.length, 2);
  const hitl = buildHitlUiChangePrompt("/workspace", annotation);
  assert.match(hitl, /不得修改 .env/);
  assert.match(hitl, /groups 数组/);
  assert.match(hitl, /交叉项/);
  assert.match(hitl, /untrusted_ui_annotation/);
  assert.match(hitl, /唯一可写的隔离工作区/);
  const routing = classifyHitlUiTask({ ...annotation, codeCandidates: [{ term: "save", match: "components/Save.tsx:12:save" }] });
  assert.equal(routing.key, "standard-ui");
  assert.deepEqual(routing.matched.candidateFiles, ["components/Save.tsx"]);
  assert.equal(fingerprintHitlUiAnnotation(annotation), fingerprintHitlUiAnnotation({ ...annotation }));
});

let tempRoot;
let workspace;

before(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "dsh-agent-test-"));
  workspace = path.join(tempRoot, "workspace");
  await mkdir(workspace);
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

test("workspace allowlist rejects directories outside configured roots", async () => {
  assert.equal(await resolveAllowedWorkspace(workspace, [tempRoot]), await realpath(workspace));
  await assert.rejects(resolveAllowedWorkspace(tmpdir(), [workspace]), (error) => error instanceof AgentServiceError && error.statusCode === 403);
});

async function waitForJob(baseUrl, id) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const payload = await fetch(`${baseUrl}/api/jobs/${id}`).then((response) => response.json());
    if (["succeeded", "failed"].includes(payload.job.status)) return payload.job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("job did not finish");
}

test("HTTP service queues read-only proposals and gated script writes", async () => {
  const calls = [];
  const runner = async (input) => {
    calls.push(input);
    return {
      rawOutput: '{"ok":true}', structuredOutput: { ok: true }, elapsedMs: 1,
      metrics: {
        usage: { inputTokens: 1000, cacheReadTokens: 2000, outputTokens: 300, reasoningTokens: 50 },
        modelSteps: 2, toolCalls: 3, modelRuns: 1,
        model: { provider: "deepseek-official", id: "deepseek-v4-flash", reasoningEffort: input.reasoningEffort || "off" },
      },
    };
  };
  const { server } = createAgentService({ workspaceRoots: [tempRoot], dshRoot: tempRoot, runner, jobStatePath: path.join(tempRoot, `jobs-${Date.now()}.json`) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
    assert.equal(health.provider, "deepseek-harness");

    const proposalResponse = await fetch(`${baseUrl}/api/test-proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace,
        trace: { ...sample, events: [...sample.events, { action: "change", inputType: "password", value: "remove-me" }] },
      }),
    });
    assert.equal(proposalResponse.status, 202);
    const proposalJob = await waitForJob(baseUrl, (await proposalResponse.json()).job.id);
    assert.equal(proposalJob.status, "succeeded");
    assert.equal(calls[0].permissionMode, "read-only");
    assert.ok(proposalJob.redactions.some((entry) => entry.reason === "sensitive-input"));

    const scriptResponse = await fetch(`${baseUrl}/api/test-scripts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, trace: sample, proposal: { confirmations: [] }, applyChanges: true }),
    });
    assert.equal(scriptResponse.status, 202);
    const scriptJob = await waitForJob(baseUrl, (await scriptResponse.json()).job.id);
    assert.equal(scriptJob.status, "succeeded");
    assert.equal(calls[1].permissionMode, "workspace-write");

    const hitlResponse = await fetch(`${baseUrl}/api/hitl-ui-changes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace,
        annotation: {
          id: "pq_example",
          question: "让保存按钮更明显",
          ui_elements: [{ selector: "#save", name: "保存" }],
          scene: { href: "http://127.0.0.1:3001/evaluation-console" },
        },
      }),
    });
    assert.equal(hitlResponse.status, 202);
    const hitlJob = await waitForJob(baseUrl, (await hitlResponse.json()).job.id);
    assert.equal(hitlJob.status, "succeeded");
    assert.equal(calls[2].kind, "hitl-ui-change");
    assert.equal(calls[2].permissionMode, "workspace-write");
    assert.equal(hitlJob.routing.key, "quick-ui");
    assert.equal(calls[2].reasoningEffort, "off");
    assert.equal(calls[2].timeoutMs, 480000);
    assert.equal(hitlJob.metrics.usage.cacheReadTokens, 2000);
    assert.equal(hitlJob.metrics.toolCalls, 3);
    assert.ok(hitlJob.costEstimate.amount > 0);
    assert.ok(hitlJob.decisionTrace.some((item) => item.phase === "classification"));

    const duplicateResponse = await fetch(`${baseUrl}/api/hitl-ui-changes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace,
        annotation: {
          id: "pq_example",
          question: "让保存按钮更明显",
          ui_elements: [{ selector: "#save", name: "保存" }],
          scene: { href: "http://127.0.0.1:3001/evaluation-console" },
        },
      }),
    });
    assert.equal(duplicateResponse.status, 200);
    const duplicatePayload = await duplicateResponse.json();
    assert.equal(duplicatePayload.deduplicated, true);
    assert.equal(duplicatePayload.job.id, hitlJob.id);
    assert.equal(calls.length, 3);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("write tasks reuse a bounded Git worktree slot and preserve their commits as refs", async () => {
  const isolatedRoot = await mkdtemp(path.join(tmpdir(), "dsh-agent-pool-test-"));
  const repository = path.join(isolatedRoot, "repository");
  const sessionRoot = path.join(isolatedRoot, "sessions");
  await mkdir(repository);
  await writeFile(path.join(repository, "screen.txt"), "baseline\n");
  await exec("git", ["init"], { cwd: repository });
  await exec("git", ["config", "user.name", "Test"], { cwd: repository });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: repository });
  await exec("git", ["add", "screen.txt"], { cwd: repository });
  await exec("git", ["commit", "-m", "baseline"], { cwd: repository });
  let run = 0;
  const runner = async (input) => {
    run += 1;
    await writeFile(path.join(input.workspace, "screen.txt"), `change ${run}\n`);
    return {
      rawOutput: '{"summary":"ok","filesChanged":["screen.txt"],"verification":[],"remainingUnknowns":[]}',
      structuredOutput: { summary: "ok", filesChanged: ["screen.txt"], verification: [], remainingUnknowns: [] },
      elapsedMs: 1,
    };
  };
  const { server } = createAgentService({
    workspaceRoots: [isolatedRoot], dshRoot: isolatedRoot, runner,
    isolateWrites: true, prepareDependencies: false, maxConcurrent: 2, sessionPoolSize: 1, sessionRoot,
    jobStatePath: path.join(isolatedRoot, "jobs.json"),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const submit = (id) => fetch(`${baseUrl}/api/hitl-ui-changes`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace: repository, annotation: { id, question: `修改界面 ${id}`, ui_elements: [{ selector: "#screen", name: "界面" }] } }),
  }).then((response) => response.json());
  try {
    const firstSubmission = await submit("pq_pool_first");
    const first = await waitForJob(baseUrl, firstSubmission.job.id);
    assert.equal(first.status, "succeeded");
    assert.equal(first.workspaceReuse.slotId, "slot-1");
    assert.equal(first.workspaceReuse.worktreeReused, false);
    assert.match(first.taskRef, /^refs\/dsh\/jobs\//);
    assert.equal(run, 1, first.error);
    assert.equal((await readFile(path.join(repository, "screen.txt"), "utf8")), "change 1\n");

    const secondSubmission = await submit("pq_pool_second");
    const second = await waitForJob(baseUrl, secondSubmission.job.id);
    assert.equal(second.status, "succeeded", second.error);
    assert.equal(second.workspaceReuse.slotId, "slot-1");
    assert.equal(second.workspaceReuse.worktreeReused, true);
    assert.equal((await readFile(path.join(repository, "screen.txt"), "utf8")), "change 2\n");
    const { stdout } = await exec("git", ["show-ref", "--verify", second.taskRef], { cwd: repository });
    assert.match(stdout, new RegExp(second.taskCommit));
    const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
    assert.deepEqual(health.sessionPool, { size: 1, busy: 0, ready: 1 });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await exec("git", ["worktree", "remove", "--force", path.join(sessionRoot, "pool", "slot-1")], { cwd: repository }).catch(() => {});
    await rm(isolatedRoot, { recursive: true, force: true });
  }
});

test("queued HITL jobs pause and resume without creating a second task", async () => {
  let releaseFirst;
  let callCount = 0;
  const runner = async () => {
    callCount += 1;
    if (callCount === 1) await new Promise((resolve) => { releaseFirst = resolve; });
    return { rawOutput: '{"summary":"ok","filesChanged":[],"verification":[],"remainingUnknowns":[]}', structuredOutput: { summary: "ok", filesChanged: [], verification: [], remainingUnknowns: [] }, elapsedMs: 1 };
  };
  const { server } = createAgentService({ workspaceRoots: [tempRoot], dshRoot: tempRoot, runner, maxConcurrent: 1, jobStatePath: path.join(tempRoot, `jobs-actions-${Date.now()}.json`) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const submit = (id, question) => fetch(`${baseUrl}/api/hitl-ui-changes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace, annotation: { id, question, ui_elements: [{ selector: `#${id}`, name: id }] } }),
  }).then((response) => response.json());
  try {
    const first = await submit("pq_blocker", "修改第一个按钮");
    const second = await submit("pq_paused", "修改第二个按钮");
    const pause = await fetch(`${baseUrl}/api/jobs/${second.job.id}/actions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "pause" }),
    });
    assert.equal(pause.status, 200);
    assert.equal((await pause.json()).job.status, "paused");
    const resume = await fetch(`${baseUrl}/api/jobs/${second.job.id}/actions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "resume", question: "修改第二个按钮并保留原任务" }),
    });
    assert.equal(resume.status, 202);
    assert.equal((await resume.json()).job.id, second.job.id);
    releaseFirst();
    assert.equal((await waitForJob(baseUrl, first.job.id)).status, "succeeded");
    const resumed = await waitForJob(baseUrl, second.job.id);
    assert.equal(resumed.status, "succeeded");
    assert.equal(resumed.question, "修改第二个按钮并保留原任务");
    assert.ok(resumed.decisionTrace.some((item) => item.text.includes("没有创建新的任务记录")));
  } finally {
    releaseFirst?.();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("failed HITL jobs retry with the same id and preserve the prior run", async () => {
  let callCount = 0;
  const runner = async () => {
    callCount += 1;
    if (callCount === 1) throw new Error("first run failed");
    return { rawOutput: '{"summary":"ok","filesChanged":[],"verification":[],"remainingUnknowns":[]}', structuredOutput: { summary: "ok", filesChanged: [], verification: [], remainingUnknowns: [] }, elapsedMs: 1 };
  };
  const { server } = createAgentService({ workspaceRoots: [tempRoot], dshRoot: tempRoot, runner, jobStatePath: path.join(tempRoot, `jobs-retry-${Date.now()}.json`) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const submitted = await fetch(`${baseUrl}/api/hitl-ui-changes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, annotation: { id: "pq_retry", question: "修改失败后重试", ui_elements: [{ selector: "#retry", name: "重试" }] } }),
    }).then((response) => response.json());
    assert.equal((await waitForJob(baseUrl, submitted.job.id)).status, "failed");
    const retried = await fetch(`${baseUrl}/api/jobs/${submitted.job.id}/actions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "retry" }),
    });
    assert.equal(retried.status, 202);
    assert.equal((await retried.json()).job.id, submitted.job.id);
    const completed = await waitForJob(baseUrl, submitted.job.id);
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.runNumber, 2);
    assert.equal(completed.priorRuns[0].status, "failed");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
