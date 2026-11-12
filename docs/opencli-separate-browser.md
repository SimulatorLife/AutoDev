# opencli in a separate browser: findings and design

Status: **investigated, not implemented.** This document records the
2026-11-11 investigation into moving the opencli providers
(`opencli-chatgpt`, `opencli-gemini`) out of the user's own Chrome. It is
subordinate to [`provider-routing.md`](provider-routing.md), which remains the
authority for how the opencli bridge works today.

## Problem

The opencli bridge drives the user's everyday, signed-in Chrome through
opencli's Browser Bridge extension. When the user is working in that Chrome at
the same time:

- Turns run in an opencli "automation window" that holds a pool of
  persistent site tabs (`OPENCLI_SITE_SLOTS`, one tab per concurrent turn the
  route admits; see `processRunner` and `SiteTabs` in
  `runtime/src/providers/opencli.ts`). Chrome only renders a window's active
  tab, so opencli activates slot tabs, and that is visible as tabs switching
  under the user.
- `chatgpt model <level>` drives ChatGPT's model picker with native input,
  which needs the opencli window visible and uncovered ("Native input requires
  a visible browser page").
- The user cannot tell whether closing one of those tabs breaks an agent.

The question was whether opencli can use headless tabs instead and, if not,
what would keep agents out of the user's browser.

## What happens today when a user closes an opencli tab

From the bridge's contract in `provider-routing.md` (not exercised live in this
investigation):

- Every turn is one opencli command that opens its own chat by id
  (`--conversation <id>` or `--new`) and confirms the tab shows that chat
  before sending. A tab that was moved or replaced between turns is harmless.
- A tab closed **before** the prompt was sent fails the attempt as
  `not_sent`, and the bridge retries the command, which opens the chat again
  in a free slot tab.
- A tab closed **while a reply is running** fails that turn. Codex replays
  it, which costs time and can leave the prompt twice in the site's chat.
- Closing the automation window is the same; opencli recreates it on the next
  command.

So closing a tab does not break the session, but it does cost turns.

## opencli's browser options

opencli's browser-backed commands accept three options that look relevant.
These behaviours come from opencli 2.0.3 and the Browser Bridge extension
1.0.27 (`dist/background.js`). None of them would stop the interference.

| Option | What it does | Use for AutoDev |
|---|---|---|
| `--window foreground\|background` | Whether opencli's automation window is focused. `background` creates the window with `focused: false` and never focuses it; `foreground` calls `windows.update({ focused: true })` on every command. | Adapter commands already default to `background` (only `opencli browser` sessions default to `foreground`), and AutoDev passes no override. Passing `--window background` explicitly would only pin that default against a future opencli change. |
| `--site-session ephemeral\|persistent` | `persistent` keeps a long-lived site tab that later commands reuse; `ephemeral` borrows a one-shot tab and releases it when the command ends. | `chatgpt ask-file` and `gemini ask` declare `siteSession: 'persistent'`, and `OPENCLI_SITE_SLOTS` requires it. Ephemeral would load a fresh tab every turn: slower, and more tab churn. It is needed only for the direct-CDP design below, which rejects the slot pool. |
| `--keep-tab true\|false` | Keeps a one-shot tab's lease after the command instead of releasing it. | Applies only to ephemeral sessions, so it has no effect on AutoDev today. |

Inside the automation container, the extension still makes each command's
tab the active one (`tabs.update(..., { active: true })`), because Chrome only
fully renders a window's active tab. No option turns that off.

The extension finds its container by looking for its own "OpenCLI" tab group
in **any** window (`ensureOwnedContainerGroup`). If that group ends up in a
window the user is working in, for example after tabs were dragged between
windows, turns run in that window, and tab activation and new tabs happen in
front of the user. This is the most likely cause of the reported tab
switching, but it was not confirmed on the affected machine. Moving the
group back into its own window should stop it. A second, also unverified,
possibility is that Chrome on macOS brings the app forward when the extension
creates the container window, despite `focused: false`.

## How opencli can reach a browser

opencli 2.0.3 has two transports, chosen by `getBrowserFactory()` in
`dist/src/runtime.js`:

| | Browser Bridge (today) | Direct CDP |
|---|---|---|
| Selected by | default | `OPENCLI_CDP_ENDPOINT` set |
| Browser | any Chrome profile running the Browser Bridge extension | any Chromium started with `--remote-debugging-port` |
| Needs extension | yes | **no** |
| Shared daemon | yes: one machine-wide daemon on fixed port `19825` (`OPENCLI_DAEMON_PORT` is rejected) | no daemon |
| Site tab pool (`OPENCLI_SITE_SLOTS`) | yes | **rejected**: `OPENCLI_SITE_SLOTS requires Browser Bridge; use --site-session ephemeral with a direct CDP endpoint.` |
| Tab selection | daemon hands each command a free slot tab | attaches to **one existing** target: the highest-scoring page from `/json`, preferring `OPENCLI_CDP_TARGET` (URL/title substring), or the exact target when the endpoint is a `ws://` target URL |
| Multiple browsers | one connected extension per Chrome profile; with more than one connected, commands must name one (`OPENCLI_PROFILE` / `--profile`) or they fail | one endpoint per command |

## Tests run

All tests used Playwright's **Chrome for Testing 153.0.8010.12**
(`~/Library/Caches/ms-playwright/chromium-1243/`), launched with its own
throwaway `--user-data-dir` and `--remote-debugging-port`. None of them touched
the user's Chrome or the shared opencli daemon; live AutoDev ChatGPT turns were
running through that daemon at the time.

The opencli build used was the one the live bridge runs (the
`@jackwener+opencli@2.0.3_patch_hash=daf235…` pnpm store entry). An older
patched build left in the pnpm store failed to load the Gemini adapter
(`ADAPTER_LOAD … Unexpected identifier 'standard'`), so the build matters when
reproducing these tests.

| # | Setup | ChatGPT | Gemini |
|---|---|---|---|
| 1 | Headless (`--headless=new`), signed out, page load only | **Blocked**: stuck on Cloudflare's "Just a moment..." page. The user agent is `HeadlessChrome/153…` | Loads, composer present |
| 2 | Separate **visible** instance, signed out, page load only | Loads normally, no challenge | Loads normally |
| 3 | Visible instance + opencli over CDP, with `OPENCLI_SITE_SLOTS` set (as AutoDev runs it) | Refused before running: `OPENCLI_SITE_SLOTS requires Browser Bridge` | same |
| 4 | Visible instance + opencli over CDP, `--site-session ephemeral`, signed out | `ask-file` refused: "requires an authenticated session with an active composer" | `gemini ask --new` returned `pong` |
| 5 | Visible instance, **user signed in** to both sites in that profile | `chatgpt ask-file --inline true --new true` returned `pong` in about 24 s | First account was a Google Workspace account with Gemini turned off by its admin (`access.workspace.google.com/…/ServiceNotAllowed`). After switching account in the Gemini account switcher, `gemini ask --new` returned `pong` in about 9 s, on a signed-in page |

Commands, for reproduction (`$OPENCLI` is the live bridge's opencli
`dist/src/main.js`):

```bash
"$CFT_BINARY" --remote-debugging-port=9334 --user-data-dir="$PROFILE_DIR" \
  --no-first-run --no-default-browser-check https://chatgpt.com/ https://gemini.google.com/app
```

```bash
OPENCLI_CDP_ENDPOINT=http://localhost:9334 OPENCLI_CDP_TARGET=chatgpt \
  node "$OPENCLI" chatgpt ask-file "Codex agent turn turn-test." --file turn-test.md \
  --inline true --new true --site-session ephemeral --timeout 180 -f json
```

```bash
OPENCLI_CDP_ENDPOINT=http://localhost:9334 OPENCLI_CDP_TARGET=gemini.google.com \
  node "$OPENCLI" gemini ask "Reply with just the word pong." \
  --new true --site-session ephemeral --timeout 180 -f json
```

Not tested:

- concurrent turns on one site, or on both sites at once, in the separate
  browser;
- continuing an existing chat (`--conversation <id>`), model or effort
  switching (`chatgpt model`, Gemini `--model`), `gemini models`, and file
  attachments (non-inline `ask-file`);
- behaviour with the window minimised, covered, or on another macOS Space;
- the Browser Bridge extension loaded into the separate browser (not run,
  because connecting a second profile to the shared daemon would have made
  live, profile-less commands ambiguous).

## Why not headless

1. **ChatGPT blocks it.** Cloudflare holds headless Chrome on its challenge
   page. Getting past that means disguising the browser (user-agent spoofing
   and similar), which is evading a bot check. That is against the site's
   terms, risks the account, and is out of scope for AutoDev.
2. **The extension transport cannot be headless.** The Browser Bridge lives in
   the user's running, visible Chrome profile; one window of a running Chrome
   cannot be made headless.
3. **Some site actions need a visible page.** ChatGPT's model picker needs
   native input on a visible page. AutoDev's patch falls back to the site's
   settings API, so this matters less than (1).

Gemini did load headless, but a design that serves one site headless and the
other headful buys nothing over running both headful in a separate browser.

## Recommended direction: a dedicated, visible browser over CDP

Run opencli against a separate Chromium instance that only AutoDev uses,
through the direct CDP transport.

### Pros

- The user's own Chrome is never touched: no tab switching, no automation
  window, and no risk from closing tabs there.
- No dependency on the Browser Bridge extension or the shared daemon on port
  `19825`. That removes the stale-daemon handling (`STALE_DAEMON` in
  `opencli.ts`), extension-version drift, and the "multiple connected
  profiles" ambiguity.
- Both sites accepted the browser: no Cloudflare challenge, Google sign-in
  worked with the debugging port open, and real signed-in turns succeeded on
  both sites.
- The bridge owns the browser's lifecycle, so it can tell "browser not
  running" apart from "site failed" and start the browser itself.

### Cons

- **AutoDev must own the tab pool.** Direct CDP rejects
  `OPENCLI_SITE_SLOTS` and attaches to one existing target per command. The
  bridge has to open and track its own tabs and point each command at exactly
  one of them.
- **Separate sign-in.** The user signs in to ChatGPT and Gemini once in the
  dedicated profile, and again whenever a site expires the session. With more
  than one Google account signed in, Gemini can open under the wrong one, as
  seen in test 5.
- **A browser to install and keep current.** Chrome for Testing does not
  auto-update. A long-lived, signed-in browser that never updates is a
  security liability, so the installer has to pin a version and refresh it.
- **The debugging port is powerful.** Any local process that can reach it
  can drive the signed-in sessions. Chrome binds it to `127.0.0.1`, but this
  is still a wider exposure than an extension that only talks to opencli's
  daemon.
- **It is still a visible window.** It has to live somewhere: another macOS
  Space, or behind other windows, with the occlusion questions below.

## Design considerations for implementation

### Browser binary and profile

- Use Chrome for Testing (or Chromium), not the user's branded Chrome.
  Branded Chrome refuses `--remote-debugging-port` on its default profile,
  and running a second branded Chrome would share the user's app identity
  and dock icon.
- Do not depend on Playwright's cache path. The installer should install a
  pinned version through a supported channel (for example
  `@puppeteer/browsers`) and record its path, the same way
  `runtime/src/shared/executables` resolves other CLIs.
- Keep the profile in a stable AutoDev-owned directory outside the
  repository. It holds session cookies and must never be committed or synced.
- Launch flags: `--user-data-dir`, `--remote-debugging-port` (fixed and
  dedicated to AutoDev, or `0` with the port read back from
  `DevToolsActivePort`), `--no-first-run`, `--no-default-browser-check`.
  Whether background throttling flags
  (`--disable-backgrounding-occluded-windows`,
  `--disable-renderer-backgrounding`) are needed is unknown until the
  occlusion test below is run.

### Lifecycle ownership

- The opencli bridge (or the installer's LaunchAgent for it) starts the
  browser if `/json/version` on its port does not answer, and reports a
  distinct health state for "browser not running" versus "site signed out",
  so the router and Console can tell the user what to do.
- A signed-out site should surface as an actionable error with the
  dedicated browser's URL, not as a generic provider failure.
- Decide whether quitting the dedicated browser is the user's way to pause
  opencli providers, or whether the bridge relaunches it.

### Tab pool

- The bridge opens one tab per concurrent turn per site (the route's
  `maxConcurrentRequests`, as `routedSiteTabs` computes today) through
  `PUT /json/new`, keeps each tab's `webSocketDebuggerUrl`, and runs each
  opencli command with `OPENCLI_CDP_ENDPOINT` set to **that tab's `ws://`
  URL**, so two commands can never attach to the same tab.
  `OPENCLI_CDP_TARGET` alone is not enough: with several tabs on one site,
  every command would pick the same highest-scoring one.
- `SiteTabs` already serialises commands per tab. It would hand out a tab's
  endpoint rather than rely on opencli's daemon to pick a free slot.
- A tab that is closed or crashes (its WebSocket target disappears) is
  replaced before the next turn, and the turn running in it fails with the
  existing `not_sent` / retryable classification.
- `--site-session ephemeral` is required on every command in this mode.
  Whether opencli releases or navigates the tab afterwards in ephemeral CDP
  mode needs checking. In the tests the tabs stayed open on the last chat.

### Removal of the extension path

Per the repository rule against compatibility shims, implementing this
replaces the Browser Bridge path rather than running both. It removes:
`OPENCLI_SITE_SLOTS` construction (`opencliSiteSlots`), stale-daemon
recovery, the Browser Bridge requirement in `provider-routing.md`, and any
installer or doctor checks for the extension. `local-setup.md` gains the
dedicated browser's install, profile, and sign-in steps. The change also
updates `tests/providers/opencli.test.ts` and the opencli routing tests to
the new ownership.

### Things to verify before or during implementation

1. Concurrent turns: two ChatGPT tabs and one Gemini tab running at once,
   each on its own `ws://` endpoint.
2. Occlusion: turns with the window minimised, fully covered, and on another
   Space, both without and with the background-throttling flags. Chrome
   throttles occluded windows on macOS, and the opencli README already notes
   that only a window's active tab renders.
3. `chatgpt model <level>` native-input switching in a covered window, and
   its settings-API fallback.
4. Non-inline `ask-file` attachments, and the upload accounting in
   `opencli.ts`, which is per account and so unaffected by the browser
   change.
5. Session longevity: how often each site signs the dedicated profile out.
6. Whether the AutoDev opencli patch (`patches/@jackwener__opencli@2.0.3.patch`)
   relies on anything the Browser Bridge provides that `CDPPage` does not:
   `tabs()`/`selectTab()` are no-ops in CDP mode, and network capture and
   native input go through different code paths.

## Alternative considered: Browser Bridge extension in the separate browser

Loading the Browser Bridge extension into the dedicated browser
(`--load-extension`, which Chrome for Testing still supports) would keep
opencli's own tab pool. It was not chosen because:

- the daemon is shared and fixed on port `19825`, so the dedicated browser
  and the user's own Chrome (if it still has the extension) would both
  connect. Every command must then carry `OPENCLI_PROFILE`, and any opencli
  user outside AutoDev on that machine would hit the multi-profile error;
- it keeps the stale-daemon and extension-version coupling that the CDP path
  removes;
- the extension only works in a headful browser too, so it offers no
  headless advantage.

It remains the fallback if direct CDP turns out to lack something the patched
adapters need (item 6 above).
