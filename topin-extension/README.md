# Topin automation extension

Replaces the earlier local-server approach (see git history) so nothing needs to run on
anyone's machine. Each person installs this once and clones/publishes under **their own**
Topin login — there's no shared account and no server to keep running.

**Status:** the clone → fill → save → review sequence was verified 2026-09-22 against the real
Topin site, end to end, using a Playwright script that drives the identical steps this
extension's content script does. Login, clone, filling name/tag/start/end, Save & Next
actually persisting the fields, and landing back on a reviewable Final Review page all
worked first try. What's **not yet verified** is this specific file — a browser extension
can't run Playwright, so `content-topin.js` does the same steps via plain DOM events instead,
which is a proven pattern but a different code path than what was tested. The first real
install-and-clone is the test of that gap. Publishing itself also hasn't been tried yet
(deliberately, to avoid creating a real live assessment while testing).

## What it does

1. On the Assessment Generation page, **Clone** sends the exam's title/tag/schedule and the
   source config link to the extension.
2. The extension opens that config in a new tab, clicks Clone, fills in the name/tag/dates,
   and clicks Save & Next — which is the only thing that actually saves those fields in
   Topin. It then clicks back to the "Final Review" step so the tab is left on a saved,
   reviewable page instead of mid-way toward publishing.
3. The app shows that page's link and a "review it" button. Nothing is published yet —
   open it, check it, edit anything you want directly in Topin.
4. **Publish**, from the app, tells the extension to go back to that same tab, click through
   to Publish & Invite, publish, and read back the live assessment link.

## Install (until this is pushed to the Chrome Web Store)

1. Chrome (or Edge) → `chrome://extensions` → turn on **Developer mode** (top right).
2. **Load unpacked** → select this `topin-extension` folder.
3. Chrome will show an occasional "developer mode extensions" reminder — that's expected
   for an unpacked install; it doesn't affect anything.

The extension's ID is pinned via the `key` in `manifest.json`, so it's the same for
everyone who loads this folder — the app doesn't need per-person configuration.

## Permissions

- `config.topin.tech` only, plus the Academy Nexus app's own origin (to receive its
  messages). It never sees any other site or tab.
- `clipboardRead` — used once, right after clicking Topin's own "Copy Link" button, to grab
  the published assessment link. There's a DOM fallback if that's blocked.
