import { ProxyAgent, fetch as undiciFetch, type RequestInit } from "undici";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function createDispatcher(proxyUrl?: string) {
  const proxy = proxyUrl || config.httpsProxy || config.httpProxy;
  if (!proxy) return undefined;
  return new ProxyAgent(proxy);
}

export interface FetchOptions extends RequestInit {
  proxy?: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  label?: string;
}

export async function fetchWithRetry(
  url: string,
  options: FetchOptions = {},
): Promise<Response> {
  const {
    proxy,
    timeoutMs = config.requestTimeout,
    retries = config.maxRetries,
    retryDelayMs = config.retryDelay,
    label = url,
    ...init
  } = options;

  const dispatcher = createDispatcher(proxy);
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
        return response as unknown as Response;
      }

      const permanent = response.status === 404 || response.status === 410 || response.status === 401 || response.status === 403;
      if (permanent || !isRetryableStatus(response.status) || attempt === retries) {
        throw new HttpError(`HTTP ${response.status} for ${label}`, response.status, permanent);
      }

      const backoff = retryDelayMs * 2 ** attempt;
      const retryAfter = Number(response.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff;
      logger.warn(`Retryable HTTP ${response.status} for ${label}; waiting ${wait}ms (attempt ${attempt + 1}/${retries})`);
      await sleep(wait);
    } catch (err) {
      clearTimeout(timer);
      lastError = err;

      if (err instanceof HttpError && err.permanent) throw err;

      if (attempt === retries) break;

      const backoff = retryDelayMs * 2 ** attempt;
      logger.warn(`Request failed for ${label}: ${(err as Error).message}; retry in ${backoff}ms`);
      await sleep(backoff);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function fetchBuffer(
  url: string,
  options: FetchOptions = {},
): Promise<{ buffer: Buffer; contentType: string | null; finalUrl: string }> {
  const response = await fetchWithRetry(url, options);
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: response.headers.get("content-type"),
    finalUrl: response.url || url,
  };
}

export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const response = await fetchWithRetry(url, options);
  return response.text();
}

export async function fetchJson<T = unknown>(url: string, options: FetchOptions = {}): Promise<T> {
  const response = await fetchWithRetry(url, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.headers ?? {}),
    },
  });
  return response.json() as Promise<T>;
}
