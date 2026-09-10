import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { BrowserRunnerError } from "./operation-budget.mjs";

const MAX_GROUPS = 100;
const MAX_NAME_LENGTH = 80;
const MAX_CHECKS = 10_000;

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function layoutError(code, message) { return new BrowserRunnerError(code, message, { statusCode: 422, phase: "check-groups" }); }
function text(value) { return typeof value === "string" ? value.trim() : ""; }

function normalizeId(value, label) {
  const id = text(value);
  if (!id || id.length > 200) throw layoutError("CHECK_GROUP_INVALID_ID", `${label} 缺少有效标识。`);
  return id;
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
    return { id, name, checkIds: group.checkIds.map((value) => normalizeId(value, `分组“${name}”中的检查项`)) };
  });
  const normalizedUngrouped = ungroupedCheckIds.map((value) => normalizeId(value, "未分组检查项"));
  for (const checkId of [...normalizedGroups.flatMap((group) => group.checkIds), ...normalizedUngrouped]) {
    if (!allowed.has(checkId)) throw layoutError("CHECK_GROUP_UNKNOWN_CHECK", `检查项“${checkId}”不属于当前控制台。`);
    if (seenChecks.has(checkId)) throw layoutError("CHECK_GROUP_DUPLICATE_CHECK", `检查项“${checkId}”不能同时出现在多个位置。`);
    seenChecks.add(checkId);
  }
  if (allowed.size > MAX_CHECKS) throw layoutError("CHECK_GROUP_TOO_MANY_CHECKS", "当前检查项数量超过布局限制。");
  if (seenChecks.size !== allowed.size) throw layoutError("CHECK_GROUP_MISSING_CHECK", "每一个当前检查项必须恰好出现在一个分组或未分组区域。");
  return { schemaVersion: 1, groups: normalizedGroups, ungroupedCheckIds: normalizedUngrouped };
}

function defaultLayout(checkIds) { return { schemaVersion: 1, groups: [], ungroupedCheckIds: [...checkIds] }; }

export class CheckGroupStore {
  constructor(options = {}) {
    this.statePath = path.resolve(options.statePath || path.join(process.cwd(), "data", "check-groups.json"));
    this.persistChain = Promise.resolve();
  }

  async readRaw() {
    try { return JSON.parse(await readFile(this.statePath, "utf8")); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }

  async get(checkIds) {
    const ids = [...new Set(checkIds.map((value) => normalizeId(value, "检查项")))];
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

  async replace(input, checkIds) {
    const layout = normalizeLayout(input, checkIds);
    this.persistChain = this.persistChain.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.statePath}.tmp`;
      await writeFile(tmp, `${JSON.stringify(layout, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, this.statePath);
    });
    await this.persistChain;
    return clone(layout);
  }
}
