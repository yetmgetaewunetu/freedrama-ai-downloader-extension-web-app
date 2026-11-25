# FreeDrama.ai Video Downloader

One repository containing two independently usable interfaces sharing a common FreeDrama core (`shared/src`):

1. **Standalone Web Application** (`src/server` + `src/client`) — Express API + React/Tailwind dashboard with server-side streaming downloads.
2. **Google Chrome Extension (Manifest V3)** (`extension/`) — Browser popup + content script + background service worker using your active Chrome session and `chrome.downloads`.

## Repository Structure

```text
freedrama_upwork_project/
├── shared/                  # Shared FreeDrama core (API client, types, URL parser, rendition selection, filenames)
├── src/
│   ├── server/              # Standalone Express backend & streaming MP4 downloader
│   └── client/              # Standalone web application React + Tailwind UI
├── extension/               # Chrome Manifest V3 extension
│   ├── public/icons/        # Extension icons (16, 48, 128)
│   ├── src/
│   │   ├── popup/           # Popup entry & App
│   │   ├── background/      # MV3 service worker (queue, chrome.downloads, storage persistence)
│   │   ├── content/         # FreeDrama.ai page detector
│   │   ├── components/      # CurrentDramaSection, EpisodesSection, DownloadsSection
│   │   ├── hooks/           # Popup state & messaging hook
│   │   ├── services/        # Chrome storage & downloads wrappers
│   │   ├── types/           # Runtime message & job types
│   │   └── utils/           # Formatting helpers
│   ├── scripts/build.mjs    # Independent Vite + esbuild extension bundler
│   ├── manifest.json
│   ├── package.json
│   └── README.md
├── docs/API_INVESTIGATION.md
├── tests/
├── package.json
└── README.md
```

## Development & Build Commands

```bash
# Install root web app dependencies
npm install

# Install Chrome extension dependencies
npm --prefix extension install

# Run web application (API + Vite dev server)
npm run dev:web

# Run Chrome extension in watch mode
npm run dev:extension

# Build everything (web client + web server + Chrome extension)
npm run build

# Build only the Chrome extension -> outputs to extension/dist/
npm run build:extension

# Start production web server (http://localhost:3000)
npm start

# Typecheck & run tests
npm run typecheck
npm test
```

## Environment Variables (Web Application)

Copy `.env.example` to `.env`:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port for the Express server |
| `DOWNLOADS_DIR` | `./downloads` | Local directory for saved dramas and MP4 files |
| `DOWNLOAD_CONCURRENCY` | `2` | Conservative batch concurrency limit (`1` or `2`) |
| `FREEDRAMA_LOCALE` | `en-US` | Locale sent via `x-app-locale` / `x-app-link-locale` |
| `FREEDRAMA_COOKIE` | *(empty)* | Optional developer-provided authorized session cookie header for VIP/entitled episodes |

## Chrome Extension Installation

1. Run `npm --prefix extension install` and `npm run build:extension`.
2. Open `chrome://extensions` in Google Chrome and enable **Developer mode**.
3. Click **Load unpacked** and select **`extension/dist`**.

See [`extension/README.md`](extension/README.md) for extension permissions and details, and [`docs/API_INVESTIGATION.md`](docs/API_INVESTIGATION.md) for verified FreeDrama API details.

## Testing

- `npm run typecheck`: Typechecks web app, shared core, and Chrome extension.
- `npm test`: Runs Vitest suites covering URL validation, SSRF protection, path sanitization, rendition selection, expiration refresh, Express endpoints, and Chrome extension background queue/storage/recovery logic.
- Live FreeDrama.ai verification confirmed series discovery (`43` episodes), `540p`/`1080p` rendition selection, batch downloading, MP4 container validation, and clean `403 NOT_ENTITLED` handling on unauthenticated VIP episodes.
