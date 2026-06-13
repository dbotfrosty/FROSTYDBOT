---
name: Chart API connection fix
description: How to fix SmartChart "Retrieving Market Symbols" / "Retrieving Chart Data" hangs
---

## Rule
Gate SmartChart's render behind both `symbol` AND `is_connection_opened`. Do NOT pass `isConnectionOpened` as a prop and expect SmartChart to wait — it calls `requestAPI` immediately on mount regardless.

```js
if (!symbol || !is_connection_opened) return null;
```

**Why:** SmartChart calls `requestAPI({ active_symbols: "brief" })` the instant it mounts, before any prop change. If `chart_api.api` isn't connected yet, the send fails silently; SmartChart catches the error and stays on "Retrieving Market Symbols…" forever. Its `_onConnectionReopened()` handler only refreshes *existing* streams — it never retries the initial symbol fetch. So passing `isConnectionOpened={true}` later does nothing to fix it.

**How to apply:**
- Keep `is_connection_opened` as `useState(false)` — poll `chart_api.api?.connection?.readyState === WebSocket.OPEN` every 100ms, set to `true` only when fully OPEN
- Only then return the SmartChart JSX (guard: `if (!symbol || !is_connection_opened) return null`)
- Use `chart_api.api` (not `api_base.api`) for all chart calls — it's the dedicated chart WebSocket
- Before each `requestSubscribe`, send `{ forget_all: 'ticks' }` first to prevent "AlreadySubscribed" errors on remount
- Pass the real `requestForgetStream` to SmartChart (original code passed an empty function `() => {}`)
