import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createExternalCheckAdapterRegistry } from "../adapters/external-check-adapter-registry.mjs";
import { fixedRegressionAdapters } from "../lib/fixed-regression-adapters.mjs";
import { createBrowserService } from "../server.mjs";

const port = Number(process.env.PORT || 4321);
const host = process.env.HOST || "127.0.0.1";
const dataRoot = path.resolve(process.env.AGENT_EVAL_DATA_ROOT || new URL("../data", import.meta.url).pathname);
await mkdir(dataRoot, { recursive: true, mode: 0o700 });
const runtimeEnv = { ...process.env };
if (process.env.PLANORA_BENCHMARK_AUTH_FILE) {
  const auth = JSON.parse(await readFile(process.env.PLANORA_BENCHMARK_AUTH_FILE, "utf8"));
  if (!auth.username || !auth.password) throw new Error("PLANORA_BENCHMARK_AUTH_FILE must contain username and password");
  runtimeEnv.EVAL_PLANORA_USERNAME = auth.username;
  runtimeEnv.EVAL_PLANORA_PASSWORD = auth.password;
}
const proposalPreset = process.env.AGENT_EVAL_PROPOSAL_TRACE_PATH && process.env.AGENT_EVAL_PROPOSAL_WORKSPACE ? async () => {
  const packet = JSON.parse(await readFile(process.env.AGENT_EVAL_PROPOSAL_TRACE_PATH, "utf8"));
  return {
    workspace: process.env.AGENT_EVAL_PROPOSAL_WORKSPACE,
    trace: {
      title: "Planora 正文保存与切章轨迹",
      goal: "识别可形成上线门禁、夜间回归或仍需人工确认的测试提案",
      environment: "local-dev",
      recordedAt: new Date().toISOString(),
      durationMs: 0,
      events: packet.events,
      notes: packet.caveats || [],
    },
    context: { source: path.basename(path.dirname(process.env.AGENT_EVAL_PROPOSAL_TRACE_PATH)), packetDigest: packet.packetDigest, sourceRevision: packet.evidence?.find((item) => item?.revision)?.revision || null, mode: "read-only proposal only; do not generate or apply scripts" },
  };
} : null;
const externalAdapters = fixedRegressionAdapters(process.env);
const externalCheckAdapter = createExternalCheckAdapterRegistry({ adapters: externalAdapters });
const groupStartPlans = process.env.AGENT_EVAL_GROUP_START_PLANS_PATH ? JSON.parse(await readFile(process.env.AGENT_EVAL_GROUP_START_PLANS_PATH, "utf8")) : [];
if (!Array.isArray(groupStartPlans)) throw new Error("AGENT_EVAL_GROUP_START_PLANS_PATH 必须指向启动计划数组 JSON 文件。");
const service = createBrowserService({ dataRoot, env: runtimeEnv, dshBridgeUrl: process.env.AGENT_EVAL_DSH_URL, pinAskUrl: process.env.AGENT_EVAL_PINASK_URL, hitlWorkspace: process.env.AGENT_EVAL_HITL_WORKSPACE, traceCatalogPath: process.env.AGENT_EVAL_TRACE_CATALOG_PATH, systemTraceManifestPath: process.env.AGENT_EVAL_SYSTEM_TRACE_MANIFEST_PATH, proposalPreset, groupStartPlans, headless: !/^(0|false|no)$/i.test(String(process.env.AGENT_EVAL_HEADLESS || "true")), externalCheckAdapter });
service.server.listen(port, host, () => console.log(`agent-eval fixed regression console listening on http://${host}:${port}`));
const shutdown = async () => { await service.manager.dispose(); await service.runner.close().catch(() => {}); service.server.close(() => process.exit(0)); };
process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
