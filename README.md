# Rates — Currency Exchange PWA

A one-screen currency converter. Type an amount once and see it in every currency
you care about. Works offline, installs to your phone's home screen, no build step,
no API key, no dependencies.

![Screenshot](docs/screenshot.png)

## What it does

- **Tap a currency** (the code or the flag) to swap it for another — 162 currencies, searchable.
- **Add currency** appends a row, up to 12.
- **Edit** shows a red minus on each row to take it off the list.
- **Type in any row**, not just the top one — every other amount recalculates.
- Your base currency, amount and list are saved in the browser, so the app opens where you left it.
- **Offline**: the last rates are cached. The footer tells you the date they came from.
- **Installable**: Chrome/Edge show an Install button; on iOS use Share → Add to Home Screen.

## Rates

Fetched on load and when the app regains focus, at most once every 30 minutes.
Three free, key-less sources are tried in order, so one outage does not break the app:

1. `open.er-api.com`
2. `latest.currency-api.pages.dev`
3. `cdn.jsdelivr.net/npm/@fawazahmed0/currency-api`

Rates are mid-market reference rates. Banks and exchange desks charge a spread,
so treat these as indicative, not what you will actually get at the counter.

## Run it locally

```bash
python3 -m http.server 8123
# open http://127.0.0.1:8123
```

Any static server works. Service workers need `http://localhost` or HTTPS —
opening `index.html` as a `file://` URL skips the offline layer.

## Deploy to Vercel

The repo is already a Vercel-ready static site (`vercel.json` sets the service-worker
and manifest headers). Nothing to build.

1. Go to [vercel.com/new](https://vercel.com/new) and import this repository.
2. Framework preset: **Other**. Leave build command and output directory empty.
3. Deploy. You get `https://<project>.vercel.app`.

Every push to the connected branch redeploys automatically.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup for the converter and the currency picker sheet |
| `styles.css` | Dark theme, rounded cards, bottom sheet |
| `app.js` | State, rate fetching and caching, conversion, picker, PWA hooks |
| `currencies.js` | 162 currencies with names and flag emoji |
| `sw.js` | Service worker — caches the app shell, never caches rates |
| `manifest.webmanifest` | PWA metadata and icons |
| `vercel.json` | Static hosting headers |

Flags are emoji, so there are no third-party image requests. On platforms without
flag emoji (most Windows browsers) the app falls back to the country code in the circle.
