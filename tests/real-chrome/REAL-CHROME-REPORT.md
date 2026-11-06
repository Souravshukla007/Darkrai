# Darkrai in real Google Chrome

> `results/` is generated locally by each run and is git-ignored, so the `results/...` paths below exist only on the machine that ran it. `evidence/` holds the committed copies of Darkrai's own UI screenshots (popup and dropdowns), never screenshots of third-party sites.

Run `2026-11-06T09-17-10-121` on Chrome/157.0.8103.39, extension id `ncmkbifcncembabcddlgempegnlighce`, 325 s. Full evidence: `results/2026-11-06T09-17-10-121/report.json`.

Every P1 check passed: **no**. Browser closed with Browser.close, throwaway profile removed: true.

Re-run from the repository's `tests` folder: `node real-chrome/run-real-chrome.js`

## Pass counts across the release runs (2026-11-06)

This report is the last of three runs: the full run `2026-11-06T08-55-09-476`, then `--only=problem1,p4,p3` twice (`2026-11-06T09-10-38-113` and this one). The rows marked "(run 2026-11-06T08-55-09-476)" below come from the full run. Pass counts over the three runs (NOT RUN counts as not ran; the per-check table is in `docs/VERIFICATION.md`):

- Problem 1: P1-1a 3/3, P1-1b 3/3, P1-1e 12/12 (4 pages × 3), **P1-1c 0/3, P1-1c-main-thread 0/3** (open). P1-1f NOT RUN by design (CDP cannot press browser accelerators) and P1-1d FAIL/NOT RUN (crbug.com/402532200); both are on the README manual checklist.
- Problem 2: P1-2a, P1-2b and P1-2c 1/1 each (full run only).
- Problem 3: P1-3 readability 7/7 sites at 0 text runs and 0 icons below target; P1-3L light regions 5/7, **MDN and BBC FAIL** (open).
- P4: 49 of 51; P4-shot NOT RUN in run 2 and P4-dropdowns FAIL in run 3, both because the popup target closed mid-check.
- P3: P3-reset 3/3.
- P2: GitHub dark FAIL (GitHub does not render dark under emulation), Google light NOT RUN (bot check), the rest PASS.

| ID | Pri | Check | Result | Evidence / reason |
|---|---|---|---|---|
| P1-2a (run 2026-11-06T08-55-09-476) | P1 | https://www.youtube.com/ in dark -> native | PASS | {"finalUrl":"https://www.youtube.com/","nav":{"errorText":null,"loadTimedOut":false},"attr":"native","styleNodes":0,"darkraiAdopted":0,"groups":{},"settled":true,"siteDarkAttr":true,"rootBg":"rgb(15, 15, 15)","detection":{"dark":true,"confident":true,"declaredDark":false,"usable":9,"darkCount":9}} |
| P1-2b (run 2026-11-06T08-55-09-476) | P1 | https://www.youtube.com/ in light -> on | PASS | {"finalUrl":"https://www.youtube.com/","nav":{"errorText":null,"loadTimedOut":false},"attr":"on","styleNodes":9,"darkraiAdopted":2,"groups":{"base":1,"override":8},"settled":true,"siteDarkAttr":false,"rootBg":"rgb(24, 24, 24)","detection":{"dark":false,"confident":true,"declaredDark":false,"usable":9,"darkCount":0}} |
| P1-2c (run 2026-11-06T08-55-09-476) | P1 | live theme switch (no reload) on MDN: native when the site turns dark, darkened again when it turns light | PASS | {"before":{"attr":"on","styles":42,"rootBg":"rgb(24, 25, 27)","bodyBg":"rgba(0, 0, 0, 0)"},"dark":{"attr":"native","styleNodes":0,"adopted":0,"afterMs":477,"rootBg":"rgb(24, 25, 27)","bodyBg":"rgba(0, 0, 0, 0)","prefersDark":true},"offMeasure":null,"mdnOwnBgLuminance":0.01,"mdnSwitchedLive":true,"back":{"attr":"on","styles":41,"afterMs":420,"rootBg":"rgb(24, 25, 27)"}} |
| P1-3L https://en.wikipedia.org/wiki/Moon (run 2026-11-06T08-55-09-476) | P1 | no unexplained light regions on darkened https://en.wikipedia.org/wiki/Moon | PASS | {"finalUrl":"https://en.wikipedia.org/wiki/Moon","found":1,"unexplained":0,"regions":[{"id":6,"box":[772,424,161,138],"area":11348,"solid":0.51,"x":852.5,"y":493.5,"explained":true,"why":"inside media a > img.mw-file-element.mw-file-upright","stack":[{"el":"a > img.mw-file-element.mw-file-upright","bgColor":"rgba(0, 0, 0, 0)","bgImage":"none","colorScheme":"dark"},{"el":"tr > td.infobox-image","bg... |
| P1-3 https://en.wikipedia.org/wiki/Moon (run 2026-11-06T08-55-09-476) | P1 | readability on darkened https://en.wikipedia.org/wiki/Moon | PASS | {"url":"https://en.wikipedia.org/wiki/Moon","finalUrl":"https://en.wikipedia.org/wiki/Moon","text":{"measured":110,"below":0,"uncertain":0,"exempt":0,"worst":[]},"icons":{"measured":14,"below":0,"worst":[]},"light":{"found":1,"unexplained":0},"timing":{"decisionMs":2267.0999999996275,"firstPaintMs":2271.5,"settleMs":10257.5},"shots":["en_wikipedia_org_wiki_Moon-off.png","en_wikipedia_org_wiki_Moon... |
| P1-3L https://news.ycombinator.com/ (run 2026-11-06T08-55-09-476) | P1 | no unexplained light regions on darkened https://news.ycombinator.com/ | PASS | {"finalUrl":"https://news.ycombinator.com/","found":0,"unexplained":0,"regions":[]} |
| P1-3 https://news.ycombinator.com/ (run 2026-11-06T08-55-09-476) | P1 | readability on darkened https://news.ycombinator.com/ | PASS | {"url":"https://news.ycombinator.com/","finalUrl":"https://news.ycombinator.com/","text":{"measured":230,"below":0,"uncertain":0,"exempt":0,"worst":[]},"icons":{"measured":1,"below":0,"worst":[]},"light":{"found":0,"unexplained":0},"timing":{"decisionMs":1088.2000000011176,"firstPaintMs":1092.1000000014901,"settleMs":1116.6000000014901},"shots":["news_ycombinator_com_-off.png","news_ycombinator_co... |
| P1-3L https://developer.mozilla.org/en-US/docs/Web/CSS (run 2026-11-06T08-55-09-476) | P1 | no unexplained light regions on darkened https://developer.mozilla.org/en-US/docs/Web/CSS | FAIL | 1 light region(s) not explained: [0,0,1265,56] painted light by a > span.placement-cta  |
| P1-3 https://developer.mozilla.org/en-US/docs/Web/CSS (run 2026-11-06T08-55-09-476) | P1 | readability on darkened https://developer.mozilla.org/en-US/docs/Web/CSS | PASS | {"url":"https://developer.mozilla.org/en-US/docs/Web/CSS","finalUrl":"https://developer.mozilla.org/en-US/docs/Web/CSS","text":{"measured":48,"below":0,"uncertain":0,"exempt":0,"worst":[]},"icons":{"measured":0,"below":0,"worst":[]},"light":{"found":1,"unexplained":1},"timing":{"decisionMs":476.90000000037253,"firstPaintMs":652.9000000003725,"settleMs":1313},"shots":["developer_mozilla_org_en_US_d... |
| P1-3L https://www.bbc.com/news (run 2026-11-06T08-55-09-476) | P1 | no unexplained light regions on darkened https://www.bbc.com/news | FAIL | 1 light region(s) not explained: [269,183,728,90] cross-origin frame painted light (100% of its box bright, element color-scheme dark)  |
| P1-3 https://www.bbc.com/news (run 2026-11-06T08-55-09-476) | P1 | readability on darkened https://www.bbc.com/news | PASS | {"url":"https://www.bbc.com/news","finalUrl":"https://www.bbc.com/news","text":{"measured":34,"below":0,"uncertain":0,"exempt":0,"worst":[]},"icons":{"measured":3,"below":0,"worst":[]},"light":{"found":4,"unexplained":1},"timing":{"decisionMs":2102.2000000011176,"firstPaintMs":2106.5999999996275,"settleMs":2749.300000000745},"shots":["www_bbc_com_news-off.png","www_bbc_com_news-on.png"]} |
| P1-3L https://stackoverflow.com/questions (run 2026-11-06T08-55-09-476) | P1 | no unexplained light regions on darkened https://stackoverflow.com/questions | PASS | {"finalUrl":"https://stackoverflow.com/questions","found":0,"unexplained":0,"regions":[]} |
| P1-3 https://stackoverflow.com/questions (run 2026-11-06T08-55-09-476) | P1 | readability on darkened https://stackoverflow.com/questions | PASS | {"url":"https://stackoverflow.com/questions","finalUrl":"https://stackoverflow.com/questions","text":{"measured":94,"below":0,"uncertain":0,"exempt":2,"worst":[]},"icons":{"measured":5,"below":0,"worst":[]},"light":{"found":0,"unexplained":0},"timing":{"decisionMs":1245.5999999996275,"firstPaintMs":1247.5,"settleMs":4738.4000000003725},"shots":["stackoverflow_com_questions-off.png","stackoverflow_... |
| P1-3L https://old.reddit.com/ (run 2026-11-06T08-55-09-476) | P1 | no unexplained light regions on darkened https://old.reddit.com/ | PASS | {"finalUrl":"https://old.reddit.com/login/?reason=lor2&dest=https%3A%2F%2Fold.reddit.com%2F","found":0,"unexplained":0,"regions":[]} |
| P1-3 https://old.reddit.com/ (run 2026-11-06T08-55-09-476) | P1 | readability on darkened https://old.reddit.com/ | PASS | {"url":"https://old.reddit.com/","finalUrl":"https://old.reddit.com/login/?reason=lor2&dest=https%3A%2F%2Fold.reddit.com%2F","text":{"measured":15,"below":0,"uncertain":0,"exempt":3,"worst":[]},"icons":{"measured":5,"below":0,"worst":[]},"light":{"found":0,"unexplained":0},"timing":{"decisionMs":810.2999999988824,"firstPaintMs":814.2999999988824,"settleMs":1863.4000000003725},"shots":["old_reddit_... |
| P1-3L https://www.youtube.com/ (run 2026-11-06T08-55-09-476) | P1 | no unexplained light regions on darkened https://www.youtube.com/ | PASS | {"finalUrl":"https://www.youtube.com/","found":0,"unexplained":0,"regions":[]} |
| P1-3 https://www.youtube.com/ (run 2026-11-06T08-55-09-476) | P1 | readability on darkened https://www.youtube.com/ | PASS | {"url":"https://www.youtube.com/","finalUrl":"https://www.youtube.com/","text":{"measured":7,"below":0,"uncertain":0,"exempt":3,"worst":[]},"icons":{"measured":13,"below":0,"worst":[]},"light":{"found":0,"unexplained":0},"timing":{"decisionMs":5933.4000000003725,"firstPaintMs":5937.5,"settleMs":8365},"shots":["www_youtube_com_-off.png","www_youtube_com_-on.png"]} |
| P2-gh-dark (run 2026-11-06T08-55-09-476) | P2 | https://github.com/ in dark -> native | FAIL | got data-darkrai="on", 21 style nodes, 16 adopted sheets at https://github.com/  |
| P2-gh-light (run 2026-11-06T08-55-09-476) | P2 | https://github.com/ in light -> on | PASS | {"finalUrl":"https://github.com/","nav":{"errorText":null,"loadTimedOut":false},"attr":"on","styleNodes":27,"darkraiAdopted":17,"groups":{"base":1,"override":26},"settled":false,"siteDarkAttr":false,"rootBg":"rgb(24, 24, 24)","detection":{"dark":false,"confident":true,"declaredDark":false,"usable":6,"darkCount":0}} |
| P2-g-dark (run 2026-11-06T08-55-09-476) | P2 | https://www.google.com/search?q=dark+mode in dark -> native | PASS | {"finalUrl":"https://www.google.com/search?q=dark+mode&sei=M5ftaqvvNpLz4-EP7b7VkQI","nav":{"errorText":null,"loadTimedOut":false},"attr":"native","styleNodes":0,"darkraiAdopted":0,"groups":{},"settled":true,"siteDarkAttr":false,"rootBg":"rgb(34, 36, 42)","detection":{"dark":true,"confident":true,"declaredDark":true,"usable":8,"darkCount":8}} |
| P2-g-light (run 2026-11-06T08-55-09-476) | P2 | https://www.google.com/search?q=dark+mode in light -> on | NOT RUN | Google served its bot-check (/sorry/) page instead of results  |
| P2-errors (run 2026-11-06T08-55-09-476) | P2 | exceptions and console errors (popup, options, isolated worlds, worker) | PASS | {"byWhere":{},"note":"popups are attached after they open, so errors thrown before attach are not seen; the worker is only watched after the sleep test"} |
| P1-1a | P1 | popup opens and is filled while the service worker is asleep | PASS | {"openPopup":"ok","popupTargetAfterMs":385,"asleepBy":"idle timeout (35 s)","serviceWorkerRunningAtRead":false,"popup":{"fcpMs":null,"status":"Darkened by Darkrai","host":"en.wikipedia.org","notice":null,"enabledChecked":true,"mode":"auto","bodyText":466,"dot":"on"},"paint":{"fcpMs":null,"paintEntries":[],"screenshotColours":50,"ok":true},"siteBefore":"on"} |
| P1-1b | P1 | Never / Auto in the popup apply to the tab within 1 s, no reload | PASS | {"neverAfterMs":427,"neverAttr":"off","neverStyles":0,"autoAfterMs":688,"autoAttr":"on","autoStyles":3,"reloads":0} |
| P1-1c | P1 | 20 rapid master-switch toggles end consistent, no style leaks | FAIL | storage/switch/page disagree; style set after toggling matches neither the baseline nor a fresh load, or has duplicates  |
| P1-1c-main-thread | P1 | 20 rapid toggles: the tab answers within 1 s at every probe, no task of 200 ms or more | FAIL | slowest answer none within 5000 ms (3 probe(s)), longest task 0 ms, total blocking 0 ms  |
| P1-1e chrome://extensions/ | P1 | popup explains restricted page chrome://extensions/ | PASS | {"fcpMs":null,"status":"Chrome doesn't allow extensions on this page (settings pages, Web Store, PDF viewer).","host":"this page","notice":"Chrome doesn't allow extensions on this page (settings pages, Web Store, PDF viewer).","enabledChecked":true,"mode":"auto","bodyText":577,"dot":"off"} |
| P1-1e chrome://settings/ | P1 | popup explains restricted page chrome://settings/ | PASS | {"fcpMs":null,"status":"Chrome doesn't allow extensions on this page (settings pages, Web Store, PDF viewer).","host":"this page","notice":"Chrome doesn't allow extensions on this page (settings pages, Web Store, PDF viewer).","enabledChecked":true,"mode":"auto","bodyText":577,"dot":"off"} |
| P1-1e https://chromewebstore.google.com/ | P1 | popup explains restricted page https://chromewebstore.google.com/ | PASS | {"fcpMs":null,"status":"Chrome doesn't allow extensions on the Chrome Web Store.","host":"https://chromewebstore.google.com/","notice":"Chrome doesn't allow extensions on the Chrome Web Store.","enabledChecked":true,"mode":"auto","bodyText":544,"dot":"off"} |
| P1-1e https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf | P1 | popup explains restricted page https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf | PASS | {"fcpMs":null,"status":"Chrome doesn't allow extensions inside the built-in PDF viewer.","host":"https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf","notice":"Chrome doesn't allow extensions inside the built-in PDF viewer.","enabledChecked":true,"mode":"auto","bodyText":595,"dot":"off"} |
| P1-1f | P1 | keyboard shortcut Alt+Shift+D (the physical key press) | NOT RUN | browser accelerators cannot be triggered through CDP; P4-shortcut-key checks the binding and P4-shortcut-proxy the handler, the key press itself stays on the README manual checklist  |
| P4-always-youtube | P4 | This site: Always on YouTube in its own dark theme turns Darkrai on, Auto hands it back (no reload) | PASS | {"alwaysAfterMs":1761,"alwaysStyles":4,"popupWhileAlways":{"siteMode":"on","status":"Darkened by Darkrai"},"autoAfterMs":669,"autoAttr":"native","autoStyles":0,"storedEntry":{"mode":"auto"},"reloads":0,"clickedVia":["label","label"]} |
| P4-master | P4 | master switch off then on: the page drops its styles and gets them back, no reload | PASS | {"offAfterMs":730,"offAttr":"off","offStyles":0,"storedWhileOff":false,"popupWhileOff":{"enabled":false,"status":"Darkrai is off everywhere."},"pickWhileOff":{"disabled":true,"help":"Available while Darkrai is darkening this page."},"onAfterMs":1490,"onStyles":3,"storedAfterOn":true,"reloads":0,"clickedVia":["label","label"]} |
| P4-shot | P4 | real-Chrome screenshot of the popup: results/<run>/popup-real.png, under 2000 px a side | PASS | {"file":"popup-real.png","width":360,"height":600,"popupOpenAfterShot":true} |
| P4-fit | P4 | default state in the real popup: 360px wide, the page does not scroll, only the screen panel does, no clipped text | PASS | {"innerWidth":360,"innerHeight":600,"bodyWidth":360,"pageScrollHeight":600,"pageClientHeight":600,"panelOverflowY":"auto","panelScrollHeight":653,"panelClientHeight":420,"panelScrollbar":10,"panelContentWidth":304,"schedule":"always","lookOpen":false,"clipped":[]} |
| P4-never-auto | P4 | This site: Never then Auto (the same real clicks as P1-1b) | PASS | {"sameAs":"P1-1b"} |
| P4-engine | P4 | Mode: Smart -> Simple applies the filter engine (html filter style), Smart again restores the recolouring | PASS | {"simpleAfterMs":816,"simpleGroups":{"simple":1},"simpleEngine":"simple","htmlFilterSimple":"invert(0.9) hue-rotate(180deg)","storedSimple":{"engine":"filter","mode":"auto"},"smartAfterMs":1683,"smartGroups":{"base":1,"override":2},"smartEngine":"smart","htmlFilterSmart":"none","storedSmart":{"engine":"smart","mode":"auto"}} |
| P4-brightness | P4 | Look panel: a brightness change is saved and repaints the page | PASS | {"panelOpenedBy":"real click on #look-summary","input":"keyboard: ArrowRight on the focused slider","before":100,"after":105,"stored":105,"summary":"Look: Dark gray · Brightness 105","page":{"before":{"rootBg":"rgb(24, 24, 24)","bodyBg":"rgb(26, 27, 27)","bodyColor":"rgb(193, 194, 195)"},"after":{"rootBg":"rgb(26, 26, 26)","bodyBg":"rgb(248, 249, 250)","bodyColor":"rgb(32, 33, 34)","styleTextChang... |
| P4-persist | P4 | close the popup and open it again: every control shows the same state | PASS | {"state":{"enabled":true,"siteMode":"auto","engine":"smart","look":"gray","brightness":"105","contrast":"100","warmth":"0","dimImages":false,"lookSummary":"Look: Dark gray · Brightness 105","schedule":"always","from":"19:00","to":"07:00","hoursShown":true,"status":"Darkened by Darkrai","host":"en.wikipedia.org","shortcut":"Alt+Shift+D"},"nonDefault":["brightness 105"]} |
| P4-pick | P4 | Fix something unreadable: the picker comes up in the page, Escape cancels it, nothing is saved | PASS | {"clickedVia":"control","pickerShown":true,"popupClosedItself":true,"cancelledBy":"real Escape key press in the page","pickerGone":true,"fixesStyleLeft":false,"sitesChanged":false} |
| P4-schedule | P4 | Schedule: Custom hours enables From/To, editing them saves and sets the schedule alarm, Always removes it | PASS | {"input":"value set + input/change events (native select and time widgets are outside the page)","fieldsAlways":{"schedule":{"shown":true,"disabled":false,"value":"always"},"from":{"shown":true,"disabled":true,"value":"19:00"},"to":{"shown":true,"disabled":true,"value":"07:00"}},"fieldsHours":{"schedule":{"shown":true,"disabled":false,"value":"hours"},"from":{"shown":true,"disabled":false,"value":... |
| P4-dropdowns | P4 | Look and Schedule lists open on a real click, are themed (no default light blue), fit 360x600, real option clicks save; keyboard and Escape; options #default-mode | FAIL | stopped at "look: real click on True black": Runtime.evaluate: Session with given id not found. (the popup had closed)  |
| P4-reset-site | P4 | Reset this site forgets this site's entry and leaves every other entry alone | PASS | {"forgot":"en.wikipedia.org","armedText":"Confirm: forget en.wikipedia.org","statusAfter":"en.wikipedia.org is forgotten: it follows the global default again. No other entry changed.","othersKept":["docs.google.com","example.org","youtube.com"],"clickedVia":["control","control"]} |
| P4-hard-reset | P4 | Hard reset… opens options.html#danger and resets nothing by itself | PASS | {"opened":"chrome-extension://ncmkbifcncembabcddlgempegnlighce/options/options.html#danger","storageUnchanged":true,"clickedVia":"control"} |
| P4-options | P4 | Options opens options.html | PASS | {"how":"brought the already-open options tab to the front","url":"chrome-extension://ncmkbifcncembabcddlgempegnlighce/options/options.html"} |
| P4-reload | P4 | Reload this tab reloads it exactly once | PASS | {"mainFrameNavigations":["https://en.wikipedia.org/wiki/Moon"],"attrAfter":"on","stylesAfter":21} |
| P4-shortcut-key | P4 | chrome.commands.getAll(): toggle-site has Alt+Shift+D assigned | PASS | {"commands":[{"description":"","name":"_execute_action","shortcut":""},{"description":"Turn Darkrai on or off for this site","name":"toggle-site","shortcut":"Alt+Shift+D"}]} |
| P4-shortcut-proxy | P4 | the shortcut's handler, toggleSite(active tab) in the service worker, turns the site off and on | PASS | {"note":"the onCommand listener's own name filter and the physical Alt+Shift+D press are not exercised (manual checklist)","toggleSite":"function","onCommandListeners":true,"activeTab":"https://en.wikipedia.org/wiki/Moon","firstCall":{"offAfterMs":671,"storedMode":"off"},"secondCall":{"activeTab":"https://en.wikipedia.org/wiki/Moon","onAfterMs":1429,"storedMode":"on"}} |
| P3-reset | P3 | hard reset from options.html#danger restores factory defaults | PASS | {"changedTabAttr":"off","stage2Button":"Yes, erase everything","dialogStatus":"Done. Darkrai is exactly as it was when it was installed. Open tabs: 1 cleaned, 1 back on the defaults, 0 could not be put back.","dialogSteps":["Done: Saved settings erased — local: cleared (this is where every Darkrai setting lives); session: cleared - Darkrai stores nothing here, but the API exists so it was cleared ... |
| P1-1d | P1 | after an extension reload the old tab still responds, one copy of styles | NOT RUN | harness limit: after chrome.runtime.reload() the CDP-loaded unpacked extension stayed disabled, also after a second Extensions.loadUnpacked and with developer_mode set in the profile (see crbug.com/402532200); needs the manual check: reload at chrome://extensions, then use an old tab  |

## Readability (problem 3)

Text: computed colour over the alpha-composited stack from `elementsFromPoint`; text over background images or inside an invert filter is counted as uncertain, not measured. Icons: real screenshot pixels, 90th-percentile pixel inside the box against the median of a ring 2 px outside it. Targets: 4.5:1 text, 3:1 large text and icons.

### https://en.wikipedia.org/wiki/Moon

Text 0 of 110 below target (0 uncertain); light regions 0 unexplained of 1; icons 0 of 14 below 3:1. Screenshots: `results/2026-11-06T09-17-10-121/en_wikipedia_org_wiki_Moon-off.png`, `results/2026-11-06T09-17-10-121/en_wikipedia_org_wiki_Moon-on.png`.
Timing (ms since navigation start): decision 2267, first paint 2272, settle 10258.

### https://news.ycombinator.com/

Text 0 of 230 below target (0 uncertain); light regions 0 unexplained of 0; icons 0 of 1 below 3:1. Screenshots: `results/2026-11-06T09-17-10-121/news_ycombinator_com_-off.png`, `results/2026-11-06T09-17-10-121/news_ycombinator_com_-on.png`.
Timing (ms since navigation start): decision 1088, first paint 1092, settle 1117.

### https://developer.mozilla.org/en-US/docs/Web/CSS

Text 0 of 48 below target (0 uncertain); light regions 1 unexplained of 1; icons 0 of 0 below 3:1. Screenshots: `results/2026-11-06T09-17-10-121/developer_mozilla_org_en_US_docs_Web_CSS-off.png`, `results/2026-11-06T09-17-10-121/developer_mozilla_org_en_US_docs_Web_CSS-on.png`.
Timing (ms since navigation start): decision 477, first paint 653, settle 1313.

### https://www.bbc.com/news

Text 0 of 34 below target (0 uncertain); light regions 1 unexplained of 4; icons 0 of 3 below 3:1. Screenshots: `results/2026-11-06T09-17-10-121/www_bbc_com_news-off.png`, `results/2026-11-06T09-17-10-121/www_bbc_com_news-on.png`.
Timing (ms since navigation start): decision 2102, first paint 2107, settle 2749.

### https://stackoverflow.com/questions

Text 0 of 94 below target (0 uncertain, 2 exempt: inside disabled controls); light regions 0 unexplained of 0; icons 0 of 5 below 3:1. Screenshots: `results/2026-11-06T09-17-10-121/stackoverflow_com_questions-off.png`, `results/2026-11-06T09-17-10-121/stackoverflow_com_questions-on.png`.
Timing (ms since navigation start): decision 1246, first paint 1248, settle 4738.

### https://old.reddit.com/

Text 0 of 15 below target (0 uncertain, 3 exempt: inside disabled controls); light regions 0 unexplained of 0; icons 0 of 5 below 3:1. Screenshots: `results/2026-11-06T09-17-10-121/old_reddit_com_-off.png`, `results/2026-11-06T09-17-10-121/old_reddit_com_-on.png`.
Timing (ms since navigation start): decision 810, first paint 814, settle 1863.

### https://www.youtube.com/

Text 0 of 7 below target (0 uncertain, 3 exempt: inside disabled controls); light regions 0 unexplained of 0; icons 0 of 13 below 3:1. Screenshots: `results/2026-11-06T09-17-10-121/www_youtube_com_-off.png`, `results/2026-11-06T09-17-10-121/www_youtube_com_-on.png`.
Timing (ms since navigation start): decision 5933, first paint 5938, settle 8365.

## Popup (P4)

Real-Chrome screenshot of the popup: `results/2026-11-06T09-17-10-121/popup-real.png` (360x600 px).

## Not automatable

- The Alt+Shift+D key press itself: browser accelerators cannot be sent through CDP. P4-shortcut-key checks the binding with chrome.commands.getAll() and P4-shortcut-proxy calls the handler's toggleSite() for the active tab; the key press stays on the README manual checklist.
