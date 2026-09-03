import { BrowserRunnerError } from "./operation-budget.mjs";

const RUNTIME_SENSITIVE_VALUES = Symbol("agent-eval.runtime-sensitive-values");

function referenceName(reference, key) {
  const value = String(reference?.[key] || "").trim();
  if (!value) {
    throw new BrowserRunnerError(
      "INVALID_RUNTIME_VALUE_REF",
      `setup fill 的 ${key} 引用不能为空。`,
      { statusCode: 422, phase: "setup" },
    );
  }
  return value;
}

export function validateRuntimeValueRef(reference) {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    throw new BrowserRunnerError(
      "INVALID_RUNTIME_VALUE_REF",
      "setup fill 必须使用 valueFrom.env 或 valueFrom.secretRef。",
      { statusCode: 422, phase: "setup" },
    );
  }
  const keys = ["env", "secretRef"].filter((key) => reference[key] != null);
  if (keys.length !== 1) {
    throw new BrowserRunnerError(
      "INVALID_RUNTIME_VALUE_REF",
      "valueFrom 必须且只能声明 env 或 secretRef 中的一项。",
      { statusCode: 422, phase: "setup" },
    );
  }
  const key = keys[0];
  const name = referenceName(reference, key);
  if (key === "env" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new BrowserRunnerError(
      "INVALID_RUNTIME_VALUE_REF",
      `环境变量名不合法：${name}。`,
      { statusCode: 422, phase: "setup" },
    );
  }
  return { kind: key, name };
}

export async function resolveRuntimeValue(reference, options = {}) {
  const normalized = validateRuntimeValueRef(reference);
  let value;
  if (normalized.kind === "env") {
    value = options.env?.[normalized.name];
  } else {
    if (typeof options.secretResolver !== "function") {
      throw new BrowserRunnerError(
        "SECRET_RESOLVER_UNAVAILABLE",
        `未配置 secretRef 解析器，无法解析 ${normalized.name}。`,
        { statusCode: 422, phase: "setup" },
      );
    }
    value = await options.secretResolver(normalized.name);
  }
  if (value == null) {
    throw new BrowserRunnerError(
      "RUNTIME_VALUE_NOT_FOUND",
      `${normalized.kind} 引用 ${normalized.name} 没有可用的运行时值。`,
      { statusCode: 422, phase: "setup" },
    );
  }
  return String(value);
}

export function attachRuntimeValue(input, key, value) {
  const values = runtimeSensitiveValues(input);
  values.push(String(value));
  Object.defineProperty(input, key, {
    configurable: true,
    enumerable: false,
    writable: false,
    value: String(value),
  });
  Object.defineProperty(input, RUNTIME_SENSITIVE_VALUES, {
    configurable: true,
    enumerable: false,
    writable: false,
    value: values,
  });
  return input;
}

export function runtimeSensitiveValues(input) {
  const values = input?.[RUNTIME_SENSITIVE_VALUES];
  return Array.isArray(values) ? [...values] : [];
}

export function redactRuntimeValues(value, sensitiveValues = []) {
  const replacements = [...new Set(sensitiveValues.map(String).filter(Boolean))].sort((a, b) => b.length - a.length);
  const redactString = (input) => {
    let output = String(input);
    for (const secret of replacements) output = output.split(secret).join("<redacted:runtime-value>");
    return output;
  };
  const visit = (input) => {
    if (typeof input === "string") return redactString(input);
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([key, child]) => [key, visit(child)]));
    return input;
  };
  return visit(value);
}
