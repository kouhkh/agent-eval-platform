import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function sanitizeUrl(input) {
  try {
    const value = new URL(String(input));
    return `${value.origin}${value.pathname}`;
  } catch {
    return String(input || "").slice(0, 1000);
  }
}

function safePart(value, fallback = "item") {
  const text = String(value || fallback).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 100);
  return text || fallback;
}

function redactText(value) {
  return String(value || "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/([?&](?:token|access_token|api_key|apikey|secret|password)=)[^&]*/gi, "$1<redacted>")
    .slice(0, 5000);
}

const SENSITIVE_KEY = /(password|passwd|pwd|token|secret|api[-_]?key|authorization|cookie|localstorage|session|credential|private[-_]?key|headers?|postdata)/i;

function sanitizeValue(value, key = "", parent = null) {
  if (SENSITIVE_KEY.test(key)) return "<redacted:sensitive>";
  if (key === "value" && parent && /password|email|tel/i.test(String(parent.inputType || parent.type || ""))) return "<redacted:input>";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => sanitizeValue(item, "", value));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 300).map(([childKey, childValue]) => [childKey, sanitizeValue(childValue, childKey, value)]));
  return value;
}

function sanitizeNetwork(items) {
  return (Array.isArray(items) ? items : []).slice(-500).map((item) => ({
    method: String(item?.method || "GET").slice(0, 16),
    url: sanitizeUrl(item?.url),
    resourceType: String(item?.resourceType || "").slice(0, 32),
    status: Number.isInteger(item?.status) ? item.status : null,
    failed: item?.failed === true,
  }));
}

export class EvidenceStore {
  constructor(options = {}) {
    this.root = path.resolve(options.root || path.join(process.cwd(), "data", "evidence"));
  }

  operationDirectory(sessionId, operationId) {
    return path.join(this.root, safePart(sessionId, "session"), safePart(operationId, "operation"));
  }

  async begin(meta) {
    const directory = this.operationDirectory(meta.sessionId, meta.operationId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.writeJson(meta.sessionId, meta.operationId, "operation", {
      operationId: meta.operationId,
      sessionId: meta.sessionId,
      tabId: meta.tabId,
      kind: meta.kind,
      startedAt: meta.startedAt,
      request: sanitizeValue(meta.request || null),
      environment: sanitizeValue(meta.environment || null),
      codeRevision: meta.codeRevision || null,
    });
    return `evidence://${safePart(meta.sessionId)}/${safePart(meta.operationId)}`;
  }

  async writeJson(sessionId, operationId, name, value) {
    const directory = this.operationDirectory(sessionId, operationId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = `${safePart(name, "artifact")}.json`;
    const sanitized = sanitizeValue(value);
    await writeFile(path.join(directory, filename), `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 });
    return `evidence://${safePart(sessionId)}/${safePart(operationId)}/${filename}`;
  }

  async writeText(sessionId, operationId, name, value) {
    const directory = this.operationDirectory(sessionId, operationId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = safePart(name, "artifact");
    await writeFile(path.join(directory, filename), redactText(value), { mode: 0o600 });
    return `evidence://${safePart(sessionId)}/${safePart(operationId)}/${filename}`;
  }

  async writeBuffer(sessionId, operationId, name, buffer, extension = "bin") {
    const directory = this.operationDirectory(sessionId, operationId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = `${safePart(name, "artifact")}.${safePart(extension, "bin")}`;
    await writeFile(path.join(directory, filename), buffer, { mode: 0o600 });
    const digest = createHash("sha256").update(buffer).digest("hex");
    return { ref: `evidence://${safePart(sessionId)}/${safePart(operationId)}/${filename}`, sha256: digest, bytes: buffer.length };
  }

  async saveOperationResult(sessionId, operationId, result) {
    const refs = [];
    if (result?.domSnapshot) refs.push(await this.writeJson(sessionId, operationId, "dom-snapshot", result.domSnapshot));
    if (result?.network) refs.push(await this.writeJson(sessionId, operationId, "network", sanitizeNetwork(result.network)));
    if (result?.screenshotBuffer) {
      const saved = await this.writeBuffer(sessionId, operationId, "screenshot", result.screenshotBuffer, "png");
      refs.push(saved.ref);
    }
    const publicResult = { ...result };
    delete publicResult.screenshotBuffer;
    delete publicResult.domSnapshot;
    delete publicResult.network;
    refs.push(await this.writeJson(sessionId, operationId, "result", publicResult));
    return refs;
  }

  async saveTrace(sessionId, operationId, tracePath) {
    const directory = this.operationDirectory(sessionId, operationId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const buffer = await readFile(tracePath);
    const saved = await this.writeBuffer(sessionId, operationId, "trace", buffer, "zip");
    return saved;
  }
}
