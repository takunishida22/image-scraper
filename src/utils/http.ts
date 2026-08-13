import { ProxyAgent, fetch as undiciFetch, type RequestInit, type Response as UndiciResponse } from "undici";
import { config } from "../config/index.js";
import { logger } from "./logger.js";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class DownloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadTooLargeError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: string; message?: string };
  return (
    e.name === "AbortError" ||
    e.code === "ABORT_ERR" ||
    Boolean(e.message?.toLowerCase().includes("abort"))
  );
}

const proxyAgents = new Map<string, ProxyAgent>();

function getDispatcher(proxyUrl?: string): ProxyAgent | undefined {
  const proxy = proxyUrl || config.httpsProxy || config.httpProxy;
  if (!proxy) return undefined;
  let agent = proxyAgents.get(proxy);
  if (!agent) {
    agent = new ProxyAgent(proxy);
    proxyAgents.set(proxy, agent);
  }
  return agent;
}

export async function closeHttpAgents(): Promise<void> {
  const agents = [...proxyAgents.values()];
  proxyAgents.clear();
  await Promise.all(
    agents.map(async (agent) => {
      try {
        await agent.close();
      } catch {
        /* ignore */
      }
    }),
  );
}

export interface FetchOptions extends RequestInit {
  proxy?: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  label?: string;
  maxBytes?: number;
}

function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

async function readBodyBounded(
  response: UndiciResponse,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declared = Number.parseInt(contentLength, 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      response.body?.cancel().catch(() => undefined);
      throw new DownloadTooLargeError(
        `Content-Length ${declared} exceeds MAX_IMAGE_BYTES ${maxBytes}`,
      );
    }
  }

  if (!response.body) {
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) {
      throw new DownloadTooLargeError(`Body exceeds MAX_IMAGE_BYTES ${maxBytes}`);
    }
    return Buffer.from(arrayBuffer);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  const onAbort = () => {
    reader.cancel().catch(() => undefined);
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
      throw abortError();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    while (true) {
      if (signal?.aborted) {
        throw abortError();
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DownloadTooLargeError(`Downloaded bytes exceed MAX_IMAGE_BYTES ${maxBytes}`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }

  return Buffer.concat(chunks, total);
}

/**
 * Fetch URL and fully consume body under a single timeout/retry budget.
 * AbortController stays active through headers + body streaming.
 */
async function fetchConsumed(
  url: string,
  options: FetchOptions = {},
): Promise<{ buffer: Buffer; contentType: string | null; finalUrl: string; status: number }> {
  const {
    proxy,
    timeoutMs = config.requestTimeout,
    retries = config.maxRetries,
    retryDelayMs = config.retryDelay,
    label = url,
    maxBytes = config.maxImageBytes,
    ...init
  } = options;

  const dispatcher = getDispatcher(proxy);
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await undiciFetch(url, {
        ...init,
        signal: controller.signal,
        dispatcher,
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          accept: "text/html,application/json,*/*",
          "accept-language": "en-US,en;q=0.9",
          ...(init.headers ?? {}),
        },
      } as RequestInit & { dispatcher?: ProxyAgent });

      if (!response.ok) {
        const permanent =
          response.status === 404 ||
          response.status === 410 ||
          response.status === 401 ||
          response.status === 403;
        // Drain/cancel body so the socket can be reused
        response.body?.cancel().catch(() => undefined);

        if (permanent || !isRetryableStatus(response.status) || attempt === retries) {
          throw new HttpError(`HTTP ${response.status} for ${label}`, response.status, permanent);
        }

        const backoff = retryDelayMs * 2 ** attempt;
        const retryAfter = Number(response.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff;
        clearTimeout(timer);
        logger.warn(
          `Retryable HTTP ${response.status} for ${label}; waiting ${wait}ms (attempt ${attempt + 1}/${retries})`,
        );
        await sleep(wait);
        continue;
      }

      // Timeout remains active until body is fully consumed
      const buffer = await readBodyBounded(response, maxBytes, controller.signal);
      clearTimeout(timer);

      return {
        buffer,
        contentType: response.headers.get("content-type"),
        finalUrl: response.url || url,
        status: response.status,
      };
    } catch (err) {
      clearTimeout(timer);
      lastError = err;

      if (err instanceof HttpError && err.permanent) throw err;
      // Oversized responses won't succeed on retry of the same URL
      if (err instanceof DownloadTooLargeError) throw err;

      if (attempt === retries) break;

      const reason = isAbortError(err) ? "timeout/abort" : (err as Error).message;
      const backoff = retryDelayMs * 2 ** attempt;
      logger.warn(`Request failed for ${label} (${reason}); retry in ${backoff}ms`);
      await sleep(backoff);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** @deprecated Prefer fetchBuffer/fetchText — kept for callers that only need headers/status. */
export async function fetchWithRetry(
  url: string,
  options: FetchOptions = {},
): Promise<UndiciResponse> {
  // Full consume under timeout, then synthesize a minimal Response-like path via re-fetch is wasteful.
  // For compatibility, perform a headers+body consume and throw away body when only status needed —
  // callers in this project use fetchBuffer/fetchText/fetchJson instead.
  const result = await fetchConsumed(url, options);
  // Build a Response from the buffered body so existing code paths stay typed.
  return new Response(result.buffer, {
    status: result.status,
    headers: result.contentType ? { "content-type": result.contentType } : undefined,
  }) as unknown as UndiciResponse;
}

export async function fetchBuffer(
  url: string,
  options: FetchOptions = {},
): Promise<{ buffer: Buffer; contentType: string | null; finalUrl: string }> {
  const result = await fetchConsumed(url, options);
  return {
    buffer: result.buffer,
    contentType: result.contentType,
    finalUrl: result.finalUrl,
  };
}

export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const result = await fetchConsumed(url, options);
  return result.buffer.toString("utf8");
}

export async function fetchJson<T = unknown>(url: string, options: FetchOptions = {}): Promise<T> {
  const result = await fetchConsumed(url, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.headers ?? {}),
    },
  });
  return JSON.parse(result.buffer.toString("utf8")) as T;
}
