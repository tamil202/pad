# Deploying Pen Pad on a Raspberry Pi

The app is a tiny Node/Express server (one runtime dependency: `express`) that
serves a static front-end and stores pages as JSON files. It runs comfortably on
any Raspberry Pi with Node 18+.

## Why the production path matters

During development the app runs with **ts-node**, which compiles TypeScript in
memory on every start — slow and RAM-hungry on a Pi. For release you compile
**once** with `tsc` and run the plain JavaScript in `dist/`:

```
npm run build          # tsc  → dist/server.js
node dist/server.js    # or: npm start
```

## 1. Install Node.js on the Pi

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v      # should print v20.x (or any v18+)
```

## 2. Copy the project and build

```bash
# copy the repo to e.g. /home/pi/pad, then:
cd /home/pi/pad
npm ci                 # installs deps (incl. TypeScript to build)
npm run build          # produces dist/
npm prune --omit=dev   # optional: drop typescript/ts-node to save space
```

## 3. Run it

```bash
NODE_ENV=production PORT=3000 node dist/server.js
# open http://<pi-ip>:3000 from any device on the LAN
```

`NODE_ENV=production` turns on 1-day cache headers for the JS/CSS/assets so the
Pi isn't re-sending them on every page load (HTML stays no-cache so updates show
immediately).

## 4. Run as a service (auto-start on boot)

```bash
sudo cp deploy/pad-app.service /etc/systemd/system/pad-app.service
# edit User / WorkingDirectory in that file if you didn't use /home/pi/pad
sudo systemctl daemon-reload
sudo systemctl enable --now pad-app
sudo systemctl status pad-app
```

## 5. (Optional) Kiosk mode on a Pi touchscreen

To drive the pad on a Pi with an attached touchscreen/HUION pad, launch Chromium
full-screen at boot:

```bash
chromium-browser --kiosk --incognito http://localhost:3000
```

## Data & backups

Saved pages live as JSON under **`data/pages/`** (created on first save). Back up
that folder to keep notes; delete a file to remove a page. The schema mirrors a
future `pages` SQL table, so migrating to SQLite/MySQL later is straightforward.

## Resource notes / tuning

- **Memory:** JSON request bodies are capped at 16 MB to protect a low-RAM Pi.
- **Rendering:** the pad draws only new pen segments per frame and batches
  repaints to one per animation frame — smooth even on the Pi's GPU.
- **I/O:** the page list is cached in memory and only rebuilt when a page is
  saved/deleted, so browsing saved pages doesn't re-read every file.
- **Zero native modules:** pure JS + Express, so no ARM build headaches.
