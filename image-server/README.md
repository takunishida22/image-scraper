# Casino Image Server

A small, production-oriented service that reads the scraper's SQLite database
in read-only mode and streams WebP files directly from shared storage.

The image server has no scraper code, Playwright, build step, manifest, image
copy, or third-party npm dependencies. It requires Node.js 22.5 or newer.

## API

```text
GET  /Sweet%20Bonanza
GET  /Sweet%20Bonanza?type=square
HEAD /Sweet%20Bonanza
GET  /health
```

Portrait is preferred by default, then square, then landscape. An explicit
`type` is tried first before falling back to the remaining types.

Responses include WebP content type, ETag/Last-Modified conditional caching,
CORS, security headers, actual served image type, and a request ID.

Game/image metadata is indexed in memory at startup, so requests do not query
SQLite or stat files. A lightweight SQLite version check refreshes the index
within one second after the scraper writes new data.

## Local configuration

The defaults work while this directory remains inside the scraper project:

```bash
npm test
npm start
```

Production environment:

```text
IMAGE_SERVER_HOST=127.0.0.1
IMAGE_SERVER_PORT=3000
IMAGE_DATABASE_PATH=/srv/image-scraper/data/scraper.db
IMAGE_STORAGE_ROOT=/srv/image-scraper
IMAGE_FILES_ROOT=/srv/image-scraper/images
IMAGE_CACHE_MAX_AGE=86400
IMAGE_INDEX_POLL_MS=1000
IMAGE_ACCESS_LOG=false
IMAGE_ACCEL_REDIRECT_PREFIX=/_protected_images
```

`IMAGE_STORAGE_ROOT` is the base for relative paths stored in SQLite.
`IMAGE_FILES_ROOT` is the security boundary: database paths outside it are
never served.

## Deploy only the server application

```bash
rsync -a \
  package.json server.mjs \
  deploy@example:/srv/image-server/
```

The scraper database and image directory stay in `/srv/image-scraper`. Both
processes run independently while sharing those two resources.

Example systemd service:

```ini
[Unit]
Description=Casino Image Server
After=network.target

[Service]
Type=simple
User=image-server
WorkingDirectory=/srv/image-server
Environment=NODE_ENV=production
Environment=IMAGE_SERVER_HOST=127.0.0.1
Environment=IMAGE_SERVER_PORT=3000
Environment=IMAGE_DATABASE_PATH=/srv/image-scraper/data/scraper.db
Environment=IMAGE_STORAGE_ROOT=/srv/image-scraper
Environment=IMAGE_FILES_ROOT=/srv/image-scraper/images
Environment=IMAGE_ACCEL_REDIRECT_PREFIX=/_protected_images
ExecStart=/usr/bin/node /srv/image-server/server.mjs
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

The `image-server` user needs read and directory-traversal permission for the
database, its WAL/SHM files, and the shared image directory. Put Nginx or
another TLS reverse proxy in front of `127.0.0.1:3000`.

For the fastest production path, let Nginx send the image bytes directly:

```nginx
server {
    listen 443 ssl http2;
    server_name image.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Request-ID $request_id;
    }

    location /_protected_images/ {
        internal;
        alias /srv/image-scraper/images/;
        sendfile on;
        aio threads;
        open_file_cache max=20000 inactive=60s;
        open_file_cache_valid 120s;
        open_file_cache_min_uses 2;
    }
}
```

With `IMAGE_ACCEL_REDIRECT_PREFIX=/_protected_images`, Node performs only the
in-memory name lookup and Nginx serves the file through `sendfile`.
