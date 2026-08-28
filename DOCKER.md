# Pen Pad on Raspberry Pi with Docker

A complete, memory-managed container setup. Node.js runs **inside** the
container (from the `node:20-alpine` base image), so the Node already installed
on your Pi is left completely untouched.

## What you get

| File                 | Purpose                                                        |
|----------------------|---------------------------------------------------------------|
| `Dockerfile`         | Multi-stage build: compile TS, then a tiny prod-only runtime  |
| `docker-compose.yml` | Service with memory/CPU limits, persistence, healthcheck      |
| `.dockerignore`      | Keeps the build context (and image) small                     |

The final image is small (Alpine + only `express` at runtime — no dev deps, no
npm cache, no TypeScript) and runs as the unprivileged `node` user.

## Prerequisites (Raspberry Pi OS)

Install Docker + the Compose plugin (one time):

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER      # then log out/in so `docker` works without sudo
docker version
docker compose version
```

## Run it

From the project folder on the Pi:

```bash
docker compose up -d --build       # build the image and start in the background
docker compose logs -f             # watch it boot ("Pad app running at ...")
```

Open **http://<pi-ip>:3000** from any device on your network.

Everyday commands:

```bash
docker compose ps                  # status + health
docker compose restart             # restart
docker compose down                # stop & remove the container (data is kept)
docker compose up -d --build       # rebuild after you change the code
```

## Data & persistence

Saved pages are written to **`./data/pages/`** on the host (bind-mounted to
`/app/data` in the container), so they survive `down`, rebuilds, and reboots.

- **Back up** = copy the `data/` folder.
- The `node` user in the container is uid **1000**, which matches the default
  `pi` user, so the mounted folder is writable. If you run as a different host
  user and hit a permission error, run: `sudo chown -R 1000:1000 data`.

## Memory management (the important part on a Pi)

Two independent limits work together:

1. **V8 heap cap** — `NODE_OPTIONS=--max-old-space-size=<MB>` in
   `docker-compose.yml` stops Node's JS heap from growing past a set size.
   Tune it to your board:

   | Pi model            | RAM   | Suggested value |
   |---------------------|-------|-----------------|
   | Pi Zero / Pi 1      | 512MB | `128`           |
   | Pi 3                | 1GB   | `192`           |
   | Pi 4 / Pi 5         | 2GB+  | `256`–`384`     |

2. **Container hard limit** — `deploy.resources.limits.memory: 512M` tells
   Docker to kill/restart the container if total RSS exceeds the cap (a safety
   net beyond the JS heap). `reservations.memory: 128M` is the soft floor.

   > On **Docker Compose v2** (`docker compose`, the plugin) these `deploy`
   > limits are enforced. On the **legacy v1** `docker-compose` binary, replace
   > the `deploy:` block with the `mem_limit` / `cpus` lines noted in the file.

Other footprint-friendly touches already baked in:

- **`init: true`** — a real PID 1 that reaps zombies and forwards signals.
- **Log rotation** — `max-size: 5m`, `max-file: 3` so logs can't fill the SD card.
- **Server-side caching** — assets get 1-day cache headers + ETag (304s), and
  the page list is cached in memory, so browsing doesn't re-read every file.
- **App JSON body limit 16 MB** — a runaway upload can't exhaust RAM.
- **Client rendering** — incremental pen strokes + one repaint per frame keep
  CPU/GPU load low.

### Verifying memory use

```bash
docker stats pen-pad               # live CPU / MEM USAGE / LIMIT
docker compose ps                  # shows health status
```

`MEM USAGE / LIMIT` should sit well under the 512M cap for normal use.

## Auto-start on boot

`restart: unless-stopped` already means the container comes back after a reboot
(once the Docker service is enabled):

```bash
sudo systemctl enable docker
```

## Kiosk mode (optional, Pi touchscreen)

To show the pad full-screen on an attached display:

```bash
chromium-browser --kiosk --incognito http://localhost:3000
```

## Troubleshooting

- **Build is slow the first time** — it pulls the `node:20-alpine` base and
  compiles TypeScript. Subsequent builds are cached and fast.
- **Port already in use** — change the host side of `ports:` (e.g. `8080:3000`).
- **Permission denied on `data/`** — `sudo chown -R 1000:1000 data`.
- **Healthcheck shows unhealthy** — `docker compose logs` to see the error;
  make sure `PORT` matches the container port.
