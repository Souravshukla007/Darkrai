# Darkrai release verification (2026-11-06)

What was run, on what, and what came out, for the release pass that hardened the engine, the popup and the test harness before the first push. Every number below comes from a run on 2026-11-06 on the development machine (Windows, Node v24.12.0). The headless suites used a local `chrome-headless-shell` 149; the real-Chrome suite used installed Google Chrome **157.0.8103.39** on a fresh throwaway profile.

## Suites

| Suite (run from `tests/`) | In place | Fresh-clone copy |
|---|---|---|
| `node --test` | 171 tests, 171 pass, 0 fail | 171 tests, 171 pass, 0 fail |
| `node browser/run-fixtures.js` | 13 of 13 fixtures PASS, "all fixture checks passed" | 13 of 13 PASS, the same readings |
| `node browser/run-ui-checks.js` (`DARKRAI_UI_FAMILY` cleared) | all 11 families PASS, "all UI checks passed" | every family PASS except **(f) popup paint**: median 108 ms (160, 108, 104), and on the one allowed re-run of (f) 124 ms (132, 60, 124), against the 100 ms budget. (j) 27 / 92 / 20 identical, (g) 7 steps 0 failed, (k) all selects PASS |
| `node fixtures/run-colour-fixtures.js` | PASS in the E2 step | PASS |
| `node fixtures/run-rapid-toggle.js` | PASS in the E1 step | PASS, 0 long tasks, style set equal to the fresh load |
| `node browser/check-manifest.js` | 34 declared paths resolve, 6 of 6 icon gates, native-16 at 0.608 of on-16's ink mass, exit 0 | identical |
| `node browser/dom-contract.js compare browser/dom-contract.before.json <snapshot>` | 281 items, 1 difference: the deliberate `#lcd-art` src `screen-art.png` -> `art/lcd-darkrai.png` | not run |
| `node browser/run-perf.js <file>` | 7 fixtures measured (table below) | 7 fixtures measured on headless 148: decision -> first paint 2.2-3.5 ms, settled 9.0-16.0 ms after the decision, native-dark 0 style nodes / 0 adopted / 0 measured; its temp profile was removed (the in-place run before the cleanup fix had left one behind) |

The fresh-clone copy is every file that will be committed (everything except the git-ignored paths), copied to a folder outside the project and run from there with no environment variables set, so nothing depends on where the repository sits. In place, discovery found chrome-headless-shell 149.0.7790.0 two folders above the repository; from the copy it found the one under `~/.cache/puppeteer` (148.0.7778.97), so the copy also ran on a different headless build.

Oracles held at the end of the pass:

- UI (j) behaviour replay: 27 actions, 92 `chrome.*` calls and 20 storage writes, identical to `tests/browser/popup-behaviour.baseline.json`.
- UI (f) popup paint: 100, 68, 36 ms (median 68 ms) and then 80, 64, 40 ms (median 64 ms) in the two full runs in place, against the 100 ms budget. **From the fresh-clone copy it missed the budget twice** (medians 108 and 124 ms) on chrome-headless-shell 148.0.7778.97, with the same files byte for byte. The unbudgeted Options page slowed by the same factor there (medians 100 and 124 ms against 56-64 ms in place), which points at the headless build or a cold file cache rather than the code; it is reported as a miss, and the budget was not touched.
- UI (g) hard-reset dialog: 7 steps, 0 failed, against the shim.
- UI (k): every select on both pages themed and inside the viewport; the popup's Schedule list at the panel bottom opens above its pill (y 399.5-499.5, 6 px gap, 304 px wide); Esc on an open list closes only the list.
- Fixtures: `native-dark.html`, `meta-dark.html` and `runtime-theme-switch.html` at 0 style nodes and 0 adopted sheets.
- Manifest: permissions `storage`, `scripting`, `alarms`; hosts `http://*/*`, `https://*/*`; storage schema 2 and its keys unchanged; the `--dr-` prefix, `data-darkrai` and `data-dr-id` markers and the product name unchanged.

## Performance before and after (`run-perf.js`, headless, one solo run each)

"Before" is the start of the pass (07:50 UTC), "after" is the end (14:19 local), both alone on the machine. The spans are measured from Darkrai's own decision mark; the absolute decision time carries the fixture's load.

| fixture | decision ms | first paint after decision (ms) | settled after decision (ms) | change in settle | style nodes | adopted | guard measured | RecalcStyleCount |
|---|---|---|---|---|---|---|---|---|
| light.html | 164.8 -> 111.5 | 3.4 -> 3.0 | 14.9 -> 8.3 | -44% | 2 -> 2 | 0 -> 0 | 24 -> 24 | 7 -> 7 |
| css-variables.html | 65.2 -> 55.6 | 6.8 -> 5.4 | 16.6 -> 13.6 | -18% | 2 -> 2 | 2 -> 1 | 12 -> 12 | 9 -> 8 |
| inline.html | 73.1 -> 52.7 | 2.8 -> 2.9 | 11.6 -> 9.8 | -16% | 1 -> 1 | 1 -> 1 | 14 -> 14 | 9 -> 8 |
| low-contrast.html | 92.8 -> 59.8 | 3.2 -> 1.7 | 9.8 -> 8.0 | -18% | 2 -> 2 | 1 -> 1 | 12 -> 16 | 8 -> 8 |
| shadow-dom.html | 257.3 -> 60.4 | 3.0 -> 2.6 | 13.5 -> 12.2 | -10% | 2 -> 2 | 3 -> 3 | 19 -> 20 | 6 -> 8 |
| small-icons.html | 296.9 -> 65.5 | 3.2 -> 2.8 | 13.7 -> 15.9 | +16% | 2 -> 2 | 2 -> 2 | 17 -> 24 | 14 -> 8 |
| native-dark.html (control) | 159.0 -> 93.2 | nothing to time | nothing to time | n/a | 0 -> 0 | 0 -> 0 | 0 -> 0 | 7 -> 4 |

No fixture's settle time grew by more than 20%. PLAN 6.9's targets hold: decision -> first paint 1.7-5.4 ms (under 20 ms of blocking work before first paint), 8-16 ms to idle after the decision (about 150 ms budget), and the already-dark control at 0 style nodes, 0 adopted sheets and 0 elements measured.

## Probe changes in this pass, with their evidence

No threshold, budget or gate moved. Each change below follows a failure that was shown to be a measurement artifact, or makes a probe stricter.

- **UI shim, dynamic content scripts** (`tests/shim/chrome-ui-shim.js`): `getRegisteredContentScripts` answered `[]` to every call and `registerContentScripts` stored nothing. The hard reset now reads its registration back, so UI (g) failed with "Chrome holds no early dark background" against the shim while real Chrome's P3-reset passed with the same code. The shim now keeps what it is given (register, unregister, read back by ids), as lenient as before, so no call path changed: (j) still records 27 actions, 92 calls and 20 writes.
- **UI (k), default-blue grid** (`tests/browser/run-ui-checks.js`): the 3 "blue" samples on the Options page's Reset-this-site list, (93 175 239) at 551,494, 563,494 and 542,497, sit on the glyph stems of the checked option's label, between the ink (19 22 28) and the silver row (234 235 238), each with an orange (207 141 60) twin on the other side of the stem: LCD subpixel text anti-aliasing. The grid now skips each option label's glyph boxes (1 px either side). A real UA highlight is a row background and shows all round the label, so it is still caught.
- **Real-Chrome icon probe** (`tests/real-chrome/probe.js`): skips elements with a `*-noicon` class or their own text. Wikipedia's "Talk" tab matched `[class*="icon"]` only through `vector-tab-noicon`; its 90th-percentile pixel fell on an anti-aliased edge (2.94:1) while its solid glyph pixels read 6.89:1, and the text probe passes it.
- **Real-Chrome text probe**: text in `:disabled` / `[aria-disabled="true"]` controls is counted as exempt, not judged (WCAG 1.4.3 exempts inactive components). Reddit's disabled "Log In" is rgba(255,255,255,0.247) on #181c1f, and the site's own light page draws it rgba(0,0,0,0.247) on white.
- **New P1-3L light-region check**: light regions in the same 1280 × 800 shot, each explained by what paints it (media, a `url()` background, an ad creative, a media-only frame) or reported. The first version found nothing on Wikipedia because a fade reaches luminance 0.7 only in its last 3 rows; growing regions through neutral pixels of OKLCH L >= 0.5 made it stricter, and re-run offline on the earlier shot it found both fades and the Moon photo.
- **New P1-1c-main-thread check**: a long-task observer in the page plus a `Runtime.evaluate('1')` probe every 200 ms during and after the 20 toggles.

## Real Chrome

Three runs of `node real-chrome/run-real-chrome.js` against the repository's own `extension/` folder, with `DARKRAI_EXTENSION`, `DARKRAI_RESULTS` and `DARKRAI_CHROME` unset: run 1 full (`2026-11-06T08-55-09-476`, 402 s), runs 2 and 3 `--only=problem1,p4,p3` (`2026-11-06T09-10-38-113`, 349 s; `2026-11-06T09-17-10-121`, 325 s). Each closed Chrome with `Browser.close` and removed its throwaway profile. Before and after every run no harness Chrome or node process was left, matched by command line on the profile root, with one exception: run 1's node process printed its report and then did not exit (idle, no child left) and was stopped by its PID.

"PASS / ran" counts NOT RUN as not ran. "-" means the check is not in that run's group.

| Check | Pri | Run 1 | Run 2 | Run 3 | PASS / ran |
|---|---|---|---|---|---|
| P1-2a YouTube dark -> native, 0 style nodes, 0 adopted | P1 | PASS | - | - | 1 / 1 |
| P1-2b YouTube light -> darkened | P1 | PASS | - | - | 1 / 1 |
| P1-2c MDN live theme switch, no reload | P1 | PASS | - | - | 1 / 1 |
| P1-3 readability, Wikipedia (Moon) | P1 | PASS | - | - | 1 / 1 |
| P1-3L light regions, Wikipedia | P1 | PASS | - | - | 1 / 1 |
| P1-3 / P1-3L Hacker News | P1 | PASS / PASS | - | - | 2 / 2 |
| P1-3 / P1-3L MDN | P1 | PASS / **FAIL** | - | - | 1 / 2 |
| P1-3 / P1-3L BBC News | P1 | PASS / **FAIL** | - | - | 1 / 2 |
| P1-3 / P1-3L Stack Overflow | P1 | PASS / PASS | - | - | 2 / 2 |
| P1-3 / P1-3L old.reddit (login page) | P1 | PASS / PASS | - | - | 2 / 2 |
| P1-3 / P1-3L YouTube light | P1 | PASS / PASS | - | - | 2 / 2 |
| P1-1a popup while the worker sleeps | P1 | PASS | PASS | PASS | 3 / 3 |
| P1-1b Never / Auto, no reload | P1 | PASS | PASS | PASS | 3 / 3 |
| P1-1c 20 rapid toggles end consistent | P1 | **FAIL** | **FAIL** | **FAIL** | 0 / 3 |
| P1-1c-main-thread tab answers within 1 s | P1 | **FAIL** | **FAIL** | **FAIL** | 0 / 3 |
| P1-1e restricted pages (4 checks: chrome://extensions, chrome://settings, Web Store, PDF) | P1 | 4 PASS | 4 PASS | 4 PASS | 12 / 12 |
| P1-1f physical Alt+Shift+D | P1 | NOT RUN | NOT RUN | NOT RUN | allowed: not automatable |
| P1-1d old tab after extension reload | P1 | FAIL ("no new service worker") | NOT RUN | NOT RUN | allowed: crbug.com/402532200 |
| P4-always-youtube | P4 | PASS | PASS | PASS | 3 / 3 |
| P4-master | P4 | PASS | PASS | PASS | 3 / 3 |
| P4-shot | P4 | PASS | NOT RUN | PASS | 2 / 2 |
| P4-fit | P4 | PASS | PASS | PASS | 3 / 3 |
| P4-never-auto | P4 | PASS | PASS | PASS | 3 / 3 |
| P4-engine | P4 | PASS | PASS | PASS | 3 / 3 |
| P4-brightness | P4 | PASS | PASS | PASS | 3 / 3 |
| P4-persist | P4 | PASS | PASS | PASS | 3 / 3 |
| P4-pick | P4 | PASS | PASS | PASS | 3 / 3 |
| P4-schedule | P4 | PASS | PASS | PASS | 3 / 3 |
| P4-dropdowns | P4 | PASS | PASS | **FAIL** | 2 / 3 |
| P4-reset-site | P4 | PASS | PASS | PASS | 3 / 3 |
| P4-hard-reset | P4 | PASS | PASS | PASS | 3 / 3 |
| P4-options | P4 | PASS | PASS | PASS | 3 / 3 |
| P4-reload | P4 | PASS | PASS | PASS | 3 / 3 |
| P4-shortcut-key | P4 | PASS | PASS | PASS | 3 / 3 |
| P4-shortcut-proxy | P4 | PASS | PASS | PASS | 3 / 3 |
| P3-reset hard reset from options.html#danger | P3 | PASS | PASS | PASS | 3 / 3 |
| P2-gh-dark | P2 | FAIL | - | - | allowed: GitHub does not render dark under emulation |
| P2-gh-light | P2 | PASS | - | - | 1 / 1 |
| P2-g-dark | P2 | PASS | - | - | 1 / 1 |
| P2-g-light | P2 | NOT RUN | - | - | allowed: Google's bot check |
| P2-errors | P2 | PASS | - | - | 1 / 1 |

Totals: problem 1 checks other than the allowed P1-1f / P1-1d, 18 of 24 PASS (all six misses are P1-1c and P1-1c-main-thread); problem 2, 3 of 3; problem 3, 12 of 14 (the misses are the MDN and BBC light regions); P4, 49 of 51 (one NOT RUN, one FAIL, both the popup closing mid-check); P3, 3 of 3.

What failed, with the evidence:

- **P1-1c** (open, also failing before the pass): no duplicates in any run, but the style set never equalled a fresh load ({1 base, 17 override}, 4 adopted). After the toggles: run 1 on with {1, 5} and 3 adopted; run 2 on with {1, 6} and 3 adopted; run 3 `data-darkrai="off"` with {1, 4} and 2 adopted while storage and the switch said on. Pre-pass run `2026-11-03T18-00-23-469`: on with {1, 4} and 3 adopted. Likely mechanism, not verified: `popup.js` re-injects the page script when the tab does not answer within 700 ms, and a new copy takes the old one down mid-apply.
- **P1-1c-main-thread** (open): longest task 54 / 108 / 0 ms and total blocking 4 / 66 / 0 ms across the three runs, so Darkrai's page work no longer blocks, but 2, 3 and 3 `Runtime.evaluate` probes after the burst went unanswered for more than 5 s.
- **P1-3L MDN** (open): a 1265 × 56 region at the top, painted rgb(255, 255, 255) by `div.top-placement` inside the open shadow root of `mdn-placement-top`.
- **P1-3L BBC** (open): a 728 × 90 cross-origin Google safeframe (`google_ads_iframe_/4817/bbccom/news/news_home/index/top_0`) with its whole box bright, the frame element at `color-scheme: dark`. The probe cannot see inside a cross-origin frame.
- **P4-shot run 2 / P4-dropdowns run 3**: `Session with given id not found`, the popup target was gone (once during a 900 ms wait, once on a real click on "True black"). `popup.js` only closes itself after the picker, Options, Hard reset… and Reload, so neither close is a Darkrai code path.

Readability and light regions per site (run 1; targets 4.5:1 text, 3:1 large text and icons):

| Site | Text below / measured | Exempt (disabled controls) | Icons below / measured | Light regions unexplained / found |
|---|---|---|---|---|
| Wikipedia (Moon) | 0 / 110 | 0 | 0 / 14 | 0 / 1 (the Moon photo) |
| Hacker News | 0 / 230 | 0 | 0 / 1 | 0 / 0 |
| MDN (CSS) | 0 / 48 | 0 | 0 / 0 | 1 / 1 |
| BBC News | 0 / 34 | 0 | 0 / 3 | 1 / 4 (3 are images) |
| Stack Overflow | 0 / 94 | 2 | 0 / 5 | 0 / 0 |
| old.reddit (login page) | 0 / 15 | 3 | 0 / 5 | 0 / 0 |
| YouTube light | 0 / 7 | 3 | 0 / 13 | 0 / 0 |

Darkrai's own UI screenshots from run 1 are committed in `tests/real-chrome/evidence/`: `popup-real.png` (360 × 600), `popup-dropdown-look.png`, `popup-dropdown-schedule.png`, `popup-dropdown-schedule-bottom.png`, `options-dropdown.png`. Screenshots of third-party sites stay in the git-ignored `tests/real-chrome/results/`.

## Manual checklist (what automation cannot do)

- Press the physical **Alt+Shift+D** on a darkened page: it goes undarkened without a reload and the toolbar icon turns colourless; press again and both come back. CDP cannot send browser accelerators, so P1-1f is NOT RUN by design; P4-shortcut-key checks the binding and P4-shortcut-proxy calls the handler.
- **Reload the extension** at `chrome://extensions`, then use a tab that was already open (open the popup, toggle). A CDP-loaded unpacked extension stays disabled after a scripted reload (crbug.com/402532200), so P1-1d cannot cover it.
- **Click the real toolbar icon** and look at the popup: red Pokedex casing, both Poke Balls and the LCD art whole, only the dark screen scrolls.
- **GitHub in its own dark theme** (it does not render dark under an emulated scheme) and **a Google results page** (the throwaway profile meets the bot check).
- The rest of the README's manual checklist.
