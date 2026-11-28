# opencli in a separate browser: findings and design

Status: **dedicated browser is the only site-command path in current source;
live native-input, occlusion and session-longevity acceptance remains.**
This document records the 2026-11-11 investigation into moving the opencli
providers (`opencli-chatgpt`, `opencli-gemini`) out of the user's own Chrome.
It is subordinate to [`provider-routing.md`](provider-routing.md) and the
[canonical target](autodev-console-target-state.md#role-oriented-execution-and-provider-routing).

## Implementation status

The source no longer uses the former opt-in Dedicated browser toggle or
the shared Browser Bridge extension for recognized site commands. The
following describes the dedicated owner; the installed revision must be
verified separately.

The bridge owns a separate headed Chromium process, an AutoDev-private
profile, a loopback-only ephemeral CDP port, and a per-site tab pool capped by
the admitted route concurrency. Nothing in it opens before a turn needs it:
see [Lazy opening and reuse](#lazy-opening-and-reuse). Every opencli command gets the exact WebSocket
target for its leased tab and uses `--site-session ephemeral`; AutoDev replaces
a closed target before the next command. The Browser Bridge extension, its
shared daemon, and `OPENCLI_SITE_SLOTS` are not part of this mode. The
typed installer places the Playwright-pinned Chromium in
`$CODEX_HOME/provider-runtime/opencli/browsers`; user sign-in is kept in
`$CODEX_HOME/run/opencli-browser-profile`. See [`local-setup.md`](local-setup.md)
for setup and [`provider-routing.md`](provider-routing.md) for the runtime
contract.

Source change (2026-11-25; installed revision and live acceptance pending):
XACPX role turns use the same authenticated loopback browser service as
other OpenCLI turns. The dedicated browser activates the exact leased CDP
target before foreground-sensitive operations and releases foreground after
confirmed submission or process settlement; cancellation quarantine retains
ownership when necessary.

Activation raises the leased page itself. The browser-level
`Target.activateTarget` only focuses the target inside its own window, so the
page-domain `Page.bringToFront` follows it: that call is what un-minimizes the
window and brings it forward when it was covered or on another macOS Space.
Nothing spoofs `document.visibilityState`, the upstream native-input guard
stays intact, and the site still decides whether it accepts the input. After
activation the browser reads the page's own `document.visibilityState` and
reports a page that stayed hidden, naming the operator action, instead of
letting the native click fail later with an opaque message. A page whose
visibility cannot be observed at all is left to the site's own guard.

The most recent observed live probe still failed the native visible-page
guard; that probe predates the page-level activation.

The owner now shares startup and health checks as one readiness transaction,
publishes readiness only after the target pool is built, refuses to restart
on a transient health failure while commands are active, and ignores stale
target inventories and stale-generation completion. Lease waiters recheck a
change revision so a release during an asynchronous inventory request cannot
be missed. Target replacement does not proceed while foreground is held or
the missing slot is still leased. Regression fixtures cover concurrent
startup, concurrent recovery of a lost slot, and failed health checks during
active execution. These new fixtures have not been executed locally.

The foreground lease is required only by the operations that actually use native input. Reading the installed opencli 2.0.3 shows that attaching a ChatGPT app and enabling a site tool open the composer's menu with an unguarded native click, which a hidden page refuses, while ChatGPT's prompt path inserts text and clicks submit programmatically and Gemini's adapter never clicks natively at all.

Model selection is the subtle case, and it is the one that produced the reported failure. `selectChatGPTModel` tries the reasoning slider and the model menu with native input. AutoDev's patch catches exactly the visibility refusal and falls back to the site's own settings API (`user_last_used_model_config`), which needs no visible page -- but only the models that API covers. `advanced`, `pro` and `gpt-5.6-pro` carry a settings-API configuration; `fast`, `balanced` and `very-high`/`xhigh` do not, and for those the visible picker is the only path and the command fails without one. A model switch therefore always takes the foreground, whatever the model.

The requirement is derived from the command (`opencliCommandRequiresForeground`), so a Gemini turn and a plain ChatGPT turn do not take the foreground from each other, and the foreground is released as soon as the prompt has been submitted rather than being held for the whole turn. A background command also waits for the foreground to be free before it replaces a lost tab, because creating a target activates it and would hide the page a native-input turn is holding.

Automated tests cover browser process/readiness, target leasing/replacement,
per-command endpoint isolation, transport-failure health and recovery, bridge
health, and installation wiring. Live
acceptance still needed: occlusion/minimization behavior on macOS, concurrent
signed-in turns across both sites, and session longevity. The earlier sandboxed
network reproduction was blocked before it reached opencli; it is not evidence
that the current environment can perform a live provider turn.

## Historical problem (before dedicated-browser migration)

The former opencli bridge drove the user's everyday, signed-in Chrome through
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

## Historical shared-browser tab behavior

The following records the former bridge contract, not current dedicated
browser acceptance (not exercised live in the original investigation):

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

| | Browser Bridge (historical) | Direct CDP (implemented) |
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
3. **Some site actions need a visible page.** ChatGPT's model picker and its
   app and tool menus need native input on a visible page. AutoDev's patch
   falls back to the site's settings API for the models that API covers, so
   this matters less than (1) -- but not for every model, and never for
   attaching an app or enabling a site tool.

Gemini did load headless, but a design that serves one site headless and the
other headful buys nothing over running both headful in a separate browser.

## Implemented design: a dedicated, visible browser over CDP

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

## Implementation decisions

### Browser binary and profile

- The normal installer runs Runtime's pinned Playwright CLI with
  `install chromium --no-shell`, placing that exact headed Chromium build in
  `$CODEX_HOME/provider-runtime/opencli/browsers`. The bridge accepts only an
  executable resolved from this private cache; it never falls back to the
  user's Chrome or a shared Playwright cache.
- The browser profile lives at `$CODEX_HOME/run/opencli-browser-profile`,
  outside the repository, and the bridge creates it with owner-only
  permissions. It holds site cookies and must never be committed or synced.
- Chromium starts with `--user-data-dir`,
  `--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=0`,
  `--no-first-run`, and `--no-default-browser-check`. The bridge reads the
  ephemeral port from `DevToolsActivePort`. No occlusion/background-throttling
  flags are enabled until the macOS acceptance checks establish a need.

### Lifecycle ownership

- The bridge listens at once and starts Chromium on the first command that
  needs a site page, never at service start. A browser that is not running
  is not a fault: health stays green, because the next turn starts it. A
  failed launch or a CDP target-transport failure makes health report
  `dedicated_browser_unavailable`, distinct from a site's signed-out state; a
  successful target lease clears it.
- Chromium runs in its own process group and outlives the bridge. A
  restarted bridge (reinstall, `kickstart -k` from the optional-bridge
  ensure, a crash) adopts the running browser and its tabs instead of
  launching another: it reads the profile's `DevToolsActivePort` and accepts
  the browser on that port only when `/json/version` reports the same
  browser WebSocket path, so a stale file or an unrelated listener is never
  adopted. Launching against a profile another Chromium still holds would
  only hand a new window to that browser.
- The operator signs in to each site in the dedicated browser. Quitting that
  browser is not a pause control: the next turn that needs a page relaunches
  it. The bridge never closes it.

### Tab pool

- Each site holds at most one target per concurrent turn (the route's
  `maxConcurrentRequests`, as `routedSiteTabs` computes), and gains one only
  when every tab it already holds is leased. The bridge retains each tab's
  `webSocketDebuggerUrl` and runs each
  opencli command with `OPENCLI_CDP_ENDPOINT` set to **that tab's `ws://`
  URL**, so two commands can never attach to the same tab.
  `OPENCLI_CDP_TARGET` alone is not enough: with several tabs on one site,
  every command would pick the same highest-scoring one.
- `SiteTabs` serializes site/model-sensitive turn scheduling; the browser
  owner leases each command a distinct target instead of relying on opencli's
  daemon to pick a free slot.
- A tab that is closed or crashes (its WebSocket target disappears) is
  forgotten, and the next turn that needs one finds or opens another; the
  turn running in it fails with the existing `not_sent` / retryable
  classification.
- `--site-session ephemeral` is required on every command in this mode.
  Whether opencli releases or navigates the tab afterwards in ephemeral CDP
  mode needs checking. In the tests the tabs stayed open on the last chat.

### Lazy opening and reuse

The operator reported AutoDev opening new browser windows on ChatGPT and
Gemini over and over (2026-11-27). Three causes compounded:

1. The bridge launched Chromium and built the whole tab pool at service
   start, before any turn: one startup window plus one window per tab
   (`Target.createTarget` with `newWindow: true`), five windows for the
   three ChatGPT and one Gemini tabs the routes admit.
2. Every bridge restart killed that browser and did it again. The
   SessionStart optional-bridge ensure (`ensureOpencliProxy`) runs
   `launchctl kickstart -k` whenever `/health/liveliness` is not 200, and
   health was 503 while the eager start ran and after the operator quit the
   browser ("Dedicated Chromium exited unexpectedly"). The live log held 142
   service starts.
3. Gemini model discovery (`gemini models`, polled through `/v1/models`)
   ran through the same lease, so a background probe started the browser
   and opened a Gemini window when nothing else needed one.

The current contract:

- **Lazy.** No browser or tab opens until a turn needs that site's page.
  Health reports a missing executable or a failed launch, not "not started".
- **Find before open.** A site's next tab is, in order: an unclaimed tab
  already on that site's host (one the operator opened to sign in, or one a
  previous bridge left), an unclaimed blank tab such as the one Chromium
  starts with (navigated to the site with `Page.navigate`), and only then a
  new tab in the existing window (`Target.createTarget` without
  `newWindow`; Chromium opens a window only when it has none left). An idle
  tab is always reused before another is opened.
- **Probes observe.** A background probe (`OpencliRunRequest.existingPageOnly`,
  the browser's `shouldOpenPage: false`) runs only on a site tab that is
  already open and never starts the browser, opens, navigates or claims a
  blank tab. Gemini model discovery is the only such probe; without an open
  Gemini tab it lists nothing for that site, and the Runtime's discovery
  service keeps its last non-empty listing.
- **Survive restarts.** See [Lifecycle ownership](#lifecycle-ownership).

ChatGPT's concurrent tabs share one window; only the active tab renders,
which the route already relies on ("ChatGPT answers in background tabs").
A native-input command still activates and raises its own tab first.

Regression tests: `runtime/tests/opencli-browser.test.ts` (nothing opens
before a command; reuse of an open site tab and the startup blank tab; a
probe opens nothing; adoption of a surviving browser and refusal of a
mismatched one; shutdown leaves the browser running; tabs open without
`newWindow`) and `tests/providers/opencli.test.ts` (discovery passes
`existingPageOnly`; the runner maps it to `shouldOpenPage`). Not yet verified
live: needs a Runtime reinstall, after which the bridge restarts once and
adopts the browser already running.

### Removal of the extension path

Per the repository rule against compatibility shims, this implementation
replaces the Browser Bridge path rather than running both. It removed:
`OPENCLI_SITE_SLOTS` construction (`opencliSiteSlots`), stale-daemon recovery,
Browser-Bridge-only `SESSION_BUSY` retry handling, the Browser Bridge
requirement in `provider-routing.md`, and any installer or doctor checks for
the extension. `local-setup.md` documents the
dedicated browser's install, profile, and sign-in steps. The change also
updates `tests/providers/opencli.test.ts` and the opencli routing tests to
the new ownership.

### Remaining live acceptance checks

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

This is a historical alternative, not an enabled fallback. If direct CDP
lacks a required native capability, qualify the upstream limitation and
repair the dedicated path rather than silently restoring shared-browser
execution.
