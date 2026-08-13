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

export async function fetchWithRetry(
  url: string,
  options: FetchOptions = {},
): Promise<UndiciResponse> {
  const {
    proxy,
    timeoutMs = config.requestTimeout,
    retries = config.maxRetries,
    retryDelayMs = config.retryDelay,
    label = url,
    maxBytes: _maxBytes,
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

      clearTimeout(timer);

      if (response.ok) {
        return response;
      }

      const permanent =
        response.status === 404 ||
        response.status === 410 ||
        response.status === 401 ||
        response.status === 403;
      if (permanent || !isRetryableStatus(response.status) || attempt === retries) {
        throw new HttpError(`HTTP ${response.status} for ${label}`, response.status, permanent);
      }

      const backoff = retryDelayMs * 2 ** attempt;
      const retryAfter = Number(response.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff;
      logger.warn(
        `Retryable HTTP ${response.status} for ${label}; waiting ${wait}ms (attempt ${attempt + 1}/${retries})`,
      );
      await sleep(wait);
    } catch (err) {
      clearTimeout(timer);
      lastError = err;

      if (err instanceof HttpError && err.permanent) throw err;
      if (err instanceof DownloadTooLargeError) throw err;

      if (attempt === retries) break;

      const backoff = retryDelayMs * 2 ** attempt;
      logger.warn(`Request failed for ${label}: ${(err as Error).message}; retry in ${backoff}ms`);
      await sleep(backoff);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function readBodyBounded(
  response: UndiciResponse,
  maxBytes: number,
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

  while (true) {
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

  return Buffer.concat(chunks, total);
}

export async function fetchBuffer(
  url: string,
  options: FetchOptions = {},
): Promise<{ buffer: Buffer; contentType: string | null; finalUrl: string }> {
  const maxBytes = options.maxBytes ?? config.maxImageBytes;
  const response = await fetchWithRetry(url, options);
  const buffer = await readBodyBounded(response, maxBytes);
  return {
    buffer,
    contentType: response.headers.get("content-type"),
    finalUrl: response.url || url,
  };
}

export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const response = await fetchWithRetry(url, options);
  const maxBytes = options.maxBytes ?? config.maxImageBytes;
  const buffer = await readBodyBounded(response, maxBytes);
  return buffer.toString("utf8");
}

export async function fetchJson<T = unknown>(url: string, options: FetchOptions = {}): Promise<T> {
  const response = await fetchWithRetry(url, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.headers ?? {}),
    },
  });
  const maxBytes = options.maxBytes ?? config.maxImageBytes;
  const buffer = await readBodyBounded(response, maxBytes);
  return JSON.parse(buffer.toString("utf8")) as T;
}
