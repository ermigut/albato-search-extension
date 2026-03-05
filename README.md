# Albato Apps Search — Chrome Extension

Chrome extension that adds **instant full-text search** across all your Albato apps directly in the sidebar, bypassing 20-item pagination. Works on both `new.albato.ru` and `albato.com`.

## Features

- 🔍 Search by app name (RU / EN) across all pages at once
- 📋 Expand any app to see its versions with statuses (Private / Moderation / Public / By link)
- ➕ Add a new version right from the search results
- 🗑 Delete a draft version
- 🔗 Navigate to any version in the constructor with one click
- ⚡ Search field appears immediately (loading state), activates once apps are fetched

## How it works

1. **`inject.js`** — injected into the page context, wraps `fetch`/`XHR` to capture auth headers and patches `history.pushState` to detect SPA navigation.
2. **`content.js`** — content script that fetches all app pages in parallel using the captured headers, then injects a search UI at the top of the sidebar.

The extension only activates on `/apps` and `/builder/constructor` pages.

## Installation (Developer Mode)

> The extension is not published to the Chrome Web Store — load it manually.

1. Download or clone this repository
2. Open **`chrome://extensions/`** in Chrome
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked**
5. Select the folder containing `manifest.json`
6. Open [new.albato.ru/apps](https://new.albato.ru/apps) or [albato.com/app/apps](https://albato.com/app/apps) — the search box will appear in the sidebar

### Updating

After pulling new changes — go to `chrome://extensions/` and click the **↺ refresh** icon on the extension card.

## Supported URLs

| Domain | Apps list | Constructor |
|--------|-----------|-------------|
| `new.albato.ru` | `/apps` | `/builder/constructor/:appId/:versionId/...` |
| `albato.com` | `/app/apps` | `/app/builder/constructor/:appId/:versionId/...` |

## Debugging

Open DevTools Console on any Albato page and filter by `[Albato Search]`:

```
[Albato Search] Search UI injected (loading apps…)   — sidebar found, UI visible
[Albato Search] Ready — 42 apps loaded.              — apps fetched, search active
[Albato Search] Could not find sidebar: …            — sidebar not found (wrong page or slow load)
[Albato Search] Failed to load apps: …               — API error
```
