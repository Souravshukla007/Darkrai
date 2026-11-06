# Darkrai

Darkrai is a Chrome extension (Manifest V3) that darkens websites which have no dark theme of their own and leaves the ones that do alone. Every site starts on **Auto**: Darkrai looks at the page's declared colour scheme and samples the real colours on screen, so YouTube, GitHub and anything else with its own dark design keeps it. When Darkrai does darken a page it recolours by role in OKLCH instead of inverting, so hue survives and photos, video and canvas are never touched, then it measures the contrast of the visible text and icons and nudges anything that falls short of WCAG. Clicking the toolbar icon always opens the popup, because the popup reads your settings straight from storage and never waits on the background worker, and switching Darkrai on or off applies live with no page reload.

## Install (Load unpacked, Windows Chrome)

1. Open Chrome and go to `chrome://extensions`.
2. Switch on **Developer mode** (top right).
3. Click **Load unpacked** (top left).
4. Choose the `extension` folder of this repository (in a clone, `<where you cloned it>\extension`).

   Pick the `extension` folder itself, not the repository root and not a zip. Chrome warns that Darkrai can "read and change all your data on all websites" — that is what any dark-mode extension needs in order to restyle pages. Darkrai sends nothing anywhere.
5. Darkrai appears in the list. After editing any file, come back to `chrome://extensions` and press the **Reload** (circular arrow) button on the Darkrai card.

### Pin it to the toolbar

Click the **Extensions** puzzle-piece icon to the right of the address bar, find **Darkrai**, and click the pin next to it. The icon stays visible and shows the state of the current tab. It is one mark — a crescent of night with a trailing wisp and a single warm spark — in three treatments:

- **in colour, solid** — Darkrai is darkening this tab. Violet crescent, crimson spark.
- **ghosted** — the site's own dark theme is in use, left alone. The same coloured mark, its outline opaque and its interior dropped to 45% so the site's own theme reads as showing through. It still has hue, so it is never mistaken for off.
- **colourless** — off for this tab: the master switch is off, the site is set to Never, you are outside the schedule, or Chrome blocks extensions on this page. Every pixel is converted to true greyscale by Rec. 709 luma and dimmed slightly. No hue anywhere.

Colour versus no colour is the difference you see first, at 16 px, on a light toolbar and on a dark one. The 16 and 32 px art is a deliberately simpler drawing than the 48 and 128 px art rather than the same drawing shrunk, so the small sizes stay legible.

The release pass tried building the twelve icons from the Lovable design's Darkrai tile instead. The ghosted (native) 16 px icon then kept only 1.5% of its ink at 3:1 on a white toolbar, 29.1% with a one-pixel rim added, against the 30% gate `check-manifest.js` holds it to, so the icons above stayed. The tile's ghosted interior washes out on white; using it would need a different ghosting for that artwork.

The toolbar mark and the Options page's pixel-art crescent are original to this extension. The popup is not: it follows a design made in Lovable and carries its red Pokedex casing, Poke Ball and Darkrai art, which are fan art of trademarked characters (see [The popup's Lovable design](#the-popups-lovable-design) for the attribution note and how to swap the art out).

### Keyboard shortcut

**Alt+Shift+D** turns Darkrai on or off for the site in the current tab. To change it, open `chrome://extensions/shortcuts` and set a new combination next to "Turn Darkrai on or off for this site". Chrome also lists the shortcut there if another extension has already claimed it.

## How it decides: Auto, Always, Never

The popup's **This site** choice is remembered per site, and subdomains follow the main site unless you set them separately (`music.youtube.com` follows `youtube.com`).

- **Auto** (the default for every site) — Darkrai checks the page first. It reads `<meta name="color-scheme">` and the computed root `color-scheme`, then samples the background at nine points on screen and the colour of the visible text (the body's colour, or, when an app sets its text colour deeper in the page as YouTube does, up to 24 visible text runs against the background behind each). If most of the page is already dark with light text, it leaves the site alone and the popup says "This site's own dark theme, left alone". Otherwise it darkens the page. It keeps watching, so flipping YouTube's Appearance setting or GitHub's theme switch is picked up without a reload.
- **Always** — darken this site no matter what it looks like. Use it for a site whose own dark theme you dislike.
- **Never** — never touch this site. The early dark background is skipped here too, so there is no flash.

Two more switches sit alongside:

- **Mode: Smart or Simple.** Smart recolours the page. Simple inverts the whole page for apps that draw their text on a canvas; Google Docs, Sheets and Slides use it by default.
- **Enabled / Schedule.** The master switch in the popup header turns Darkrai off everywhere. The schedule can be **Always**, **Follow system** (dark only while Chrome or Windows is in dark mode), or **Custom hours** (for example 19:00 to 07:00, which is handled across midnight by a `chrome.alarms` timer).

The **Look** section holds the three presets (Dark gray, True black, Soft) and the brightness, contrast and warmth sliders. These feed the colour maths directly — Smart mode uses no CSS filters — so images stay untouched and there is no GPU cost. "Dim images a little" is the one optional exception, for night use.

**Fix something unreadable** starts the picker: hover or tab to the element, click it (or press Enter), then choose **Make readable** or **Invert this**. The fix is remembered for that site and can be cleared from the Options page. Esc cancels.

The **Options** page (`chrome://extensions` > Darkrai > Details > Extension options, or the Options button in the popup) holds the same look and schedule controls plus your whole site list, with search, per-site editing, per-site fix clearing and removal, and a clearly separated danger area with the two resets.

## The look: the Lovable Pokedex, and when it gives way

The popup is a red Pokedex, 360 × 600 px, matched to the Lovable design described below: a chamfered red casing with four screws, a raised LCD module showing Darkrai, three vent slots, a Poke Ball module top left with the status LED under it, and a bottom strip with speaker dots, a centred Poke Ball and a vent slot. Inside sits the dark screen with the controls and Lucide line icons. The Options page keeps the earlier red header band (LED, small LCD with the pixel-art crescent, title) above the same dark panels. The styles live in `extension/shared/handheld.css` (shared tokens, loaded by both pages), `popup/popup.css` and `options/options.css`.

The device shows the state of the current tab, in three ways at once so no one depends on colour alone:

- **On** (Darkrai is darkening this tab): green LED and status dot with a soft glow, a faint glow behind the LCD art.
- **Native** (the site's own dark theme, left alone): ice-blue LED and dot, the LCD art faded to 60 %.
- **Off**: the half-lit amber LED of the design, a neutral grey dot, the LCD art at full strength.

The status sentence under the header says the same thing in words ("Darkened by Darkrai", "This site's own dark theme, left alone", "Darkrai is off everywhere."). Header, status, This site and Mode are visible without scrolling; the rest of the controls scroll inside the dark screen only, and the casing never scrolls. Presses and the switch knob animate `transform` and `opacity` only, so no frame costs a layout.

Three things outrank the look, and the look gives way to each of them:

- **You asked for less motion.** With `prefers-reduced-motion: reduce`, transitions become instant (the end state is identical, so nothing shifts).
- **Your OS took the palette over.** With `forced-colors: active`, the chassis colours give way to system `Canvas` / `CanvasText` surfaces with real borders. The LED keeps its meaning through the status sentence, and the red hard-reset button becomes a normal system button — its label is what says destructive, not its colour.
- **You asked for more contrast.** `prefers-contrast: more` switches to Darkrai's high-contrast tokens and darkens the ink.

**The dropdowns.** The Look, Schedule, default-mode and Reset this site lists use Chrome's customizable select (`appearance: base-select`, in `extension/shared/select.css`, linked by both pages). On Chrome 135 and later the open list is themed too: a dark screen-coloured panel with a thin border, 30 px rows, the chosen row in the segment silver with a check mark, a dark hover row, a 150 ms fade-in (none under reduced motion), and system colours under forced colours. It opens under the pill, or above it when there is no room, and stays inside the popup. Older Chrome keeps its default list; the closed pills look the same either way. The elements are the same `<select>`s with the same ids, options and events, so keyboard use is Chrome's own: ArrowDown on a closed select still steps the value, Enter opens the list, the arrows move, Enter picks. Esc closes the list only: Chrome would otherwise close the whole popup on that key, so `popup.js` consumes an Esc pressed while a list is open and closes the list itself (value unchanged; measured in real Chrome 157). The From / To time fields keep Chrome's own time picker: Chrome has no CSS hook for that popup beyond `color-scheme` (already dark), so it was left as it is.

Contrast is not assumed. Every text run and icon on both surfaces is measured from real screen pixels — a screenshot, plus a second one with every glyph forced transparent, which gives the true backdrop behind each glyph. The worst reading on this build is 7.3:1 in the popup (the host line under the title) and 4.99:1 on the Options page (the red Hard reset button), against the 4.5:1 that WCAG asks for (3:1 for large text and icons). Full WCAG conformance also needs manual testing with assistive technology and expert review; this is the automated part of it.

### The popup's Lovable design

The popup is a plain-CSS port of the `DarkraiPopup` design made in Lovable: a chamfered red Pokedex casing with screws, vents, a raised 200 × 104 LCD module, a Poke Ball module top left with the status LED beside it, and a bottom strip with speaker dots, a centred Poke Ball and a vent slot. Unlike the design, which floats the device on a near-black page, the device fills the popup edge to edge, because Chrome always draws a toolbar popup as an opaque rectangle and cannot give it see-through corners: the dark-red outer casing runs to all four window edges and the bright red shell's cut corners show that dark red as corner guards. It is presentation only: every id, name, label, role, ARIA attribute and event binding of the earlier popup is still there, and the same 27 clicks produce the same 92 `chrome.*` calls and 20 storage writes as before (UI check family (j)). States: amber half-lit LED when off, green LED and status dot with a soft glow when darkening, ice-blue LED and dot with the LCD art at 60 % when the site's own dark theme is left alone.

The design is 833 px tall at its natural size and Chrome caps a toolbar popup at 600 px. The casing, the 118 px top hardware and the 52 px bottom hardware stay whole and identical to the design; only the dark screen (`#panel`, 420 px of client height) scrolls, with a thin scrollbar kept in its right padding so the content keeps the design's 304 px width. In the default state the screen holds about 653 px of content, with Custom hours about 673 px and with Look open about 843 px. The design's spacing was kept rather than squeezed: removing every vertical gap would still leave more than 420 px of content.

Its art lives in `extension/popup/art/` (`lcd-darkrai.png`, `avatar-darkrai.png`, `pokeball.png`): the design's images, pre-scaled to twice their display size so the popup still paints inside its 100 ms budget (the 4× originals missed it). The originals are kept in `tools/lovable-assets/` for regeneration. `extension/popup/screen-art.png` (the 24 px sprite built from `tools/icons/darkrai-24.txt`) is still the art in the Options page header. The toolbar icons were not changed by the port.

**Attribution.** Pokémon, Poké Ball and Darkrai are trademarks of Nintendo, Creatures Inc. and GAME FREAK. This popup art is fan art for personal use. Publishing Darkrai on the Chrome Web Store with this art would likely be rejected or taken down; replace the three files in `extension/popup/art/` with your own drawings first (below).

Third-party pieces bundled with it:

- **Icons**: [Lucide](https://lucide.dev) (lucide-static 0.575.0), inlined as one SVG sprite in `popup.html`. ISC License, © Lucide Contributors; portions MIT, © Cole Bemis (Feather). Full text in `licenses/lucide-LICENSE.txt`.
- **Font**: Nunito Sans (variable, latin subset), `extension/popup/fonts/nunito-sans-latin.woff2`. SIL Open Font License 1.1, © The Nunito Sans Project Authors. Full text in `extension/popup/fonts/OFL.txt`.

### Replacing the art

The popup uses three PNGs in `extension/popup/art/`. Replace any of them with a PNG of the same name, then press Reload on the Darkrai card at `chrome://extensions`. Keep them at about twice their display size; larger files cost paint time against the popup's 100 ms budget, which the 4× originals missed.

| File | Shown as | Shipped size |
|---|---|---|
| `lcd-darkrai.png` | the LCD picture, fitted (`object-fit: contain`) into a 178 × 82 box, pixelated | 282 × 164 |
| `avatar-darkrai.png` | the header avatar, fitted into a 40 × 40 box, pixelated | 78 × 80 |
| `pokeball.png` | both balls, cropped to circles (`object-fit: cover`) at 52 px and 44 px | 116 × 105 |

To regenerate the shipped files from the design's originals in `tools/lovable-assets/` (`darkrai_landscape_4x.png`, `darkrai_icon_4x.png`, `pokeball_4x.png`), downscale each to the size in the table with a high-quality resampler, halving the size step by step and finishing with one resample to the exact size. Only the file names matter to the popup; the CSS fits whatever proportions you supply into the same boxes.

The Options page header uses `extension/popup/screen-art.png` (drawn with `image-rendering: pixelated`), built with the toolbar icons from `tools/icons/darkrai-24.txt` by `node tools\icons\build-icons.js` (`--sprites-only` rebuilds just the sprites). Whatever image you supply is your own responsibility: third-party character art, logos and other people's drawings should not be redistributed in an extension.

## Resets: one site, or everything

Both live in the **danger area** at the bottom of the Options page, and both are reachable from the popup's bottom row.

**Reset this site** is the small, ordinary one. It forgets a single stored entry — its Auto / Always / Never setting, its Smart / Simple mode and every fix you saved there — so that site follows the global default again. No other entry is touched. In the popup it acts on the current site, with one inline confirmation (Esc keeps it); on the Options page you pick the site from the list.

One thing to know, because subdomains inherit: if the site you are on has no entry of its own, the button forgets the entry it was following, and it names that entry before you confirm. On `music.youtube.com` it forgets `youtube.com`, so every other subdomain under `youtube.com` goes back to the global default too. The popup says so after the fact rather than claiming nothing else moved.

**Hard reset everything** is the safety net for when something has gone wrong. It is behind a two-step in-page confirmation (never a browser `confirm` box), with **Cancel** as the default answer, focus trapped inside the dialog — before, during and after the reset, including the seconds while it runs and both buttons are disabled — Esc to cancel, and the whole list of what is about to go spelled out before you confirm. The summary and all seven steps are announced together, so a screen reader hears which steps failed and why, not only that some did. It erases:

- every setting — the master switch, the look and its three sliders, image dimming, and what new sites start as;
- your whole site list, with every Auto / Always / Never and Smart / Simple choice in it;
- every fix you saved with the picker, on every site;
- the schedule, and the `chrome.alarms` timer behind it;
- all per-tab state — open tabs are cleaned and put back on the defaults, with no reload.

**A hard reset cannot be undone.** Nothing is kept, there is no copy to go back to, and the only step beyond it is removing Darkrai at `chrome://extensions` and installing it again.

It is built to work when the rest of the extension is misbehaving, which is the only time anybody reaches for it. It runs from the page that owns the button and calls `chrome.storage`, `chrome.scripting`, `chrome.alarms` and `chrome.tabs` directly, never through the background worker — the worker is one of the things that might be asleep or wedged. It has seven independent steps, each with its own short timeout, so one failure cannot stop the other six, and it reports back an itemised list of what it did. **Partial success is reported as partial success**: a step that failed or timed out is listed as such, with the reason, and never as success. The list also says how many open tabs were cleaned, how many came back on the defaults, and how many could not be put back.

From the toolbar it is two clicks: the icon, then **Hard reset…**, which opens the Options page at the danger area with focus already there.

## Manual test checklist

Run through this in real Chrome after loading the extension (PLAN section 11). The real-Chrome suite covers part of it, but three items can only be checked by hand: **the keyboard shortcut** (Chrome's shortcuts cannot be pressed through the debugging protocol), **reloading the extension and then using an old tab** (a test copy of the extension stays disabled after a scripted reload, crbug.com/402532200), and **a real click on the toolbar icon**. GitHub's own dark theme and a Google results page also need a manual look: GitHub did not render dark under the emulated scheme, and Google served its bot check to the throwaway profile.

- [ ] **YouTube in its dark theme** — the icon is the ghosted mark and the popup says the site's own dark theme is left alone. Nothing is recoloured.
- [ ] **YouTube in its light theme** (Appearance > Light) — Darkrai darkens it, and switching the YouTube setting back and forth is followed without a page reload.
- [ ] **GitHub** — readable in both of its own themes; switching GitHub's theme is picked up.
- [ ] **Wikipedia** — a plain article page: body text, links, infoboxes and thumbnails all readable, photos not inverted.
- [ ] **Google Docs** — opens in Simple mode by default and the document is legible.
- [ ] **Reddit** — feed, sidebar, vote arrows and avatars readable; no dark-on-dark text.
- [ ] **A PDF** — open any `.pdf` link. The popup explains that Chrome does not allow extensions in the built-in PDF viewer instead of failing silently.
- [ ] **`chrome://extensions`** — the icon still opens the popup, and the popup shows the same clear "Chrome doesn't allow extensions on this page" message.
- [ ] **Press the physical Alt+Shift+D on a darkened page** — on a light site Darkrai is darkening, press the real keys (not a script). The page goes undarkened without a reload and the toolbar icon turns colourless; press them again and both come back. The automated suite only checks the binding and calls the handler directly.
- [ ] **The popup's look** — click the toolbar icon: the red Pokedex casing, both Poke Balls and the LCD art are whole, the casing does not scroll, and only the dark screen scrolls to reach Reset this site, Hard reset… and Options.
- [ ] **Toggle 20 times quickly** — click the header switch (or press Alt+Shift+D) twenty times in a row on a normal page. The popup keeps opening, the page keeps following, and nothing is left half-styled.
- [ ] **Reset this site** — on a site you have set to Always, press **Reset this site** in the popup and confirm. The site goes back to Auto, the page follows at once, and every other site in the Options list is exactly as it was.
- [ ] **Hard reset** — with a few sites and at least one saved picker fix, open **Hard reset…** from the popup. The Options page opens at the danger area, the dialog names what will go, Esc and Cancel both leave everything alone, and confirming twice puts every setting back and leaves the open tabs darkened on the defaults without a reload. Anything it could not do is listed with its reason.
- [ ] **Reload the extension at `chrome://extensions`, then use a tab that was already open** — with a page already open, press Reload on the Darkrai card at `chrome://extensions`, go back to that tab without refreshing it, open the popup and toggle. It must still work: the popup re-injects the page script, and any older copy removes itself first.

## Regenerating the icons

The twelve PNGs in `extension/icons/` are generated, not hand-drawn. The source lives in `tools/icons/` — `mark-large.svg` for the 48 and 128 px art, `mark-small.svg` for the simplified 16 and 32 px art — which sits outside `extension/`, so Chrome never loads it. Run from the repository root:

```
node tools\icons\build-icons.js
```

That rasterises both SVGs at all four sizes with the same headless `chrome-headless-shell` the test suites use, then derives the other two states from the coloured one: `off-*` by converting to true greyscale with Rec. 709 luma weights and dimming the result in RGB, and `native-*` by desaturating 30% and dropping everything but a one-pixel rim to 45% alpha. `off-*` copies `on-*`'s alpha channel byte for byte, which is what `tests/unit/icon-files.test.js` asserts — the proof that the two states are one mark rather than two drawings. The run prints what it did: the route it took, the source for each size, every file with its byte count, the measured colour and ink-mass figures, and how much of each 16 px icon clears 3:1 on a white toolbar and on a near-black one.

With no headless shell on the machine it downloads nothing. It keeps the committed `on-*` artwork, re-derives `off-*` and `native-*` from it, says so plainly and exits 0.

To use your own image instead:

```
node tools\icons\build-icons.js --from "C:\path\to\my-icon.png"
```

It accepts a PNG (8-bit, non-interlaced) or an SVG, and writes all twelve files from it — full colour for `on-*`, luma greyscale for `off-*`, ghosted for `native-*` — at 16, 32, 48 and 128 px, resampling with premultiplied alpha so the edges do not halo. `--out <dir>` writes somewhere else and `--chrome <path>` names a headless binary instead of discovery. Whatever image you supply is your own responsibility: third-party character art, logos and other people's drawings should not be redistributed in an extension.

## Run the tests

Node.js is needed only for the tests; the extension itself has no build step, no bundler and no dependencies, and nothing here is installed or downloaded. Run them from the repository's `tests` folder:

```
cd tests
node --test
node browser/run-fixtures.js
node browser/run-ui-checks.js
node browser/check-manifest.js
node browser/dom-contract.js snapshot %TEMP%\dom-now.json
node browser/dom-contract.js compare browser/dom-contract.before.json %TEMP%\dom-now.json
node browser/run-perf.js %TEMP%\perf.json
node fixtures/run-colour-fixtures.js
node fixtures/run-rapid-toggle.js
node real-chrome/run-real-chrome.js
```

Environment variables (all optional; on Windows `cmd`, `set NAME=value` before the command, and `set NAME=` to clear it):

| Variable | Used by | What it does |
|---|---|---|
| `DARKRAI_CHROME` | headless suites, `run-perf.js`, `build-icons.js`, and `run-real-chrome.js` | The browser binary. For the headless suites it should be a `chrome-headless-shell`; without it they look for one already unpacked under `~/.cache/puppeteer`, `~/AppData/Local/ms-playwright`, `~/.cache/ms-playwright` or two folders above the repository, each only if it exists, and print SKIPPED when there is none. For `run-real-chrome.js` it must be real Google Chrome (the harness needs `Extensions.loadUnpacked`); the default is `C:\Program Files\Google\Chrome\Application\chrome.exe`. Clear it before a real-Chrome run if you set it to a headless shell. |
| `DARKRAI_UI_FAMILY` | `run-ui-checks.js` | Runs only these families, e.g. `b,f`. Clear it for a full run. |
| `DARKRAI_EXTENSION` | `run-real-chrome.js` | Loads a copy of `extension/` instead of the repository's own. |
| `DARKRAI_RESULTS` | `run-real-chrome.js` | Writes that run's results and its `REAL-CHROME-REPORT.md` to this folder instead of `tests/real-chrome/`. |
| `DARKRAI_PROFILE_ROOT` | `run-real-chrome.js` | Where the throwaway profiles go, `<root>\profile-<ms>`. Default `%TEMP%\darkrai-realchrome`. A Chrome left behind by a killed run is the one whose command line holds `--user-data-dir=<root>\profile-`. |

**`node --test`** — the unit suite. Run it from the `tests` folder so the runner finds the files itself (`node --test "unit/*.test.js"` works too). Naming the folder, as in `node --test unit`, **fails on Node 24**: it reads the folder as a single file. Last run here: **171 tests, 171 passed, 0 failed** (v24.12.0, about 1.2 s), 21 of them added by the release pass: the early-dark-background registration race (8), the content-script file lists in `manifest.json`, `background.js` and `reset.js` agreeing (1), colours inside `var()` fallbacks and lost longhands (6), and the light-region detector the real-Chrome probe uses (6).

It covers the colour maths, contrast and the readability targets, the text role a masked element's background colour takes, colour shorthands that hold `var()`, already-dark detection, the storage schema and its upgrades, site matching, the picker's remembered fixes, the icon-rescue decision, the schedule, the dev-only timing module, the early dark background and alarm registration, the motion and surface-mode decisions, the twelve toolbar icon files, and the resets — that a hard reset restores the exact factory defaults, that running it twice changes nothing more, that resetting one site leaves every other site byte-identical, and that a `chrome.*` call which rejects, times out or is missing altogether is reported as a failed step while the other steps still run.

Four of those cases exist to stop the reset from flattering itself: a registration that Chrome refused is reported as a step that did not finish rather than as done, an alarm that could not be created is told apart from an alarm that was never needed, and a tab that was re-injected keeps its live icon even when the old styles had to be swept and the sweep failed.

The sweeper — the function injected into a tab that will not answer — is pinned twice: here as a string, that it leaves the root marker at `off` instead of removing it and that it reaches inside open shadow roots, and in the UI suite against a real document.

The seven icon tests decode the PNGs rather than checking that the files exist, because "the file is on disk" would also pass against the flat placeholders this build replaced. They assert all twelve are valid 8-bit non-interlaced RGBA at exactly their nominal size, that every `off-*` is true greyscale with no transparent pixel carrying stray colour, that every `on-*` really is coloured, that each `native-*` sits between the two on both chroma and ink mass, and that `on-*` and `off-*` have byte-identical alpha channels while `native-*`'s differs.

**`node browser/run-fixtures.js`** — the thirteen fixture pages under `tests/fixtures/`, each of which checks itself. Last run here: **all 13 fixture checks passed**, with `native-dark.html`, `meta-dark.html` and `runtime-theme-switch.html` each reporting zero Darkrai style nodes and zero adopted Darkrai sheets, which is the line that says an already-dark site was really left alone. Two pages were added for the readability pass:

- `mask-icons.html` holds two icons drawn the Wikimedia Codex way, as the background colour of a masked span. Its glyphs read 3.23:1 and 8.52:1 on #181818; on the earlier engine they read 1.10:1 and 1.76:1.
- `var-shorthand.html` holds a cookie-banner-style `background: var(--x, #f0f4ff) !important`, a guide panel and an inline style, each with `var()` inside the `background` shorthand. All three come out dark, where the earlier engine left all three light.

You can also open `tests/fixtures/index.html` by hand in any browser.

Two more fixture runners came with the release pass, each reporting through the same protocol:

- **`node fixtures/run-colour-fixtures.js`** opens `var-fallback.html` (Wikipedia's fade, a `var()` shorthand followed by its own longhand, and a colour inside a `var()` fallback) and also checks real screenshot pixels inside the elements it names. Last run here (release pass, from a fresh-clone copy): **PASS**, the fade's last stop at OKLCH L 0.21 and both `var(--token, #fff)` backgrounds at L 0.21. On the engine before the fix it failed twice: the fade's last stop and `#plain` stayed white.
- **`node fixtures/run-rapid-toggle.js`** opens `rapid-toggle.html` (3,000 rows, 900 rules), toggles `settings.enabled` 20 times about 20 ms apart, and requires no long task and a style set equal to a fresh load. Last run here (release pass, fresh-clone copy): **PASS**, 0 long tasks and the style set equal to the fresh load's. On the code before the fix: 38 long tasks, the longest 350 ms, 5,076 ms of blocking, and one leaked adopted sheet. It drives storage directly, so it does not cover the popup's re-injection path that the real-Chrome P1-1c goes through.

**`node browser/run-ui-checks.js`** — eleven check families, (a) to (k), against the popup and the Options page (`set DARKRAI_UI_FAMILY=b,f` runs a subset): pixel-measured contrast, that the Pokedex frame renders (casing, both hardware strips, both Poke Balls, LCD, LED, speaker dots, screen, avatar) and follows the On / Native / Off state, saving `tests/browser/screenshots/popup-on.png`, `popup-native.png`, `popup-off.png`, `popup-hours.png`, `popup-look-open.png` and `options.png`, that no layout property is animated, a visible focus ring on every control, no layout shift under the three media settings, the popup's paint and size budget, the hard-reset dialog (that it is a real modal, that focus starts on Cancel, that Tab stays inside it — before the reset, *while it runs* with both buttons disabled, and after it has finished with the Continue button hidden — that its own text clears contrast over its own blurred backdrop, that its buttons show a ring, that the itemised result is inside the live region so a screen reader hears which steps failed, and that Esc gives focus back to the trigger), the two-click route from the toolbar icon (that "Hard reset…" really opens `options/options.html#danger` and closes the popup, and that the fragment moves focus into the danger area), the sweeper against a real document dressed up as a darkened tab, and (j) the behaviour replay: 27 popup actions, each in a fresh popup, whose `chrome.*` calls, storage writes and read-out must match `tests/browser/popup-behaviour.baseline.json`, recorded before the redesigns, and (k) the themed dropdowns: every `<select>` on both pages opened with a real click, its list inside the viewport, lined up with the pill, the chosen row silver and the others dark with no default light-blue pixel, text at 4.5:1 or better, Esc closing the list with the value kept, Enter / ArrowDown / Enter picking the next option with one `change`, reduced motion and forced colours (screenshots `popup-dropdown-look.png`, `popup-dropdown-schedule.png`, `options-dropdown.png`). `node browser/dom-contract.js compare browser/dom-contract.before.json <snapshot>` is the other half of that oracle: every id, name, `for`, role, `aria-*`, `type`, `tabindex`, `data-*` and event binding of the popup and Options page must still be there (`snapshot <file>` writes the current one).

Last run here, in the release pass (2026-11-06, quiet machine): **all UI checks passed**, every family (a) to (k). (f) read **80, 64, 40 ms, median 64 ms** against the 100 ms budget. (g) ran the hard reset end to end against the shim, 7 steps, 0 failed. (j) still **27 actions, 92 `chrome.*` calls and 20 storage writes, identical**, and the DOM contract still 281 items with the one `#lcd-art` difference. (k) passed every select on both pages, including the popup's Schedule list with its pill at the very bottom of the scrolled screen, which now opens **above** the pill (y 399.5-499.5, a 6 px gap, the full 304 px width). Run from a fresh-clone copy, which found an older headless build (chrome-headless-shell 148), every family passed again except (f): the popup's median read 108 ms and then 124 ms, and the unbudgeted Options page slowed by the same factor (100 and 124 ms against 56-64 ms), so the paint budget is sensitive to the headless build as well as to load. Two test-side changes came with that run, both recorded in [docs/VERIFICATION.md](docs/VERIFICATION.md): the UI shim now keeps the dynamic content scripts it is given (it used to answer every read-back with an empty list, so the hard reset's new read-back could never pass against it), and (k)'s default-blue grid skips the option labels' own glyph boxes, where the 3 "blue" pixels on the Options page's Reset-this-site list were LCD subpixel anti-aliasing with an orange twin on the other side of each stem. The blue threshold and the any-sample-fails rule are unchanged.

Earlier, after the readability pass: **every family green except the popup's paint budget (f), so the command exits 1.**

- In that full run, (i) and (j) stopped on harness timeouts (`Page.enable` / `Target.createTarget` after 8 s). A re-run of `f`, `i` and `j` passed both.
- Worst contrast is 7.3:1 in the popup (the host line) and 4.99:1 on Options. The weakest focus rings are 12.57:1 and 3.57:1. 175 and 136 boxes stayed put under the three media settings.
- Popup paint:
  - full run: **104, 116, 84 ms, median 104 ms**, against the 100 ms budget, with the unbudgeted Options page at 72 ms;
  - the re-run: 128 ms, with Options at 140 ms;
  - before this pass: 108 ms and 128 ms;
  - a quiet run during the port: 92 ms.
- No popup file changed in this pass. The figure is load-sensitive and sits just around the budget (see Known limits). The fit at 360 × 600: the page never scrolls, the screen scrolls with 653 px of content in 420 px by default, 673 px with Custom hours and 843 px with Look open, and no text is clipped in any of them. The frame group: 12 of 12 pieces visible, Poke Balls at 52 and 44 px (hidden from assistive technology, unfocusable, no handler), 3 speaker holes, LED green / blue / amber for On / Native / Off, the LCD art at full strength / 60 % / full strength. The replay group: 27 actions, **92 `chrome.*` calls and 20 storage writes, identical to the baseline**. The DOM contract: 281 items checked, one deliberate difference (`#lcd-art` now points at `art/lcd-darkrai.png`). The dialog group: `role="dialog" aria-modal="true"` named "Hard reset everything?", focus on Cancel, the page behind it inert, Tab and Shift+Tab contained over both stops and while the reset ran, rings at 12.31:1, worst dialog contrast 4.99:1 over its own backdrop, Esc returning focus to the trigger, and all seven steps reported done against the test shim. The sweeper group: `<html>` kept `data-darkrai="off"`, the page's own content and its shadow content survived, no `style[data-darkrai]` or `data-dr-id` left in the document **or inside the open shadow root**, and both tagged adopted sheets were dropped while the page's own was kept.

**`node browser/check-manifest.js`** — pure Node, so it never skips and needs no browser. It parses `manifest.json`, resolves every path the manifest names plus the ones only registered at runtime, and reads the three 16 px icons: it composites each over white and over near-black and reports what share of the mark's ink reaches 3:1 against that background, with gates of 40% for `on-16`, 30% for `native-16` and 15% for `off-16`, and checks that `native-16` keeps at most 0.80 of `on-16`'s ink mass so the two stay tellable apart. Last run here: **34 declared paths, every one resolves**, all twelve icon files among them, and the six icon-on-background figures (white / near-black) at **78.3% / 60.5%** for `on-16`, **67.4% / 50.7%** for `native-16` and **78.3% / 51.6%** for `off-16`, `native-16` at 0.608 of `on-16`'s ink mass, exit 0. The gate is set lower for `native-16`, whose ghosted interior is meant to be faint while its rim carries the mark.

**`node real-chrome/run-real-chrome.js`** — the extension in your installed Google Chrome against real public sites. It **opens a visible Chrome window** on a fresh throwaway profile (your own profile, history and extensions are never touched), loads `extension/` unpacked, runs the checks, closes Chrome through the debugging connection and deletes the profile. It needs a network connection, takes about 7 minutes and is capped at 14. `--only=problem1,problem2,problem3,p4,p2,p3` runs a subset and merges it into the previous report, and `--sites=wikipedia,youtube` (for debugging) limits problem 3 to the URLs that contain one of those words. Results go to `tests/real-chrome/REAL-CHROME-REPORT.md` and `tests/real-chrome/results/<run>/report.json`, with off/on screenshots per site and the Chrome log. `results/` is git-ignored, because it holds screenshots of third-party sites; the copies of Darkrai's own UI screenshots from the release run (the popup and its dropdowns) are committed in `tests/real-chrome/evidence/`. Before and after a run, a leftover harness process is the one whose command line holds the profile root (`%TEMP%\darkrai-realchrome\profile-` by default), never matched by image name, so your own Chrome is never touched.

Last runs here, in the release pass (2026-11-06, Chrome 157.0.8103.39, the repository's own `extension/` folder): one full run (`2026-11-06T08-55-09-476`, 402 s, **42 PASS, 6 FAIL, 2 NOT RUN**), then two more runs of `--only=problem1,p4,p3` to measure flakiness. Problem 2 and 3 and the P2 checks ran once; problem 1, P4 and P3 ran three times. The per-check table with the pass count of every check is in [docs/VERIFICATION.md](docs/VERIFICATION.md). Every run closed Chrome through the debugging connection and removed its throwaway profile.

- **Problem 1, the popup sometimes does not open.**
  - P1-1a, the popup opening and showing the tab's real state while the service worker is asleep: **PASS in 3 of 3 runs**.
  - P1-1b, Never → Auto applied with no reload: **PASS in 3 of 3 runs**.
  - P1-1e, the restricted-page message on `chrome://extensions`, `chrome://settings`, the Web Store and a PDF: **4 of 4 PASS in each of the 3 runs**.
  - **P1-1c, 20 rapid master-switch toggles: FAIL in 3 of 3 runs, still open.** No run left a duplicate style, but none ended equal to a fresh load (17 override sheets, 4 adopted). In runs 1 and 2 the page ended switched on but under-applied, with 5 and 6 override sheets and 3 adopted. In run 3 it ended with `data-darkrai="off"` and 4 override sheets left, while the store and the switch both said on. The run before this pass ended under-applied the same way (4 against 15). Reloading the tab restores it: the P4 checks that follow load the same tab again and find it fully darkened.
  - **P1-1c-main-thread: FAIL in 3 of 3 runs.** The release pass took Darkrai's own long tasks out of the burst (the longest task in the real tab is now 54-108 ms, total blocking 4-66 ms; the 3,000-row fixture went from 38 long tasks to 0), but after the toggles the tab still leaves `Runtime.evaluate` probes unanswered for more than 5 s, with no long task showing in the page meanwhile. The cause is not found yet.
  - Not automatable, on the manual checklist: P1-1f, the physical Alt+Shift+D (NOT RUN by design), and P1-1d, an old tab after an extension reload (FAIL "no new service worker": a CDP-loaded unpacked extension stays disabled after a scripted reload, crbug.com/402532200).
- **P4, every control in the real toolbar popup: 17 checks, 49 of 51 PASS across the 3 runs (run 1 17 of 17, run 2 16 of 17, run 3 16 of 17).** This site Always on YouTube's own dark theme, the master switch, Never → Auto, Smart → Simple → Smart, a brightness change, reopening the popup, the picker, Custom hours and its alarm, the themed dropdowns (including the Schedule list flipping above its pill at the bottom of the screen), Reset this site, Hard reset… opening `options.html#danger`, Options, Reload this tab, the shortcut's binding and handler, the screenshot ([`tests/real-chrome/evidence/popup-real.png`](tests/real-chrome/evidence/popup-real.png), 360 × 600) and the fit (the page does not scroll, the screen does, 653 px of content in 420 px, the content keeps 304 px, no clipped text). The two misses were the toolbar popup closing on its own mid-check, P4-shot in run 2 (NOT RUN) and P4-dropdowns in run 3 (FAIL); each passed in the other two runs (see Known limits).
- **Problem 2, overriding a site's own dark theme.**
  - P1-2a PASS: YouTube in its own dark theme was left alone, with `data-darkrai="native"`, 0 style nodes and 0 adopted sheets.
  - P1-2b PASS: YouTube in its light theme was darkened.
  - P1-2c PASS: MDN switched its own theme live under the emulated scheme. Darkrai went `native` with 0 style nodes and 0 adopted sheets once MDN turned dark, and darkened it again when it turned light, with no reload.
  - P2-gh-dark FAIL: GitHub did not render dark under the emulated scheme, so Darkrai darkened a light page; GitHub light PASS. Google's dark-scheme results PASS (`native`); the light-scheme tab met the bot check (NOT RUN). Both stay on the manual checklist.
  - P2-errors PASS: no exception or console error in the popup, the Options page, Darkrai's isolated worlds or the worker.
- **Problem 3, unreadable text and icons.** Text and icons below target / measured, all at 0 below target: Wikipedia (Moon) 0/110 text and 0/14 icons, Hacker News 0/230 and 0/1, MDN 0/48 and 0/0, BBC 0/34 and 0/3, Stack Overflow 0/94 and 0/5, Reddit 0/15 and 0/5 (it redirects to its login page), YouTube light 0/7 and 0/13. Text inside disabled controls is counted as exempt rather than judged (WCAG 1.4.3): 2 text runs on Stack Overflow, 3 on Reddit and 3 on YouTube.
  - The new light-region check (P1-3L) found no unexplained light area on Wikipedia (its two sticky-header fades are now dark; the one light region is the Moon photo), Hacker News, Stack Overflow, Reddit or YouTube.
  - **Two light regions are left, both open:** MDN's top sponsor banner, painted white by `div.top-placement` inside the open shadow root of `mdn-placement-top` (1265 × 56 px), and on BBC News a 728 × 90 cross-origin Google ad frame whose whole box painted white while the frame element has `color-scheme: dark`.
- **P3, the hard reset** from `options.html#danger`: **PASS in 3 of 3 runs**. Each time it restored the factory defaults, registered the early dark background, left no alarm and put the open tab back on, and the dialog reported every step done. Before this pass it reported "Partly done" with the same correct end state (`Duplicate script ID 'darkrai-preload'`), in `2026-11-03T11-04-11-169` and again in `2026-11-03T18-00-23-469`.

The two headless suites (fixtures and UI checks) look for a `chrome-headless-shell` already on the machine (or `DARKRAI_CHROME`), and **print SKIPPED and exit 0** when there is none. Neither one ever downloads a browser, installs a package or launches your everyday Chrome. `node browser/run-perf.js` is the fourth, optional suite: it records the timing numbers below.

The timing those suites read is off unless you ask for it. `chrome.storage.local.set({ debug: true })` from Darkrai's own devtools console turns it on; it is off for everybody by default and costs one boolean test when off.

## Measured performance

Real numbers from the development machine, recorded by `node browser/run-perf.js` before and after the optimisation pass (written up side by side in [docs/perf-report.md](docs/perf-report.md), headless Chrome, software rendering). The release pass of 2026-11-06 measured the same fixtures again before and after its engine changes; those numbers are in [docs/VERIFICATION.md](docs/VERIFICATION.md). The two columns below are **before → after** the optimisation pass. The timings are the gaps inside the page — how long after Darkrai's decision its first styles paint, and how long until it settles — because the absolute marks also carry however long the page itself took to load that run, which swings by 100 ms either way and says nothing about Darkrai.

`run-perf.js` writes to `.agents/tasks/perf-before.json` (a git-ignored folder) unless it is given a path. To keep a run somewhere else, give it one: `node browser/run-perf.js <file>.json`.

| fixture | first paint after decision (ms) | settled after decision (ms) | style nodes | adopted sheets | elements the guard measured | RecalcStyleCount | forced reads (proxy) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| light | 4.2 → 3.7 | 16.1 → 19.1 | 2 → 2 | 0 → 0 | 24 → 20 | 7 → 7 | 0 → 0 |
| css-variables | 3.3 → 2.3 | 12.8 → 9.4 | 3 → 2 | 0 → 2 | 12 → 12 | 17 → 10 | 6 → 0 |
| inline | 2.8 → 2.4 | 13.6 → 11.4 | 2 → 1 | 0 → 1 | 14 → 14 | 8 → 7 | 0 → 0 |
| low-contrast | 3.0 → 3.5 | 10.3 → 11.1 | 2 → 2 | 0 → 1 | 16 → 14 | 8 → 12 | 6 → 0 |
| shadow-dom | 2.3 → 2.7 | 13.0 → 11.3 | 2 → 2 | 3 → 3 | 20 → 20 | 8 → 8 | 0 → 0 |
| small-icons | 2.9 → 2.5 | 10.8 → 8.9 | 3 → 2 | 0 → 2 | 24 → 18 | 11 → 10 | 11 → 0 |
| native-dark (control) | n/a | n/a | 0 → 0 | 0 → 0 | 0 → 0 | 4 → 4 | 0 → 0 |

What actually moved:

- **Forced style reads are gone.** The readability guard now measures a whole slice before it writes anything, so the 6, 6 and 11 read-after-write proxies on `css-variables`, `low-contrast` and `small-icons` are all 0. That is the change with the clearest effect on a big page.
- **Chrome's own `RecalcStyleCount` fell where the work was**: 17 → 10 on `css-variables`. It **rose on `low-contrast`, 8 → 12**, which is the one number in this table that went the wrong way: that page's whole point is contrast rescue, and the constructed stylesheet it now writes into is mutated rule by rule instead of being re-serialised in one go. It is 12 recalculations on a page that used to do 8, against a page-wide total that is still well inside budget, so it was left as it is rather than traded back for the O(n²) re-serialisation.
- **Darkrai writes fewer DOM nodes.** The wholesale-rebuilt sheets moved to constructed `adoptedStyleSheets`, so `style` nodes drop and adopted sheets appear in their place — one object mutated in place instead of a text node re-parsed on every flush.
- **A site with its own dark theme still costs almost nothing**: `native-dark` ends at 0 style nodes, 0 adopted sheets, 0 elements measured and 4 style recalculations for the whole page, Darkrai's share of which is the one decision.

Against the targets in `PLAN.md` section 6.9:

- *under 20 ms of blocking work before first paint* — **met**: 2.3–3.7 ms between the decision and Darkrai's first styles on every fixture.
- *guard slices of 8 ms or less* — **met** by construction; the slice budget and its 2 ms floor are unchanged.
- *about 150 ms to idle on an article page* — **met**: 9–19 ms after the decision.
- *under 5 ms on a page that is already dark* — **not measurable this way, and reported as such.** `native-dark` is read as 0 nodes and 0 measured elements, and the page-wide `RecalcStyleDuration` is 1.0 ms, but that figure covers the fixture's own scripts too, so it is not Darkrai's 5 ms.
- *popup paint under 100 ms* — **met, but on a median of three loads rather than on one cold load. The number did not move; the way it is measured did, and here are all the readings behind that.**
  - Single-load readings of this build, as the check used to take them: **88, 100, 100, 112, 116, 124, 132, 160 and 184 ms** — median 116 ms. On that method the figure was missed.
  - The build before the reset work measured **72–80 ms** in the same harness. Part of the difference is real and is **the popup's one blurred `.dr-glass` surface**: a liquid-glass panel costs paint time, and that panel is the look this build exists to deliver.
  - Part of it is machine load. The Options page, which has no budget, measured 168 ms before this work and swung **172–252 ms** across the same runs — the same proportional spread on a page the reset work barely touched.
  - So the check now loads each page **three times in one run**, prints every reading and gates the popup's **median** against the same **100 ms**. The three runs recorded on that method: **124, 76, 44 ms — median 76 ms**; **100, 92, 76 ms — median 92 ms**; and the last one **68, 36, 36 ms — median 36 ms**, with the Options page reading 140, 88, 108 ms in that same run. Later loads in a run are warmer than the first, so the first reading is the one to compare with the older single-load numbers.
  - A 100 ms gate on the median still has teeth: the glass-era single-load median of 116 ms would fail it. An earlier pass had set the gate to 150 ms, which was looser than the thing it measures; it is back to 100. The reasoning is recorded in `PLAN.md` section 14 item 13 and in a comment at the threshold in `tests/browser/run-ui-checks.js`. Dropping the popup's glass to buy a faster cold load was considered and rejected.
  - The size budget is met: the Lovable popup is 360 px wide and **600 px** tall against the 600 px a toolbar popup gets; the design's extra height scrolls inside its screen.
  - These readings predate the Handheld reskin, which replaced the glass surface, and the Lovable port after it. The Handheld popup measured 128, 68, 56 ms, median 68 ms. **The Lovable popup is heavier and sits around the budget:** a quiet isolated run during the port read a 92 ms median, the latest full UI run **236, 104, 108 ms, median 108 ms** (the Options page 76 ms in that run), and a re-run under real-Chrome load 128 ms (Options 168 ms). The release pass (2026-11-06) dropped the font preload, after an interleaved A/B in one headless session put the median 26% lower without it; the full UI runs on a quiet machine then read **100, 68, 36 ms (median 68 ms)** and **80, 64, 40 ms (median 64 ms)**.
- *The readability pass (2026-11-03)*, measured on the same fixtures and the same headless shell as an engine copy with the three fixes neutralised. It moved nothing beyond run-to-run noise:
  - decision → first paint 2.5–3.9 ms, against 2.1–4.0 ms before;
  - decision → idle 11–21 ms, against 9–19 ms;
  - style nodes and adopted sheets identical on every fixture, and 0 forced reads.
  - The new mask-icon candidates run inside the existing 8 ms guard slices, and `SLICE_MS`, `MIN_SLICE_MS` and `BATCH` are unchanged.
- *60 fps animation* — **not measurable honestly** in `--disable-gpu` headless. What is checked instead is structural: only `transform` and `opacity` are animated anywhere on either surface, asserted by check family (c) over every stylesheet rule and every `@keyframes` block.

## Known limits

- Chrome blocks every extension on `chrome://` pages, the Chrome Web Store, the built-in PDF viewer and other extensions' pages. Darkrai says so rather than failing quietly.
- Closed shadow DOM cannot be reached, so a page component built that way keeps its own colours.
- Apps that draw their text on a canvas need Simple mode. Docs, Sheets and Slides are preset; anything else is one switch in the popup.
- A few complex sites may still need the picker or Simple mode.
- The picker runs in the top frame only, so an unreadable element inside an embedded frame cannot be picked yet.
- Picker selectors are built from ids, stable-looking classes and position. A site that rebuilds its markup can outgrow a saved fix; clear it from the Options page and pick again.
- Icon rescue reads image pixels. Same-origin images are analysed in the page, and images from other domains are analysed in the background worker, which answers only yes or no. An image behind a login or a signed URL that the worker cannot fetch is left as it is.
- The Google Docs Simple-mode preset is part of the default store, so removing `docs.google.com` from the Options list — or resetting that one site — brings it back on the next read. Set it to **Never** instead if you do not want it. Resetting that one site in the Options danger area says so on the spot rather than promising more than it can do.
- A hard reset cannot be undone, and there is no export or import to take a copy first. Reinstalling Darkrai is the only step beyond it.
- A hard reset tries to put every open tab back on the restored defaults without a reload. A tab it could not re-inject — one that has gone unresponsive, say — is **left cleaned but with no Darkrai running in it: the page shows as the site styles it, and the toolbar icon goes colourless to match. Reloading that tab is what brings the restored defaults back.** The reset says how many tabs that was rather than quietly rounding up. A tab that *was* re-injected keeps its live icon even if the old styles had to be swept from outside and that sweep failed; the report counts the two separately.
- When a tab has to be cleaned from the outside, the sweeper leaves `data-darkrai="off"` on the page root rather than removing it. The early dark background is a stylesheet that is already live in every open tab and cannot be taken back out of one, and it keys off that attribute being absent — so removing it would paint a dark background under light page content. This is asserted against a real document by the UI suite.
- Settings are stored locally only. There is no sync, and no export or import, in this version. The hard reset still clears `chrome.storage.session` and `chrome.storage.sync` when the APIs exist, and says in its report that Darkrai keeps nothing in them.
- The Chrome "Settings > Appearance > Mode: Dark" tip is a Chrome behaviour that was not verified in a real browser during this build.
- The Lovable popup's first paint is load-sensitive. The release pass dropped the font preload (the woff2 was fetched ahead of the popup's scripts, and paint waits on those), and on a quiet machine UI family (f) then read medians of **68 ms and 64 ms** in two full runs (2026-11-06) against the 100 ms budget. Under load it has read up to 172 ms, so (f) can still fail on a busy machine. The tradeoff: on a slow open the first frame can briefly use the fallback face before Nunito Sans swaps in (`font-display: swap`).
- **After 20 very fast on/off toggles a page can end up wrong**: never with duplicate styles, but under-applied, with fewer recoloured sheets than a fresh load (Wikipedia in real Chrome: 4-6 override sheets against 17), and in one of three runs left `off` while the switch said on. The check failed in all three release runs, and in the run before the pass. Reloading the tab restores it. A likely mechanism, not verified: the popup re-injects the page script when the tab does not answer in time, and a new copy takes the old one down while the old one is mid-apply. The release pass coalesced settings changes, which took Darkrai's long tasks out of the burst, but the tab still stops answering the debugging protocol for several seconds after the burst with no long task in the page; the cause is not found yet (P1-1c and P1-1c-main-thread in [docs/VERIFICATION.md](docs/VERIFICATION.md)).
- Two light regions are left in real Chrome: **MDN's top sponsor banner**, painted white by `div.top-placement` inside the open shadow root of `mdn-placement-top`, and on **BBC News a 728 × 90 cross-origin Google ad frame** whose whole box painted white while the frame element has `color-scheme: dark`. Neither is text Darkrai left unreadable (both pages read 0 text runs below target), but both are bright areas on a darkened page.
- The real-Chrome text probe no longer judges text inside disabled controls (WCAG 1.4.3 exempts inactive components): Reddit's disabled "Log In" button is drawn just as faint by the site's own light page. The icon probe skips `*-noicon` elements and elements with their own text, such as Wikipedia's "Talk" tab, which the text probe measures instead. No threshold moved.
- In the real-Chrome suite the toolbar popup closed on its own twice in three runs, each time in a different check: once during a 900 ms wait before P4-shot's screenshot (NOT RUN) and once on a real click on the "True black" option in P4-dropdowns (FAIL). Both checks passed in the other two runs. The popup only closes itself after the picker starts, Options, Hard reset… or Reload this tab, so neither close came from a Darkrai code path; the cause, likely a focus change in the automated window, is not established.
- The hard reset in real Chrome restored the factory defaults and reported every step done in all three release runs. Before the release pass it could report "Partly done" (`Duplicate script ID 'darkrai-preload'`) with the same correct end state, because the background worker re-registered the early dark background in the middle of the reset's own step; registration is now serialised and read back (PLAN section 6.8).
- All thirteen fixture pages were run in a headless Chrome on this build and every check passed, including the contrast assertions, the two CSS-mask icons, the three `var()` background shorthands, the three already-dark pages being left untouched at zero style nodes and zero adopted sheets, shadow DOM, the embedded frame, and the canvas app falling back to Simple mode. Re-run them with `node browser/run-fixtures.js`, or open `tests/fixtures/index.html` by hand.
- The fixture and UI suites run in a headless `chrome-headless-shell` against a local file server, so the popup's paint figure is not a real toolbar click, and it is machine-load sensitive (see the performance section). The real-Chrome suite does load the extension in installed Chrome, but it cannot press the toolbar icon or the keyboard shortcut, cannot measure content inside cross-origin frames, and samples one point per text line; the items it could not cover are marked in the manual checklist.
- The popup, the toolbar icon and the picker ask the top frame for its state. An embedded frame still styles itself and still follows your settings, but its state is not what the popup reports.
- The popup's Pokedex, Poke Ball and Darkrai art is fan art of trademarked characters (see the attribution note under [The popup's Lovable design](#the-popups-lovable-design)). It is fine for personal use, not for a Chrome Web Store listing; replace `extension/popup/art/` first.
- The Lovable design is taller than a toolbar popup, so the popup's dark screen scrolls in every state, the default one included: Reset this site, Hard reset… and Options sit below its fold. The casing and its hardware never scroll.
- The live Lovable preview needs a login, so the port was matched against the design's source (`DarkraiPopup.tsx` and its tokens), not against a live rendering. The design's toast and its Options / Hard reset modal were not ported, because Darkrai's status line and Options page already do those jobs, and its hover colour transitions are instant here, because only `transform` and `opacity` animate.
- The themed open list needs Chrome 135 or later (customizable select). Older Chrome shows its default list, with dark option rows where it allows them. The From / To time picker popup cannot be styled from CSS and keeps Chrome's own look.
- On the Options page the closed selects' arrow is a drawn chevron of about the same size as Chrome's classic arrow, which a customizable select cannot draw; the pills keep their size and the popup's closed pills are pixel-identical.
- Firefox and Edge packages, translations, and switching a site's own dark CSS on directly are not in this version.
