import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const allowedTypes = new Set(["portrait", "square", "landscape"]);

function envPath(name, fallback) {
  return path.resolve(process.env[name] || fallback);
}

export function getConfig() {
  const storageRoot = envPath(
    "IMAGE_STORAGE_ROOT",
    path.resolve(appRoot, ".."),
  );
  return {
    host: process.env.IMAGE_SERVER_HOST || "127.0.0.1",
    port: Number.parseInt(process.env.IMAGE_SERVER_PORT || "3000", 10),
    databasePath: envPath(
      "IMAGE_DATABASE_PATH",
      path.join(storageRoot, "data", "scraper.db"),
    ),
    storageRoot,
    imagesRoot: envPath(
      "IMAGE_FILES_ROOT",
      path.join(storageRoot, "images"),
    ),
    cacheMaxAge: Math.max(
      0,
      Number.parseInt(process.env.IMAGE_CACHE_MAX_AGE || "86400", 10),
    ),
    indexPollMs: Math.max(
      250,
      Number.parseInt(process.env.IMAGE_INDEX_POLL_MS || "1000", 10),
    ),
    accelRedirectPrefix:
      process.env.IMAGE_ACCEL_REDIRECT_PREFIX?.replace(/\/+$/, "") || "",
    accessLog: process.env.IMAGE_ACCESS_LOG === "true",
  };
}

export function canonicalizeGameName(input) {
  if (!input) return "";
  return input
    .replace(/[\u2122\u00AE\u00A9]/g, "")
    .normalize("NFKC")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(Number.parseInt(h, 16)),
    )
    .replace(/[’‘‛]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .toLowerCase()
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function fallbackOrder(preferred = "portrait") {
  const defaults = ["portrait", "square", "landscape"];
  return [preferred, ...defaults.filter((type) => type !== preferred)];
}

function isInside(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return (
    relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

export class ImageRepository {
  constructor(options) {
    this.storageRoot = path.resolve(options.storageRoot);
    this.imagesRoot = path.resolve(options.imagesRoot);
    this.db = new DatabaseSync(path.resolve(options.databasePath), {
      readOnly: true,
    });
    this.db.exec("PRAGMA query_only = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.loadRows = this.db.prepare(
      `SELECT
         lower(g.normalized_name) AS normalized_name,
         g.name AS game_name,
         gi.image_type,
         gi.local_path,
         gi.file_size,
         gi.sha256,
         gi.created_at
       FROM games g
       JOIN game_images gi ON gi.game_id = g.id
       WHERE gi.image_type IN ('portrait', 'square', 'landscape')
         AND gi.format = 'webp'
       ORDER BY
         lower(g.normalized_name) ASC,
         CASE gi.source
           WHEN 'shuffle' THEN 0
           WHEN 'bcgame' THEN 1
           WHEN 'csv' THEN 2
           ELSE 3
         END,
         gi.game_match_score DESC,
         (gi.width * gi.height) DESC,
         gi.id ASC`,
    );
    this.versionQuery = this.db.prepare("PRAGMA data_version");
    this.index = new Map();
    this.imageCount = 0;
    this.dataVersion = 0;
    this.refresh();

    const pollMs = Math.max(250, options.indexPollMs ?? 1000);
    this.pollTimer = setInterval(() => {
      try {
        const version = Number(this.versionQuery.get()?.data_version ?? 0);
        if (version !== this.dataVersion) this.refresh();
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            message: "image_index_refresh_failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }, pollMs);
    this.pollTimer.unref();
  }

  refresh() {
    const next = new Map();
    let count = 0;
    for (const row of this.loadRows.all()) {
      const absolutePath = path.isAbsolute(row.local_path)
        ? path.resolve(row.local_path)
        : path.resolve(this.storageRoot, row.local_path);
      if (!isInside(this.imagesRoot, absolutePath)) continue;

      const normalized = String(row.normalized_name);
      let byType = next.get(normalized);
      if (!byType) {
        byType = { portrait: [], square: [], landscape: [] };
        next.set(normalized, byType);
      }
      const relativePath = path.relative(this.imagesRoot, absolutePath);
      const createdAt = String(row.created_at || "").replace(" ", "T");
      const timestamp = Date.parse(
        /(?:Z|[+-]\d\d:\d\d)$/.test(createdAt) ? createdAt : `${createdAt}Z`,
      );
      byType[row.image_type].push({
        gameName: row.game_name,
        imageType: row.image_type,
        absolutePath,
        relativePath,
        fileSize: Number(row.file_size),
        sha256: row.sha256,
        lastModified: Number.isFinite(timestamp)
          ? new Date(timestamp).toUTCString()
          : new Date(0).toUTCString(),
      });
      count++;
    }
    this.index = next;
    this.imageCount = count;
    this.dataVersion = Number(this.versionQuery.get()?.data_version ?? 0);
  }

  resolve(gameName, preferred = "portrait") {
    const normalized = canonicalizeGameName(gameName);
    if (!normalized) return null;
    const byType = this.index.get(normalized);
    if (!byType) return null;
    for (const type of fallbackOrder(preferred)) {
      const candidate = byType[type]?.[0];
      if (candidate) return candidate;
    }
    return null;
  }

  health() {
    return {
      games: this.index.size,
      images: this.imageCount,
      dataVersion: this.dataVersion,
    };
  }

  close() {
    clearInterval(this.pollTimer);
    this.db.close();
  }
}

function sendJson(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store",
  });
  response.end(payload);
}

function setSecurityHeaders(response, requestId) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cross-origin-resource-policy", "cross-origin");
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("x-request-id", requestId);
}

export function createRequestHandler(repository, options = {}) {
  const cacheMaxAge = options.cacheMaxAge ?? 86400;
  const accelRedirectPrefix = options.accelRedirectPrefix || "";
  const accessLog = options.accessLog === true;

  return (request, response) => {
    const startedAt = performance.now();
    const requestId = request.headers["x-request-id"] || crypto.randomUUID();
    setSecurityHeaders(response, requestId);
    if (accessLog) response.on("finish", () => {
      console.log(
        JSON.stringify({
          level: "info",
          requestId,
          method: request.method,
          path: request.url,
          status: response.statusCode,
          durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        }),
      );
    });

    const method = request.method || "GET";
    if (method !== "GET" && method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      sendJson(response, 405, { error: "method_not_allowed", requestId });
      return;
    }

    let url;
    try {
      url = new URL(request.url || "/", "http://image.local");
    } catch {
      sendJson(response, 400, { error: "invalid_url", requestId });
      return;
    }

    if (url.pathname === "/health") {
      try {
        sendJson(response, 200, {
          status: "ok",
          ...repository.health(),
        });
      } catch {
        sendJson(response, 503, { status: "unavailable", requestId });
      }
      return;
    }

    const encodedName = url.pathname.replace(/^\/+|\/+$/g, "");
    if (!encodedName) {
      sendJson(response, 400, {
        error: "missing_game_name",
        usage: "/{gameName}?type=portrait",
        requestId,
      });
      return;
    }

    let gameName;
    try {
      gameName = decodeURIComponent(encodedName);
    } catch {
      sendJson(response, 400, {
        error: "invalid_game_name_encoding",
        requestId,
      });
      return;
    }

    const requestedType = url.searchParams.get("type") || "portrait";
    if (!allowedTypes.has(requestedType)) {
      sendJson(response, 400, {
        error: "invalid_type",
        allowed: [...allowedTypes],
        requestId,
      });
      return;
    }

    let image;
    try {
      image = repository.resolve(gameName, requestedType);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          requestId,
          message: "image_lookup_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      sendJson(response, 500, { error: "image_lookup_failed", requestId });
      return;
    }

    if (!image) {
      sendJson(response, 404, {
        error: "image_not_found",
        gameName,
        requestId,
      });
      return;
    }

    const etag = `"${image.sha256}"`;
    response.setHeader("content-type", "image/webp");
    response.setHeader("content-length", image.fileSize);
    response.setHeader("cache-control", `public, max-age=${cacheMaxAge}`);
    response.setHeader("etag", etag);
    response.setHeader("last-modified", image.lastModified);
    response.setHeader("x-image-type", image.imageType);
    response.setHeader("x-game-name", encodeURIComponent(image.gameName));

    if (
      request.headers["if-none-match"] === etag ||
      (!request.headers["if-none-match"] &&
        request.headers["if-modified-since"] === image.lastModified)
    ) {
      response.removeHeader("content-length");
      response.writeHead(304);
      response.end();
      return;
    }

    if (method === "HEAD") {
      response.writeHead(200);
      response.end();
      return;
    }

    if (accelRedirectPrefix) {
      const encodedPath = image.relativePath
        .split(/[\\/]/)
        .map(encodeURIComponent)
        .join("/");
      response.removeHeader("content-length");
      response.setHeader(
        "x-accel-redirect",
        `${accelRedirectPrefix}/${encodedPath}`,
      );
      response.writeHead(200);
      response.end();
      return;
    }

    response.writeHead(200);
    const stream = fs.createReadStream(image.absolutePath);
    stream.on("error", (error) => {
      console.error(
        JSON.stringify({
          level: "error",
          requestId,
          message: "image_stream_failed",
          error: error.message,
        }),
      );
      response.destroy(error);
    });
    stream.pipe(response);
  };
}

export function createImageServer(repository, options) {
  const server = http.createServer(createRequestHandler(repository, options));
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;
  return server;
}

function start() {
  const config = getConfig();
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    throw new Error(`Invalid IMAGE_SERVER_PORT: ${process.env.IMAGE_SERVER_PORT}`);
  }
  if (!fs.existsSync(config.databasePath)) {
    throw new Error(`Image database not found: ${config.databasePath}`);
  }
  if (!fs.existsSync(config.imagesRoot)) {
    throw new Error(`Image directory not found: ${config.imagesRoot}`);
  }

  const repository = new ImageRepository(config);
  const server = createImageServer(repository, {
    cacheMaxAge: config.cacheMaxAge,
    accelRedirectPrefix: config.accelRedirectPrefix,
    accessLog: config.accessLog,
  });
  server.listen(config.port, config.host, () => {
    console.log(
      JSON.stringify({
        level: "info",
        message: "image_server_started",
        host: config.host,
        port: config.port,
        databasePath: config.databasePath,
        imagesRoot: config.imagesRoot,
      }),
    );
  });

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close(() => {
      repository.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  start();
}
