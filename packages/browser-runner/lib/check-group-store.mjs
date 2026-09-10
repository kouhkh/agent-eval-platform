import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { BrowserRunnerError } from "./operation-budget.mjs";

const MAX_GROUPS = 100;
const MAX_NAME_LENGTH = 80;
const MAX_CHECKS = 10_000;
const MAX_TARGET_URL_LENGTH = 512;
const MAX_PROBE_ELAPSED_MS = 60_000;
const START_MODES = new Set(["codex_session", "dsh_process", "managed_script"]);

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function layoutError(code, message) { return new BrowserRunnerError(code, message, { statusCode: 422, phase: "check-groups" }); }
function text(value) { return typeof value === "string" ? value.trim() : ""; }

function normalizeId(value, label) {
  const id = text(value);
  if (!id || id.length > 200) throw layoutError("CHECK_GROUP_INVALID_ID", `${label} 缺少有效标识。`);
  return id;
}

function normalizeTargetUrl(value, label) {
  const raw = text(value);
  if (!raw) return null;
  if (raw.length > MAX_TARGET_URL_LENGTH) throw layoutError("CHECK_GROUP_INVALID_TARGET", `${label}的目标地址不能超过 ${MAX_TARGET_URL_LENGTH} 个字符。`);
  let parsed;
  try { parsed = new URL(raw); }
  catch { throw layoutError("CHECK_GROUP_INVALID_TARGET", `${label}的目标地址必须是完整的 http(s) 地址。`); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw layoutError("CHECK_GROUP_INVALID_TARGET", `${label}的目标地址只能是无凭据、无查询参数的 http(s) 基础地址。`);
  }
  return parsed.href.replace(/\/$/, "");
}

function normalizeLastProbe(value, label) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw layoutError("CHECK_GROUP_INVALID_PROBE", `${label}的探活记录格式无效。`);
  const status = text(value.status);
  if (!["online", "offline", "error", "unknown"].includes(status)) throw layoutError("CHECK_GROUP_INVALID_PROBE", `${label}的探活状态无效。`);
  const checkedAt = text(value.checkedAt);
  if (!checkedAt || Number.isNaN(Date.parse(checkedAt))) throw layoutError("CHECK_GROUP_INVALID_PROBE", `${label}缺少有效探活时间。`);
  const elapsedMs = Number(value.elapsedMs);
  if (!Number.isInteger(elapsedMs) || elapsedMs < 0 || elapsedMs > MAX_PROBE_ELAPSED_MS) throw layoutError("CHECK_GROUP_INVALID_PROBE", `${label}的探活耗时无效。`);
  const httpStatus = value.httpStatus == null ? null : Number(value.httpStatus);
  if (httpStatus !== null && (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) throw layoutError("CHECK_GROUP_INVALID_PROBE", `${label}的 HTTP 状态无效。`);
  const errorCode = value.errorCode == null ? null : text(value.errorCode);
  if (errorCode !== null && (!errorCode || errorCode.length > 100)) throw layoutError("CHECK_GROUP_INVALID_PROBE", `${label}的错误码无效。`);
  return { status, checkedAt: new Date(checkedAt).toISOString(), elapsedMs, httpStatus, errorCode };
}

function normalizeStartRequest(value, label) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw layoutError("CHECK_GROUP_INVALID_START_REQUEST", `${label}的启动协助请求格式无效。`);
  const mode = text(value.mode);
  if (!START_MODES.has(mode)) throw layoutError("CHECK_GROUP_INVALID_START_MODE", `${label}的启动方式无效。`);
  const status = text(value.status);
  if (!["pending", "blocked", "completed", "cleared"].includes(status)) throw layoutError("CHECK_GROUP_INVALID_START_STATUS", `${label}的启动协助状态无效。`);
  const requestedAt = text(value.requestedAt);
  if (!requestedAt || Number.isNaN(Date.parse(requestedAt))) throw layoutError("CHECK_GROUP_INVALID_START_REQUEST", `${label}缺少有效请求时间。`);
  const reason = value.reason == null ? null : text(value.reason);
  if (reason !== null && reason.length > 500) throw layoutError("CHECK_GROUP_INVALID_START_REQUEST", `${label}的说明过长。`);
  return { mode, status, requestedAt: new Date(requestedAt).toISOString(), reason };
}

function normalizeLayout(input, checkIds) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw layoutError("CHECK_GROUP_INVALID_LAYOUT", "分组布局必须是 JSON 对象。");
  const groups = Array.isArray(input.groups) ? input.groups : null;
  const ungroupedCheckIds = Array.isArray(input.ungroupedCheckIds) ? input.ungroupedCheckIds : null;
  if (!groups || !ungroupedCheckIds) throw layoutError("CHECK_GROUP_INVALID_LAYOUT", "分组布局必须包含 groups 和 ungroupedCheckIds 数组。");
  if (groups.length > MAX_GROUPS) throw layoutError("CHECK_GROUP_TOO_MANY", `最多只能保存 ${MAX_GROUPS} 个分组。`);
  const allowed = new Set(checkIds);
  const seenGroups = new Set();
  const seenChecks = new Set();
  const normalizedGroups = groups.map((group, index) => {
    if (!group || typeof group !== "object" || Array.isArray(group)) throw layoutError("CHECK_GROUP_INVALID_GROUP", `第 ${index + 1} 个分组格式无效。`);
    const id = normalizeId(group.id, `第 ${index + 1} 个分组`);
    if (seenGroups.has(id)) throw layoutError("CHECK_GROUP_DUPLICATE_ID", "分组标识不能重复。");
    seenGroups.add(id);
    const name = text(group.name);
    if (!name || name.length > MAX_NAME_LENGTH) throw layoutError("CHECK_GROUP_INVALID_NAME", `分组名称不能为空且不能超过 ${MAX_NAME_LENGTH} 个字符。`);
    if (!Array.isArray(group.checkIds)) throw layoutError("CHECK_GROUP_INVALID_CHECKS", `分组“${name}”缺少检查项顺序。`);
    return {
      id,
      name,
      targetUrl: normalizeTargetUrl(group.targetUrl, `分组“${name}”`),
      collapsed: group.collapsed === true,
      lastProbe: normalizeLastProbe(group.lastProbe, `分组“${name}”`),
      startRequest: normalizeStartRequest(group.startRequest, `分组“${name}”`),
      checkIds: group.checkIds.map((value) => normalizeId(value, `分组“${name}”中的检查项`)),
    };
  });
  const normalizedUngrouped = ungroupedCheckIds.map((value) => normalizeId(value, "未分组检查项"));
  for (const checkId of [...normalizedGroups.flatMap((group) => group.checkIds), ...normalizedUngrouped]) {
    if (!allowed.has(checkId)) throw layoutError("CHECK_GROUP_UNKNOWN_CHECK", `检查项“${checkId}”不属于当前控制台。`);
    if (seenChecks.has(checkId)) throw layoutError("CHECK_GROUP_DUPLICATE_CHECK", `检查项“${checkId}”不能同时出现在多个位置。`);
    seenChecks.add(checkId);
  }
  if (allowed.size > MAX_CHECKS) throw layoutError("CHECK_GROUP_TOO_MANY_CHECKS", "当前检查项数量超过布局限制。");
  if (seenChecks.size !== allowed.size) throw layoutError("CHECK_GROUP_MISSING_CHECK", "每一个当前检查项必须恰好出现在一个分组或未分组区域。");
  return { schemaVersion: 2, groups: normalizedGroups, ungroupedCheckIds: normalizedUngrouped };
}

function defaultLayout(checkIds) { return { schemaVersion: 2, groups: [], ungroupedCheckIds: [...checkIds] }; }

export class CheckGroupStore {
  constructor(options = {}) {
    this.statePath = path.resolve(options.statePath || path.join(process.cwd(), "data", "check-groups.json"));
    this.persistChain = Promise.resolve();
  }

  async readRaw() {
    try { return JSON.parse(await readFile(this.statePath, "utf8")); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }

  async readLayout(ids) {
    const saved = await this.readRaw();
    if (!saved) return defaultLayout(ids);
    try { return normalizeLayout(saved, ids); }
    catch (error) {
      if (!(error instanceof BrowserRunnerError)) throw error;
      // Assets can legitimately disappear when an adapter is retired. Preserve all still-known
      // grouping choices and append newly discovered assets to the ungrouped area.
      const allowed = new Set(ids);
      const groups = Array.isArray(saved.groups) ? saved.groups.map((group) => ({ ...group, checkIds: Array.isArray(group?.checkIds) ? group.checkIds.filter((id) => allowed.has(id)) : [] })) : [];
      const grouped = new Set(groups.flatMap((group) => group.checkIds));
      const savedUngrouped = Array.isArray(saved.ungroupedCheckIds) ? saved.ungroupedCheckIds.filter((id) => allowed.has(id) && !grouped.has(id)) : [];
      return normalizeLayout({ groups, ungroupedCheckIds: [...savedUngrouped, ...ids.filter((id) => !grouped.has(id) && !savedUngrouped.includes(id))] }, ids);
    }
  }

  async writeLayout(layout) {
    await mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.statePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(layout, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.statePath);
  }

  async get(checkIds) {
    const ids = [...new Set(checkIds.map((value) => normalizeId(value, "检查项")))];
    await this.persistChain.catch(() => {});
    return clone(await this.readLayout(ids));
  }

  async replace(input, checkIds) {
    const layout = normalizeLayout(input, checkIds);
    this.persistChain = this.persistChain.catch(() => {}).then(async () => {
      await this.writeLayout(layout);
    });
    await this.persistChain;
    return clone(layout);
  }

  async recordProbe(groupId, probe, checkIds) {
    const ids = [...new Set(checkIds.map((value) => normalizeId(value, "检查项")))];
    const id = normalizeId(groupId, "分组");
    const lastProbe = normalizeLastProbe(probe, "探活记录");
    let result;
    this.persistChain = this.persistChain.catch(() => {}).then(async () => {
      const layout = await this.readLayout(ids);
      const group = layout.groups.find((item) => item.id === id);
      if (!group) throw new BrowserRunnerError("CHECK_GROUP_NOT_FOUND", "没有对应的分组。", { statusCode: 404, phase: "check-groups" });
      group.lastProbe = lastProbe;
      const normalized = normalizeLayout(layout, ids);
      await this.writeLayout(normalized);
      result = clone(normalized);
    });
    await this.persistChain;
    return result;
  }

  async requestStart(groupId, mode, checkIds) {
    const ids = [...new Set(checkIds.map((value) => normalizeId(value, "检查项")))];
    const id = normalizeId(groupId, "分组");
    const normalizedMode = text(mode);
    if (!START_MODES.has(normalizedMode)) throw layoutError("CHECK_GROUP_INVALID_START_MODE", "启动协助方式只能是 Codex、DSH 或已登记脚本。");
    let result;
    this.persistChain = this.persistChain.catch(() => {}).then(async () => {
      const layout = await this.readLayout(ids);
      const group = layout.groups.find((item) => item.id === id);
      if (!group) throw new BrowserRunnerError("CHECK_GROUP_NOT_FOUND", "没有对应的分组。", { statusCode: 404, phase: "check-groups" });
      const reasons = {
        codex_session: "等待桌面侧消费者创建 Codex 会话；控制台不会自行创建会话。",
        dsh_process: "等待配置 DSH bridge；控制台不会自行启动 DSH 进程。",
        managed_script: "未登记可运行的固定脚本 ID；控制台不会接收或执行 shell 命令。",
      };
      group.startRequest = { mode: normalizedMode, status: normalizedMode === "managed_script" ? "blocked" : "pending", requestedAt: new Date().toISOString(), reason: reasons[normalizedMode] };
      const normalized = normalizeLayout(layout, ids);
      await this.writeLayout(normalized);
      result = clone(normalized);
    });
    await this.persistChain;
    return result;
  }

  async clearStartRequest(groupId, checkIds) {
    const ids = [...new Set(checkIds.map((value) => normalizeId(value, "检查项")))];
    const id = normalizeId(groupId, "分组");
    let result;
    this.persistChain = this.persistChain.catch(() => {}).then(async () => {
      const layout = await this.readLayout(ids);
      const group = layout.groups.find((item) => item.id === id);
      if (!group) throw new BrowserRunnerError("CHECK_GROUP_NOT_FOUND", "没有对应的分组。", { statusCode: 404, phase: "check-groups" });
      group.startRequest = null;
      const normalized = normalizeLayout(layout, ids);
      await this.writeLayout(normalized);
      result = clone(normalized);
    });
    await this.persistChain;
    return result;
  }
}
