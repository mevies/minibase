import { AsyncLocalStorage } from "node:async_hooks";

interface RequestExecutionContext {
  signal: AbortSignal;
  deadline?: number;
}

const requestContexts = new AsyncLocalStorage<RequestExecutionContext>();

export function runWithRequestSignal<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  return requestContexts.run({
    signal,
    deadline: timeoutMs === undefined ? undefined : Date.now() + timeoutMs,
  }, operation);
}

export function effectiveRequestSignal(explicit?: AbortSignal): AbortSignal | undefined {
  const ambient = requestContexts.getStore()?.signal;
  if (explicit === undefined) return ambient;
  if (ambient === undefined || ambient === explicit) return explicit;
  return AbortSignal.any([explicit, ambient]);
}

export function remainingRequestTimeoutMs(): number | undefined {
  const deadline = requestContexts.getStore()?.deadline;
  return deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
}
