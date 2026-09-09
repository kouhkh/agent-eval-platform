import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createPlanoraFixedRegressionAdapter } from "../adapters/planora-fixed-regression.mjs";
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
const service = createBrowserService({ dataRoot, env: runtimeEnv, headless: !/^(0|false|no)$/i.test(String(process.env.AGENT_EVAL_HEADLESS || "true")), externalCheckAdapter: createPlanoraFixedRegressionAdapter() });
service.server.listen(port, host, () => console.log(`agent-eval fixed regression console listening on http://${host}:${port}`));
const shutdown = async () => { await service.manager.dispose(); await service.runner.close().catch(() => {}); service.server.close(() => process.exit(0)); };
process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
