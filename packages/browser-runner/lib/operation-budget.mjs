const DEFAULT_DEADLINE_MS = 30_000;
const MAX_DEADLINE_MS = 60 * 60 * 1000;

export class BrowserRunnerError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "BrowserRunnerError";
    this.code = code;
    this.phase = options.phase || "operation";
    this.statusCode = Number.isInteger(options.statusCode) ? options.statusCode : 500;
    this.retryable = options.retryable === true;
    this.details = options.details || null;
    this.operationId = options.operationId || null;
    this.sessionId = options.sessionId || null;
    this.tabId = options.tabId || null;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      phase: this.phase,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

function boundedDeadline(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(MAX_DEADLINE_MS, Math.round(parsed)));
}

function abortError(reason, context) {
  const isDeadline = reason === "deadline";
  return new BrowserRunnerError(
    isDeadline ? "DEADLINE_EXCEEDED" : "CANCELLED",
    isDeadline ? "浏览器操作超过截止时间。" : "浏览器操作已取消。",
    {
      phase: "budget",
      statusCode: isDeadline ? 504 : 499,
      retryable: false,
      ...context,
    },
  );
}

/**
 * A single operation budget. Playwright calls do not all expose AbortSignal,
 * so the budget races the operation and invokes onCancel to stop navigation
 * or the current DOM action when the signal/deadline fires.
 */
export function createOperationBudget(options = {}) {
  const now = Date.now();
  const deadlineMs = boundedDeadline(options.deadlineMs, DEFAULT_DEADLINE_MS);
  const requestedDeadlineAt = Number.isFinite(Number(options.deadlineAt))
    ? Number(options.deadlineAt)
    : now + deadlineMs;
  const totalDeadlineAt = Number.isFinite(Number(options.totalDeadlineAt))
    ? Number(options.totalDeadlineAt)
    : Number.isFinite(Number(options.totalBudgetMs))
      ? now + boundedDeadline(options.totalBudgetMs, deadlineMs)
      : requestedDeadlineAt;
  const deadlineAt = Math.min(requestedDeadlineAt, totalDeadlineAt);
  const controller = new AbortController();
  const externalSignal = options.signal;
  let cancelReason = null;

  const remainingMs = () => Math.max(0, deadlineAt - Date.now());
  const throwIfExpired = () => {
    if (controller.signal.aborted) throw abortError(cancelReason || "cancel", options);
    if (remainingMs() <= 0) throw abortError("deadline", options);
  };
  const cancel = (reason = "cancel") => {
    if (cancelReason) return;
    cancelReason = reason;
    controller.abort(reason);
  };
  const onExternalAbort = () => cancel(externalSignal?.reason === "deadline" ? "deadline" : "cancel");
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  async function run(task, optionsForRun = {}) {
    throwIfExpired();
    const operation = Promise.resolve().then(task);
    // A timed-out Playwright promise may settle later. Attach a rejection
    // handler before racing so that cancellation never creates an unhandled
    // rejection in the host process.
    operation.catch(() => {});
    let timer;
    let abortListener;
    const cancellation = new Promise((_, reject) => {
      abortListener = () => {
        Promise.resolve(optionsForRun.onCancel?.(cancelReason || "cancel")).catch(() => {});
        reject(abortError(cancelReason || "cancel", options));
      };
      if (controller.signal.aborted) abortListener();
      else controller.signal.addEventListener("abort", abortListener, { once: true });
      timer = setTimeout(() => {
        cancel("deadline");
      }, remainingMs());
    });
    try {
      return await Promise.race([operation, cancellation]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abortListener);
    }
  }

  return {
    operationId: options.operationId || null,
    sessionId: options.sessionId || null,
    tabId: options.tabId || null,
    deadlineAt,
    totalDeadlineAt,
    signal: controller.signal,
    remainingMs,
    cancel,
    throwIfExpired,
    run,
  };
}

export function asBrowserRunnerError(error, context = {}) {
  if (error instanceof BrowserRunnerError) {
    for (const [key, value] of Object.entries(context)) if (value != null && error[key] == null) error[key] = value;
    return error;
  }
  return new BrowserRunnerError("BROWSER_OPERATION_FAILED", error instanceof Error ? error.message : String(error), {
    statusCode: 502,
    phase: context.phase || "operation",
    ...context,
  });
}

export const OPERATION_LIMITS = Object.freeze({ DEFAULT_DEADLINE_MS, MAX_DEADLINE_MS });
