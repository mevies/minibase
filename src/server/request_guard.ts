export interface RequestLimits {
  maxBodyBytes: number;
  timeoutMs: number;
  maxConcurrent: number;
}

type RequestHandler = (request: Request) => Promise<Response>;

export class RequestGuard {
  #active = 0;

  constructor(private readonly limits: RequestLimits) {}

  async handle(request: Request, next: RequestHandler): Promise<Response> {
    const contentLength = contentLengthValue(request.headers.get("content-length"));
    if (contentLength !== null && contentLength > this.limits.maxBodyBytes) {
      return requestTooLarge(this.limits.maxBodyBytes);
    }
    if (this.#active >= this.limits.maxConcurrent) {
      return jsonError(
        "server_busy",
        `Server concurrency limit of ${this.limits.maxConcurrent} requests is reached`,
        503,
        { "retry-after": "1" },
      );
    }

    this.#active++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#active--;
    };
    const timeoutController = new AbortController();
    const signal = AbortSignal.any([request.signal, timeoutController.signal]);
    let bodyExceeded = false;
    const guardedRequest = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" || request.method === "HEAD"
        ? undefined
        : limitBody(request.body, this.limits.maxBodyBytes, signal, () => {
          bodyExceeded = true;
        }),
      signal,
    });

    const operation = runWithRequestSignal(
      signal,
      () => next(guardedRequest),
      this.limits.timeoutMs,
    ).then(
      async (response) => {
        await cancelUnusedBody(guardedRequest);
        if (!bodyExceeded) return response;
        await response.body?.cancel().catch(() => undefined);
        return requestTooLarge(this.limits.maxBodyBytes);
      },
    ).catch(async (error) => {
      await cancelUnusedBody(guardedRequest);
      if (bodyExceeded) return requestTooLarge(this.limits.maxBodyBytes);
      throw error;
    });
    const timeout = Promise.withResolvers<"timeout">();
    const timeoutId = setTimeout(() => timeout.resolve("timeout"), this.limits.timeoutMs);

    try {
      const result = await Promise.race([
        operation.then((response) => ({ kind: "response" as const, response })),
        timeout.promise.then(() => ({ kind: "timeout" as const })),
      ]);
      if (result.kind === "timeout") {
        timeoutController.abort(new DOMException("Request timed out", "TimeoutError"));
        void operation.then(async (response) => {
          await response.body?.cancel().catch(() => undefined);
        }).catch(() => undefined).finally(release);
        return jsonError(
          "request_timeout",
          `Request exceeded the ${this.limits.timeoutMs} ms timeout`,
          504,
        );
      }
      if (result.response.body === null) {
        release();
        return result.response;
      }
      return new Response(observeBody(result.response.body, release), {
        status: result.response.status,
        statusText: result.response.statusText,
        headers: result.response.headers,
      });
    } catch (error) {
      release();
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

async function cancelUnusedBody(request: Request): Promise<void> {
  if (!request.bodyUsed) await request.body?.cancel().catch(() => undefined);
}

function contentLengthValue(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function limitBody(
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
  signal: AbortSignal,
  exceeded: () => void,
): ReadableStream<Uint8Array> | null {
  if (body === null) return null;
  let bytes = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > maximum) {
          exceeded();
          controller.error(new Error("Minibase request body limit exceeded"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
    { signal },
  );
}

function observeBody(
  body: ReadableStream<Uint8Array>,
  finish: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let finished = false;
  const finishOnce = () => {
    if (finished) return;
    finished = true;
    finish();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          finishOnce();
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        finishOnce();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finishOnce();
      await reader.cancel(reason);
    },
  });
}

function requestTooLarge(maximum: number): Response {
  return jsonError(
    "request_too_large",
    `Request body exceeds the ${maximum} byte limit`,
    413,
  );
}

function jsonError(
  code: string,
  message: string,
  status: number,
  headers: HeadersInit = {},
): Response {
  return Response.json({ code, message }, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}
import { runWithRequestSignal } from "../request/context.ts";
