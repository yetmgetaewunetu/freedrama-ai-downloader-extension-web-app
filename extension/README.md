# FreeDrama.ai Downloader — Chrome Extension (Manifest V3)

Chrome extension interface for FreeDrama.ai that reuses the shared FreeDrama core (`../shared/src`) and integrates directly with your active Chrome session and `chrome.downloads`.

## Build & Load Unpacked in Chrome

1. **Install dependencies (independently of the web app)**

   ```bash
   npm install
   ```

2. **Build production extension**

   ```bash
   npm run build
   ```

   Or from the repository root:

   ```bash
   npm run build:extension
   ```

   Production output directory: **`extension/dist/`**

3. **Load in Google Chrome**
   - Open `chrome://extensions`
   - Enable **Developer mode** (top right)
   - Click **Load unpacked**
   - Select the `extension/dist` directory

## Development Watch Mode

From `extension/`:

```bash
npm run dev
```

Or from the repository root:

```bash
npm run dev:extension
```

## Permissions Explained

- `downloads`: Start MP4 downloads via `chrome.downloads.download()`, track progress/completion/errors via `chrome.downloads.onChanged`, cancel jobs, and open saved files in your folder.
- `storage`: Persist the download queue, job metadata, and last inspected drama in `chrome.storage.local` so state survives popup closure and MV3 service-worker suspension.
- `activeTab`: Read the active tab URL and communicate with the content script when you open the popup.
- `host_permissions` (`https://freedrama.ai/*`, `https://www.freedrama.ai/*`, `https://cdn.freedrama.ai/*`): Restrict API requests, content script injection, and CDN downloads strictly to verified FreeDrama domains.

## Output File Organization

Downloads are saved inside your Chrome Downloads directory as:

```text
<Drama Title>/
  Episode_001_1080p.mp4
  Episode_002_540p.mp4
```

## Known Limitations

- VIP-locked episodes require an authorized FreeDrama session already signed in within Chrome; the extension does not bypass paywalls or entitlement restrictions.
- Chrome's `chrome.downloads` API controls the final file location inside the browser's configured Downloads folder and handles duplicate filenames via `conflictAction: "uniquify"`.
