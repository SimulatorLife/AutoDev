# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: playtesting-usability.spec.ts >> workspace overview distinguishes batches, episodes, findings, and comparisons
- Location: e2e/playtesting-usability.spec.ts:72:1

# Error details

```
Error: browserType.launch: Target page, context or browser has been closed
Browser logs:

<launching> /Users/henrykirk/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell --disable-field-trial-config --disable-background-networking --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-back-forward-cache --disable-breakpad --disable-client-side-phishing-detection --disable-component-extensions-with-background-pages --disable-component-update --no-default-browser-check --disable-default-apps --disable-dev-shm-usage --disable-edgeupdater --disable-extensions --disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion --enable-features=CDPScreenshotNewSurface --allow-pre-commit-input --disable-hang-monitor --disable-ipc-flooding-protection --disable-popup-blocking --disable-prompt-on-repost --disable-renderer-backgrounding --disable-updater-scheduler --force-color-profile=srgb --metrics-recording-only --no-first-run --password-store=basic --use-mock-keychain --no-service-autorun --export-tagged-pdf --disable-search-engine-choice-screen --unsafely-disable-devtools-self-xss-warnings --edge-skip-compat-layer-relaunch --disable-infobars --disable-search-engine-choice-screen --disable-sync --enable-unsafe-swiftshader --headless --hide-scrollbars --mute-audio --blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4 --no-sandbox --user-data-dir=/private/var/folders/tw/cl5h4b6s15j2zlcfl2xfdsh80000gn/T/mcode-sandbox/runtime-9f9b73d7c40bb5607c83b2570f3a77c9/session-f1697e6badfa618129f4a10d1fe30ba9/playwright_chromiumdev_profile-w4nY9E --remote-debugging-pipe --no-startup-window
<launched> pid=57796
[pid=57796][err] [1012/211435.570204:WARNING:net/dns/dns_config_service_posix.cc:197] Failed to read DnsConfig.
[pid=57796][err] [1012/211435.578518:FATAL:base/apple/mach_port_rendezvous_mac.cc:159] Check failed: kr == KERN_SUCCESS. bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.57796: Permission denied (1100)
Call log:
  - <launching> /Users/henrykirk/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell --disable-field-trial-config --disable-background-networking --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-back-forward-cache --disable-breakpad --disable-client-side-phishing-detection --disable-component-extensions-with-background-pages --disable-component-update --no-default-browser-check --disable-default-apps --disable-dev-shm-usage --disable-edgeupdater --disable-extensions --disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion --enable-features=CDPScreenshotNewSurface --allow-pre-commit-input --disable-hang-monitor --disable-ipc-flooding-protection --disable-popup-blocking --disable-prompt-on-repost --disable-renderer-backgrounding --disable-updater-scheduler --force-color-profile=srgb --metrics-recording-only --no-first-run --password-store=basic --use-mock-keychain --no-service-autorun --export-tagged-pdf --disable-search-engine-choice-screen --unsafely-disable-devtools-self-xss-warnings --edge-skip-compat-layer-relaunch --disable-infobars --disable-search-engine-choice-screen --disable-sync --enable-unsafe-swiftshader --headless --hide-scrollbars --mute-audio --blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4 --no-sandbox --user-data-dir=/private/var/folders/tw/cl5h4b6s15j2zlcfl2xfdsh80000gn/T/mcode-sandbox/runtime-9f9b73d7c40bb5607c83b2570f3a77c9/session-f1697e6badfa618129f4a10d1fe30ba9/playwright_chromiumdev_profile-w4nY9E --remote-debugging-pipe --no-startup-window
  - <launched> pid=57796
  - [pid=57796][err] [1012/211435.570204:WARNING:net/dns/dns_config_service_posix.cc:197] Failed to read DnsConfig.
  - [pid=57796][err] [1012/211435.578518:FATAL:base/apple/mach_port_rendezvous_mac.cc:159] Check failed: kr == KERN_SUCCESS. bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.57796: Permission denied (1100)
  - [pid=57796] <gracefully close start>
  - [pid=57796] <kill>
  - [pid=57796] <will force kill>
  - [pid=57796] exception while trying to kill process: Error: kill EPERM
  - [pid=57796] <process did exit: exitCode=null, signal=SIGTRAP>
  - [pid=57796] starting temporary directories cleanup
  - [pid=57796] finished temporary directories cleanup
  - [pid=57796] <gracefully close end>

```