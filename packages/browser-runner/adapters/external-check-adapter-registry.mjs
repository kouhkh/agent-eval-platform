import { BrowserRunnerError } from "../lib/operation-budget.mjs";

function fail(code, message, details) {
  throw new BrowserRunnerError(code, message, { statusCode: 500, phase: "check-adapter-registry", details });
}

function normalizeEntries(entries) {
  const routes = new Map();
  const normalized = (entries || []).map((entry) => ({
    id: String(entry?.id || "").trim(),
    adapter: entry?.adapter,
    executorIds: [...new Set((entry?.executorIds || []).map((value) => String(value).trim()).filter(Boolean))],
  }));
  for (const entry of normalized) {
    if (!entry.id || !entry.adapter || typeof entry.adapter.load !== "function" || typeof entry.adapter.execute !== "function") {
      fail("CHECK_ADAPTER_INVALID", "外部检查适配器必须提供稳定 id、load 和 execute。", { adapterId: entry.id || null });
    }
    if (!entry.executorIds.length) fail("CHECK_ADAPTER_EXECUTORS_MISSING", "外部检查适配器必须声明允许的 executor id。", { adapterId: entry.id });
    for (const executorId of entry.executorIds) {
      if (routes.has(executorId)) fail("CHECK_EXECUTOR_DUPLICATE", "同一个 executor id 只能由一个外部检查适配器处理。", { executorId, adapterIds: [routes.get(executorId).id, entry.id] });
      routes.set(executorId, entry);
    }
  }
  return { entries: normalized, routes };
}

/**
 * Combines independently owned external-check adapters without turning the
 * control plane into a business-specific command dispatcher. Assets keep their
 * own metadata/history; only explicitly registered executor ids may run.
 */
export function createExternalCheckAdapterRegistry(options = {}) {
  const { entries, routes } = normalizeEntries(options.adapters);
  return {
    async load() {
      const assets = [];
      const history = {};
      const assetOwners = new Map();
      for (const entry of entries) {
        const loaded = await entry.adapter.load();
        for (const asset of loaded?.assets || []) {
          const id = String(asset?.id || "").trim();
          const executorId = String(asset?.executor?.id || "").trim();
          if (!id) fail("CHECK_ASSET_ID_MISSING", "外部检查资产缺少稳定 id。", { adapterId: entry.id });
          if (assetOwners.has(id)) fail("CHECK_ASSET_DUPLICATE", "外部检查资产 id 在多个适配器中重复。", { assetId: id, adapterIds: [assetOwners.get(id), entry.id] });
          if (!executorId || !routes.has(executorId)) fail("CHECK_ASSET_EXECUTOR_UNREGISTERED", "外部检查资产引用了未注册的 executor id。", { assetId: id, executorId: executorId || null });
          if (routes.get(executorId) !== entry) fail("CHECK_ASSET_EXECUTOR_OWNER_MISMATCH", "外部检查资产的 executor 必须由同一适配器注册。", { assetId: id, executorId, adapterId: entry.id, executorOwner: routes.get(executorId).id });
          assetOwners.set(id, entry.id);
          assets.push(asset);
          history[id] = Array.isArray(loaded?.history?.[id]) ? loaded.history[id] : [];
        }
      }
      return { assets, history };
    },
    async execute(executor, hooks) {
      const executorId = String(executor?.id || "").trim();
      const entry = routes.get(executorId);
      if (!entry) throw new BrowserRunnerError("EXECUTOR_NOT_ALLOWED", "该外部检查 executor 未注册。", { statusCode: 422, phase: "check-control", details: { executorId: executorId || null } });
      return entry.adapter.execute(executor, hooks);
    },
  };
}
