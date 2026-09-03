import { BrowserRunnerError } from "./operation-budget.mjs";
import { attachRuntimeValue, resolveRuntimeValue, validateRuntimeValueRef } from "./runtime-values.mjs";

const SETUP_OPERATIONS = new Set(["navigate", "act", "assert"]);

function setupSteps(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object" && Array.isArray(input.steps)) return input.steps;
  if (input == null) return [];
  throw new BrowserRunnerError(
    "INVALID_SETUP_FIXTURE",
    "setup 必须是包含 steps 数组的对象。",
    { statusCode: 422, phase: "control-plane" },
  );
}

function normalizeOperationStep(step, index, options = {}) {
  const source = options.source || "steps";
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    throw new BrowserRunnerError(
      "INVALID_OPERATION_STEP",
      `${source}[${index}] 不是有效操作对象。`,
      { statusCode: 422, phase: "control-plane" },
    );
  }
  const operation = String(step.operation || options.defaultOperation || "").trim();
  if (!SETUP_OPERATIONS.has(operation)) {
    throw new BrowserRunnerError(
      "INVALID_OPERATION_STEP",
      `${source}[${index}] 的 operation 只能是 navigate、act 或 assert。`,
      { statusCode: 422, phase: "control-plane" },
    );
  }
  const normalized = { ...step, operation };
  if (operation === "act" && String(normalized.action || "click") === "fill") {
    const hasInlineValue = Object.prototype.hasOwnProperty.call(normalized, "value");
    if (hasInlineValue && normalized.valueFrom != null) {
      throw new BrowserRunnerError(
        "AMBIGUOUS_FILL_VALUE",
        `${source}[${index}] 的 fill 不能同时声明 value 和 valueFrom。`,
        { statusCode: 422, phase: "control-plane" },
      );
    }
    if (options.forbidInlineFill === true && hasInlineValue) {
      throw new BrowserRunnerError(
        "INLINE_SETUP_FILL_VALUE_FORBIDDEN",
        `${source}[${index}] 的 fill 不允许写入明文 value；请使用 valueFrom.env 或 valueFrom.secretRef。`,
        { statusCode: 422, phase: "control-plane" },
      );
    }
    if (normalized.valueFrom != null) validateRuntimeValueRef(normalized.valueFrom);
    else if (options.requireRuntimeFill === true) validateRuntimeValueRef(normalized.valueFrom);
  } else if (normalized.valueFrom != null) {
    throw new BrowserRunnerError(
      "RUNTIME_VALUE_REF_NOT_ALLOWED",
      `${source}[${index}] 只有 fill 动作可以使用 valueFrom。`,
      { statusCode: 422, phase: "control-plane" },
    );
  }
  return normalized;
}

export function normalizeSetup(input, existing = { steps: [] }) {
  if (input === undefined) return existing && Array.isArray(existing.steps) ? existing : { steps: [] };
  const steps = setupSteps(input);
  if (steps.length > 100) {
    throw new BrowserRunnerError(
      "SETUP_FIXTURE_TOO_LARGE",
      "setup fixture 最多允许 100 个操作。",
      { statusCode: 422, phase: "control-plane" },
    );
  }
  return {
    steps: steps.map((step, index) => normalizeOperationStep(step, index, {
      source: "setup.steps",
      forbidInlineFill: true,
      requireRuntimeFill: true,
    })),
  };
}

export function hasRuntimeSetupValues(setup) {
  return setupSteps(setup).some((step) => step?.operation === "act" && String(step.action || "click") === "fill" && step.valueFrom);
}

export function normalizeTestSteps(input, existing = []) {
  if (input === undefined) return Array.isArray(existing) ? existing : [];
  if (!Array.isArray(input)) {
    throw new BrowserRunnerError(
      "INVALID_TEST_STEPS",
      "steps 必须是数组。",
      { statusCode: 422, phase: "control-plane" },
    );
  }
  if (input.length > 200) {
    throw new BrowserRunnerError(
      "TEST_STEPS_TOO_LARGE",
      "steps 最多允许 200 个操作。",
      { statusCode: 422, phase: "control-plane" },
    );
  }
  return input.map((step, index) => normalizeOperationStep(step, index, {
    source: "steps",
    defaultOperation: "act",
  }));
}

export function hasRuntimeOperationValues(steps) {
  return (Array.isArray(steps) ? steps : []).some((step) => String(step?.operation || "act") === "act" && String(step?.action || "click") === "fill" && step.valueFrom);
}

export function resolveAssetUrl(value, baseUrl, field = "url") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text === "about:blank") return text;
  try {
    const resolved = new URL(text, baseUrl || undefined);
    if (!/^https?:$/.test(resolved.protocol) || resolved.username || resolved.password) throw new Error("unsupported URL");
    return resolved.href;
  } catch {
    throw new BrowserRunnerError(
      "INVALID_ASSET_URL",
      `${field} 不是有效 URL，相对路径必须配合 environment.baseUrl 使用。`,
      { statusCode: 422, phase: "setup" },
    );
  }
}

export function normalizeEnvironment(input, existing = {}) {
  const source = input === undefined ? existing : input;
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  const environment = { ...source };
  if (environment.baseUrl != null) {
    environment.baseUrl = resolveAssetUrl(environment.baseUrl, undefined, "environment.baseUrl");
    if (!/^https?:\/\//i.test(environment.baseUrl)) {
      throw new BrowserRunnerError(
        "INVALID_ASSET_URL",
        "environment.baseUrl 只允许 http(s) URL。",
        { statusCode: 422, phase: "control-plane" },
      );
    }
  }
  return environment;
}

export async function materializeOperationStep(step, options = {}) {
  const operation = String(step.operation || options.defaultOperation || "act");
  const input = { ...step };
  delete input.operation;
  if (operation === "navigate") input.url = resolveAssetUrl(input.url, options.baseUrl, "setup navigate.url");
  if (operation === "assert" && String(input.type || input.assertion || "") === "url" && typeof input.expected === "string") {
    input.expected = resolveAssetUrl(input.expected, options.baseUrl, "setup assert.expected");
  }
  if (operation === "act" && String(input.action || "click") === "fill" && input.valueFrom != null) {
    const value = await resolveRuntimeValue(input.valueFrom, options);
    attachRuntimeValue(input, "value", value);
  }
  return { operation, input };
}

export const materializeSetupStep = materializeOperationStep;

export function materializeAssertion(assertion, baseUrl) {
  const input = { ...assertion };
  if (String(input.type || input.assertion || "") === "url" && typeof input.expected === "string") {
    input.expected = resolveAssetUrl(input.expected, baseUrl, "assertion.expected");
  }
  return input;
}
