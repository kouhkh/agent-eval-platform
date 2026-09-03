import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const jobsPath = path.resolve(process.env.DSH_AGENT_JOB_STATE_PATH || path.join(root, "data", "jobs.json"));
const sessionRoot = path.resolve(process.env.DSH_AGENT_SESSION_ROOT || path.join(root, "data", "sessions"));
const apply = process.argv.includes("--apply");

function git(workspace, args) {
  const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${String(result.stderr || result.stdout).trim()}`);
  return String(result.stdout || "").trim();
}

function worktrees(workspace) {
  const rows = git(workspace, ["worktree", "list", "--porcelain"]).split(/\n\n+/);
  return rows.map((row) => {
    const fields = Object.fromEntries(row.split("\n").map((line) => {
      const separator = line.indexOf(" ");
      return separator < 0 ? [line, true] : [line.slice(0, separator), line.slice(separator + 1)];
    }));
    return { directory: fields.worktree ? path.resolve(String(fields.worktree)) : "", head: String(fields.HEAD || "") };
  }).filter((row) => row.directory && row.head);
}

function isLegacySession(directory) {
  const relative = path.relative(sessionRoot, directory);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) && !relative.startsWith(`pool${path.sep}`);
}

if (!existsSync(jobsPath)) throw new Error(`任务状态文件不存在：${jobsPath}`);
const state = JSON.parse(readFileSync(jobsPath, "utf8"));
const jobs = Array.isArray(state.jobs) ? state.jobs : [];
const active = jobs.filter((job) => ["queued", "running"].includes(job.status));
if (active.length) throw new Error(`仍有 ${active.length} 个排队或运行任务，拒绝归档。`);

const byId = new Map(jobs.map((job) => [job.id, job]));
const repositories = [...new Set(jobs.map((job) => job.workspace).filter(Boolean).map((value) => path.resolve(value)))].filter(existsSync);
const candidates = [];
for (const repository of repositories) {
  for (const item of worktrees(repository)) {
    if (!isLegacySession(item.directory)) continue;
    const jobId = path.basename(item.directory).slice(0, 36);
    const job = byId.get(jobId);
    const runNumber = job?.runNumber || 1;
    const exactRun = job?.taskCommit === item.head;
    const ref = exactRun
      ? `refs/dsh/jobs/${jobId}/run-${runNumber}`
      : `refs/dsh/jobs/${jobId || "unknown"}/legacy-${item.head.slice(0, 12)}`;
    candidates.push({ repository, ...item, jobId, ref, exactRun });
  }
}

if (apply) {
  const archivedAt = new Date().toISOString();
  for (const item of candidates) {
    git(item.repository, ["cat-file", "-e", `${item.head}^{commit}`]);
    git(item.repository, ["update-ref", item.ref, item.head]);
  }
  for (const item of candidates) git(item.repository, ["worktree", "remove", "--force", item.directory]);
  for (const job of jobs) {
    const related = candidates.filter((item) => item.jobId === job.id);
    if (!related.length) continue;
    job.archivedSessionRefs = [...new Set([...(job.archivedSessionRefs || []), ...related.map((item) => item.ref)])];
    job.sessionArchivedAt = archivedAt;
    if (job.sessionWorkspace && related.some((item) => path.resolve(job.sessionWorkspace) === item.directory)) delete job.sessionWorkspace;
    const exact = related.find((item) => item.exactRun);
    if (exact) job.taskRef = exact.ref;
  }
  const temporary = `${jobsPath}.archive.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...state, jobs }, null, 2), { mode: 0o600 });
  renameSync(temporary, jobsPath);
}

process.stdout.write(`${JSON.stringify({
  mode: apply ? "apply" : "dry-run",
  jobsPath,
  sessionRoot,
  candidateCount: candidates.length,
  refs: candidates.map(({ jobId, ref, head, directory }) => ({ jobId, ref, head, directory })),
}, null, 2)}\n`);
