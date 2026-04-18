# Portfolio Command Centre — Refactor Plan

## 1. Context and goals

Portfolio Command Centre (PCC) is a single-file, client-side dashboard deployed via GitHub Pages from the repository root. Today the entire application, including a ~4.5 MB baked price-history blob, lives inside one 4.6 MB `index.html`. This plan describes a phased migration toward the architecture used by the related `equity-defense-dashboard` repository: a `template.html`, a `data/` directory of generated JSON, a build pipeline, and a `docs/` output directory that Pages serves from.

The goal is not to ship a big-bang rewrite. The goal is to move PCC to a maintainable shape over several short, self-contained sessions, with the live dashboard remaining green after every single commit.

## 2. Current state (PCC today)

The repository root contains `index.html`, `build.js`, `README.md`, `.nojekyll`, and two GitHub Actions workflows. There is no `package.json`, no `.gitignore`, no `CLAUDE.md`, no `data/`, no `docs/`, and no `template.html`.

`index.html` is a 3060-line, 4.6 MB file. The structural skeleton is: DOCTYPE and `<head>` at lines 1–288 (inline `<style>` spans 17–287, Plotly CDN at 16), `<body>` opens at 289, and a single `<script>` block runs from 350 to 3058. Inside that script, `POSITIONS` is defined at line 360, `SNAPSHOT` at 423, the `PRELOADED_HISTORY` blob at 446, `PRELOADED_DATE` at 448, and roughly 35 functions covering data loading, indicators, backtests, tab rendering, and the crisis overlay.

`build.js` is a Node 18+ script (native fetch) that reads `index.html`, regex-extracts the `yf:` symbols, fetches 10 years of daily OHLC plus three FX pairs from Yahoo Finance with CORS-proxy fallbacks, then string-replaces `PRELOADED_HISTORY`, `PRELOADED_DATE`, and per-symbol `SNAPSHOT` entries directly inside `index.html`. There is no separation between template and output: the source file and the built artefact are the same file.

Two scheduled workflows both bake prices into `index.html`: `bake.yml` runs Mon–Fri at 22:00 UTC, and `update-prices.yml` runs Sun–Thu at 23:00 UTC. They are effectively duplicates and will collide.

## 3. Target architecture (adapted from equity-defense-dashboard)

```
PCC (target)
├── template.html              ← HTML + CSS + JS shell with an injection marker
├── build.js                   ← Node pipeline: fetch → write data/ → inject → write docs/
├── data/
│   ├── history.json           ← Baked OHLC per ticker
│   ├── fx.json                ← FX snapshots
│   └── meta.json              ← Build date, ticker list, version
├── docs/
│   └── index.html             ← Built artefact served by GitHub Pages
├── .github/workflows/
│   └── update.yml             ← Single daily workflow
├── package.json
├── .gitignore
├── CLAUDE.md
├── README.md
└── .nojekyll
```

This mirrors the equity-defense-dashboard shape (`template.html` + `scripts/pipeline.py` + `data/*.json` + `docs/index.html` + a single `update.yml`) while keeping PCC on Node.

## 4. Migration principles

PCC stays on Node. The existing `build.js` uses Node 18+ native fetch and works well. The template + data/ + build pipeline + docs/ pattern is language-agnostic — equity-defense-dashboard uses Python because of its heavier signal computation needs, not because the pattern requires it. Introducing Python to PCC would add complexity without functional benefit. PCC and equity-defense-dashboard can keep different languages; unification across repos is not a goal of this refactor.

Beyond the language decision, the working principles are: the live dashboard must remain green after every commit; each phase must be completable in a single session with one clean commit; each phase must be reversible via either `git revert` or a snapshot branch; no phase may begin until the previous one has been deployed and visually verified in production.

## 5. Phased migration sequence

### Phase 0 — Repository hygiene (30–45 minutes)

Scope. Add the scaffolding a future refactor will rely on, without touching application code.

Deliverables. Create `CLAUDE.md` (PCC-specific, ~40–60 lines of prose — see Appendix B). Create `.gitignore` covering `node_modules/`, `.DS_Store`, `*.log`, and local environment files. Create `package.json` declaring Node 18+ engines, the `build` script pointing at `node build.js`, and no runtime dependencies. Consolidate `bake.yml` and `update-prices.yml` into a single `update.yml` running once per weekday — delete the other two files in the same commit so there is never a period with three workflows active.

Verification. Run `node build.js --dry-run` locally and confirm it still prints the expected ticker count and bar counts. Run `gh workflow list` (or view the Actions tab) and confirm only one scheduled workflow remains. Confirm `git status` shows `node_modules/` is ignored after a throwaway `npm install`.

Rollback. `git revert` of the single commit is sufficient. No snapshot branch needed.

Dependencies. None. This is the entry point.

Post-flight note (2026-04-17). Completed. Consolidated workflow `update.yml` ran green on manual dispatch (32 seconds). Live dashboard unaffected. Git index-lock issue on the Linux mount meant all git write operations (add, commit, push) had to run from Windows PowerShell rather than the sandbox — plan for this in future sessions. No follow-ups.

### Phase 1 — Extract `template.html` with injection marker (45–60 minutes)

Scope. Create `template.html` as a copy of `index.html` with the `PRELOADED_HISTORY` and `PRELOADED_DATE` assignments replaced by a single marker comment such as `/* __INJECT_DATA__ */`. `index.html` itself is not yet deleted; it continues to be served from the repo root.

Deliverables. New `template.html` containing the shell (HTML, CSS, JS) minus the baked data. Updated `build.js` that reads `template.html`, performs injection, and writes the result back to `index.html` at the repo root (still the Pages source). The template and the injected output should produce a byte-identical `index.html` to what the current pipeline produces, modulo the injection marker's whitespace.

Verification. Run `node build.js` and diff the resulting `index.html` against the pre-phase version using `git diff --stat`. The only changes should be the freshly fetched price numbers, not structural differences. Open the rebuilt `index.html` in a local server (`python -m http.server` or `npx serve`) and confirm all six tabs render, KPIs load, and at least one stock chart expands. Cross-browser check in Chrome and Edge.

Rollback. Snapshot branch required. Before starting, create `snapshot/pre-phase-1` pointing at current `main`. If the rebuilt `index.html` has any visible regression, reset `main` to the snapshot rather than trying to forward-fix. Git alone is not sufficient because the blob edits are non-trivial to un-merge if something goes wrong mid-session.

Dependencies. Phase 0 complete.

Post-flight note (2026-04-17). Completed. `template.html` is a 171 KB shell with `/* __INJECT_DATA__ */` on line 446; `build.js` now reads the template, injects the data block at the marker, and writes `index.html` at the repo root. Local byte-identity test (template plus HEAD's data block reproduces committed `index.html` exactly) passed, and the end-to-end local bake produced the expected +5/−5 diff on `index.html` — PRELOADED_HISTORY line plus four SNAPSHOT prices, no structural movement. Manual dispatch of `update.yml` under the new pipeline ran green and the live dashboard rendered correctly before and after the CI bake. Surprise worth carrying forward: files edited from the Linux sandbox can arrive on Windows with the `assume-unchanged` index bit set, which makes `git add` silently ignore them. The first Phase 1 commit landed with `build.js` missing as a result; recovered by writing a fresh blob with `git hash-object -w build.js` and pointing the index entry at it via `git update-index --cacheinfo 100644 $sha build.js`, followed by `git update-index --no-assume-unchanged build.js`. Rule for future sessions: if a known-modified file does not appear in any section of `git status`, run `git ls-files -v -- <path>` first — a lowercase flag character means an assume-unchanged bit is in play. Minor follow-up, not urgent: the `build.js` diff stat came in at 221 insertions and 220 deletions where the semantic change was perhaps 25 lines, suggesting LF/CRLF churn from sandbox-authored content hitting a CRLF-origin file; a `.gitattributes` with `* text=auto eol=lf` would quieten future diffs from the sandbox.

### Phase 2 — Move baked data out of HTML into `data/history.json` (60–90 minutes)

Scope. Stop inlining the ~4.5 MB `PRELOADED_HISTORY` blob into the HTML. Instead, write it to `data/history.json` and `data/fx.json`, and have the dashboard fetch the JSON on load (with a loading state). The `PRELOADED_DATE` becomes part of `data/meta.json`.

Deliverables. Updated `build.js` that writes three JSON files into `data/` instead of injecting the blob. Updated `template.html` with a small bootstrap function that fetches `data/history.json`, `data/fx.json`, and `data/meta.json` at startup, populates the equivalent in-memory structures, then proceeds with existing render logic. Loading spinner visible for the fetch duration. LocalStorage cache behaviour preserved.

Remove the Yahoo Finance CORS-proxy live-fetch fallback from the production code path. The client always serves `data/history.json` via fetch; no upstream network requests from browsers. Add a "Data as of: YYYY-MM-DD" label in a visible location (header or footer, to be chosen during implementation) populated from `data/meta.json`. The label should be subtle but legible — users should be able to find it if they look, not have it shouted at them.

Keep the CORS-proxy fallback in a local-dev-only code path so running the dashboard locally without a populated `data/` directory still works. Mark the fallback with a comment along the lines of `// dev-only fallback — not reachable in production build` and gate it on an explicit condition (for example, `data/history.json` fetch returning 404 on localhost).

Verification. Load the page with DevTools Network tab open and confirm the three JSON files are fetched exactly once, with `Cache-Control` or `ETag` behaving sensibly. Confirm the dashboard renders identically to the pre-phase version — side-by-side comparison of KPIs, positions table, and at least two charts. Confirm the "Refresh Prices" button still works. Confirm localStorage cache is written on first load and honoured on second load (no network fetch for history).

Measure time-to-first-chart-render in the DevTools Performance panel on a cable-speed connection, both pre-phase and post-phase. Record both numbers in the session post-flight note. The post-phase value must be within 2 seconds of the pre-phase baseline. If the difference exceeds 2 seconds, treat it as a regression and investigate before shipping rather than rationalising the slower number.

Rollback. Snapshot branch required (`snapshot/pre-phase-2`). This phase touches both the build pipeline and the runtime bootstrap, so forward-fixing mid-session is risky. If verification fails, reset `main` to snapshot and re-scope in a later session.

Dependencies. Phase 1 complete. This is the largest single phase and the most likely to need a second session if verification surfaces issues.

Post-flight note (2026-04-18). Completed. `template.html` now boots with empty `PRELOADED_HISTORY` and `PRELOADED_DATE`; a new `bootstrap()` fetches `data/history.json`, `data/fx.json`, and `data/meta.json` in parallel before `init()` runs, and the CORS-proxy live-fetch path inside `init()` is gated to localhost via `isLocalhost()`. `build.js` stops injecting into HTML altogether: it writes the three JSON files into `data/`, copies `template.html` to `index.html` unmodified, and drops the SNAPSHOT-update regex. `update.yml` stages `data/` alongside `index.html`. Headline numbers: `index.html` fell from ~4.5 MB to 163 KB, `data/history.json` sits at 4470 KB on disk (~1054 KB on the wire under GitHub Pages gzip — roughly 4× compression), and the CI run time halved from ~32 s in Phase 0 to ~13 s here because the SNAPSHOT-regex pass is gone. Production Network-tab check on the live URL confirmed exactly three `data/*.json` GETs at 200 and zero hits to `corsproxy.io`, `allorigins.win`, or `query1.finance.yahoo.com` — the localhost gate holds. Manual dispatch of `update.yml` produced commit `58ec928` via the new pipeline and published cleanly. Time-to-first-chart-render: pre-phase baseline was not recorded in a recoverable form, so a strict within-two-seconds comparison is unavailable for this phase. Post-phase DOMContentLoaded on the live URL measured 1.21 s and Finish 2.27 s, which feels within a reasonable envelope for a JSON-fetch-based boot but is not a rigorous pass. Process lesson for future phases that require performance baselines: write the baseline number down at the moment it is taken, not later; Phase 2's pre-flight called for it and that step slipped. Also worth logging: the CRLF/LF churn concern raised as a follow-up at the end of Phase 1 did not recur in Phase 2's diff — `build.js` came in at 78 lines touched and `template.html` at 72, both consistent with semantic change rather than whole-file churn, because both files were already LF-origin after their Phase 1 sandbox edits. The `.gitattributes` follow-up therefore stays nice-to-have rather than escalating to urgent. Four follow-ups worth logging, none Phase 2 blockers. First: `data/meta.json` contains a `generatedAt` ISO timestamp that shifts every run, so the workflow now commits on days the market never moved — consider dropping the timestamp from the committed meta, or having `update.yml` compare only the stock history before committing. Second: Chrome's console warns that `<meta name="apple-mobile-web-app-capable">` is deprecated — unrelated to this phase, a one-line fix (replace with `mobile-web-app-capable`) whenever it becomes bothersome. Third: `CLAUDE.md`'s "Size constraint" section still names `index.html` at 4.6 MB as the file to avoid reading fully — that characterisation needs updating to point at `data/history.json` as the new large artefact, plus `docs/index.html` once Phase 3 lands. Fourth: the `.gitattributes` question flagged in Phase 1 remains open but now downgraded to nice-to-have on the strength of Phase 2's clean diff.

### Phase 3 — Refactor `build.js` into a pipeline writing to `docs/` (45–60 minutes)

Scope. Add `docs/index.html` as an additional output of the build pipeline. Both the root `index.html` and `docs/index.html` are written on every build during this transitional phase, so either serving location continues to work. Root `index.html` is not deleted in this phase.

Deliverables. Updated `build.js` that reads `template.html`, fetches data, writes `data/*.json`, and writes both `index.html` at the repo root and `docs/index.html`. `docs/.nojekyll` created. The build pipeline writes to both locations as a transitional state; root cleanup happens in Phase 4. The workflow updated to stage and commit `index.html`, `docs/index.html`, and `data/*.json`.

Verification. Run `node build.js` and confirm both `index.html` at the root and `docs/index.html` are created, and that `data/*.json` is written. Open each of the two HTML files via a local static server (for example, `npx serve .` then browse to `/index.html` and `/docs/index.html`) and confirm each renders all tabs independently. Diff the two files — they should be byte-identical aside from relative-path differences if any exist. Push this phase by itself; the live site continues to serve from the root, unchanged.

Rollback. Independently reversible via `git revert`. Because both locations are written and the Pages source has not changed, reverting Phase 3 alone leaves the live site untouched. Phase 4 can be executed in a separate session if needed. No snapshot branch required, though creating one remains cheap and is still recommended.

Dependencies. Phase 2 complete.

Post-flight note (2026-04-18). Completed. `build.js` now mirrors its full output into `docs/` alongside the root location: root writes `index.html` + `data/*.json` as before, and the new dual-write block also produces `docs/index.html`, `docs/data/*.json`, and `docs/.nojekyll` in one pass. `update.yml` stages `docs/` alongside `index.html` and `data/`. Local `(Get-FileHash index.html).Hash -eq (Get-FileHash docs/index.html).Hash` returned `True`, confirming the byte-identity invariant the plan called for. Manual dispatch of the updated workflow produced commit `fe333ed` which touched both root `data/*` and mirrored `docs/data/*` paths — proof the dual-write reaches the CI runner correctly. CI duration rose from ~13 s in Phase 2 to ~33 s here, consistent with doubling the write and diff surface. Push size for the refactor commit itself was ~1 MB, mostly the initial `docs/data/history.json`; subsequent bakes delta-compress well against the root copy. Three follow-ups worth logging, none Phase 3 blockers. First: `docs/.nojekyll` is a zero-byte marker file that GitHub Pages reads to skip Jekyll processing — worth a mental note so a future session does not delete it as apparently-empty rubbish. Second: the git churn per bake is now double — every weekday auto-bake commits six data files rather than three. This was a known cost of the Option A dual-write design and only matters until Phase 4 collapses it. Third: Phase 4's scope as written deletes only root `index.html`; it should also delete root `data/` in the same commit, so the collapse is clean and there is no orphaned, Pages-invisible `data/` directory left behind. Worth flagging at the start of Phase 4's session.

### Phase 4 — Switch GitHub Pages source to `docs/` and remove root `index.html` (15–30 minutes)

Scope. Change the Pages source in repository settings from "root" to "docs/" on the `main` branch, and delete the root `index.html` in the same commit as the cutover.

Deliverables. Pages configuration updated via GitHub UI or `gh api`. Root `index.html` deleted as part of this commit. Build pipeline updated to write only `docs/index.html` (the dual-write transitional state from Phase 3 is collapsed). Workflow updated to stage `docs/index.html` and `data/*.json` only. Commit note referencing the Pages cutover so the configuration change is findable from git history.

Verification. Before toggling the Pages source, confirm that `docs/index.html` is present on `main` and was built by the last successful workflow run. Toggle the Pages source setting, then push the commit that removes the root `index.html` and updates the pipeline. Wait for the Pages deploy to complete (usually 1–2 minutes). Hit the live URL and confirm the dashboard loads. Check a deep-link hash if any are used. Confirm no 404s in the Network tab for `data/*.json`. Force-refresh to confirm service-worker or browser cache is not masking a problem.

Rollback. Two-step: revert the cutover commit (restoring root `index.html` and the dual-write pipeline), and toggle Pages source back to root in GitHub settings. Because the Pages setting is UI-side, git revert alone will not restore the previous serving state — document the setting change in the commit message so future-you can undo it without guessing.

Dependencies. Phase 3 complete and deployed.

Post-flight note (2026-04-18). Completed. `build.js` collapsed from dual-write into a single-write pipeline rooted at `docs/`: the `DOCS_*` constants were folded into the primary names (`DATA_DIR`, `OUTPUT_FILE`, `HISTORY_FILE`, `FX_FILE`, `META_FILE`, plus a new `NOJEKYLL_FILE`) all pointing under `docs/`, and the separate Phase 3 dual-write block was removed. `update.yml` now stages `docs/` instead of `index.html data/ docs/`. Root `index.html` and root `data/` were deleted in the same cutover commit (`38f2ae0`). The staged diff was clean: 31 insertions and 43 deletions in `build.js` (a 12-line net reduction matching the semantic scope exactly, with essentially none of the CRLF-versus-LF churn that Phase 1's build.js edits suffered), plus the single-line `update.yml` swap and the four recorded deletions. Push size for the cutover commit itself was 1.55 KiB because no re-bake rode along — the local `node build.js` test run was discarded via `git checkout -- docs/` before staging, so the commit contained only the structural cutover and none of the intraday price shift.

The Pages source toggle from `branch main / (root)` to `branch main / docs` was performed via Settings → Pages after the commit was in place locally but before the push landed. That detail is called out explicitly in the commit body so a future `git revert 38f2ae0` alone will not silently leave Pages pointing at a directory whose `index.html` the revert has just restored at the wrong level — the revert must be paired with a Settings flip back to root. The `snapshot/pre-phase-4` branch is the clean rollback anchor if revert-plus-toggle ever becomes the wrong shape.

Three smoke-tests at the planned gates all passed: before toggle (root still serving), after toggle (docs/ serving current HEAD's pre-push content), after deploy (docs/ serving the post-push HEAD with root now gone). No 404s in any Network tab at any gate. The Pages rebuild after Settings flip took a minute or two; the second rebuild after the push took similar. The bake pipeline itself did not run this session because no scheduled or manual `update.yml` invocation was triggered — next scheduled run is Monday 22:00 UTC and will be the first to exercise the collapsed pipeline in anger.

Session housekeeping lesson worth recording. The session opened with a dirty working tree and a stale `.git/index.lock` left over from a prior interrupted session, compounded by a mount-cache inconsistency where the Linux sandbox saw every tracked file as simultaneously "staged deleted" and "untracked" while PowerShell saw the tree as clean. Recovery was `Remove-Item .git\index.lock ; git reset HEAD ; git checkout -- .` from PowerShell. The end-of-session housekeeping rule in `CLAUDE.md` (`git checkout -- data/ docs/`) is not sufficient on its own if a session was interrupted mid-git-write — consider widening it to `git reset HEAD ; git checkout -- .` plus an `.git/index.lock` sweep, or at least adding the recovery recipe inline in `CLAUDE.md`. The Phase 1 post-flight's observation that git writes must run from PowerShell rather than from the sandbox continues to hold and was respected throughout.

Follow-ups worth logging. First, the local browser smoke-check before commit was skipped this session because PowerShell blocked `npx serve` on execution policy, and the live post-toggle check was prioritised instead. Python's `http.server --directory docs` is a viable substitute for future phases that need the same visual gate. Second, the Phase 3 post-flight items remain open and now accumulate: the `generatedAt` timestamp in `meta.json` that shifts every bake (causing commits on days the market never moved), the `apple-mobile-web-app-capable` deprecation warning, and the `.gitattributes` LF-normalisation nice-to-have. Third, the `CLAUDE.md` "Size constraint" section is now stale on two counts — root `index.html` no longer exists, and the largest artefact is `docs/data/history.json` at roughly 4.4 MB rather than any `.html` file. A short follow-up commit to update that paragraph and point at `docs/data/history.json` would be worth doing before starting Phase 5. Fourth, the pre-Phase-2 stale `index.html` sitting on disk at 4.7 MB was still visible to the sandbox at session start even though Windows saw the correct 173 KB file. If that mount-cache inconsistency does not reset cleanly between sessions, reading `index.html` or its successors from the sandbox in Phase 5 could give the wrong file silently. A cheap `ls -l` plus `wc -c` sanity check at the top of each session would catch it.

### Phase 5 — Optional: split JS/CSS into source files (deferred, multi-session)

Scope. Extract the inline `<style>` (lines 17–287 today) into `src/styles.css`, and the inline `<script>` (lines 350–3058) into logical modules under `src/js/`. The build pipeline concatenates and injects them into `template.html`.

Deliverables. `src/` directory with extracted files. Updated `build.js` that reads and concatenates source files during the build. `template.html` becomes a thin shell with placeholders for styles and scripts.

Verification. Per-module: the module works in isolation (unit-style smoke check via a scratch HTML page). Integrated: the final `docs/index.html` passes all the checks from Phase 2.

Rollback. Not required in this plan — Phase 5 is explicitly deferred and should be re-scoped as a standalone plan when its time comes.

Dependencies. Phase 4 complete and stable for at least one week in production.

## 6. Open architectural questions

These are choices to make during execution, not before.

Data-file granularity in Phase 2: one `history.json` covering all tickers, or per-ticker files under `data/history/`? Per-ticker is more granular for diffs but adds filesystem noise. Default: single file, revisit if diffs become unwieldy.

LocalStorage cache in Phase 2: should the client still cache history, given that `data/history.json` is now a separate static asset with its own HTTP caching? Default: keep localStorage as a progressive enhancement, remove only if it causes a bug.

Workflow consolidation in Phase 0: one daily run or two (morning and evening)? Default: one, weekdays only. Revisit if price staleness becomes a complaint.

Built-output directory: `docs/` vs `dist/`. GitHub Pages has first-class support for `docs/`. Default: `docs/`.

## 7. Risk map per phase

Phase 0 is low risk. The blast radius is configuration only; the worst-case outcome is a broken workflow file, which is caught by a manual `workflow_dispatch` before the next scheduled run.

Phase 1 is medium risk. The blast radius is the build pipeline itself; a bad template extraction could silently corrupt the output. Detection is via post-build diff against the pre-phase `index.html`. Mitigation is the snapshot branch and a byte-level diff gate before pushing.

Phase 2 is the highest-risk phase. The blast radius is the runtime: a broken bootstrap fetch means the dashboard does not render at all. Detection is via local visual verification before push, plus live-site check within two minutes of push. Mitigation is the snapshot branch plus an explicit "do not start if under time pressure" rule — this phase deserves a fresh session.

Phase 3 is low-to-medium risk because of the dual-write transitional state: the live site continues to serve the root `index.html` regardless of whether `docs/index.html` is correct. The blast radius is the build pipeline, not the runtime. Detection is local verification of both output locations. Mitigation is `git revert`.

Phase 4 is medium risk because it involves a Pages configuration change that is not captured in git, and deletes the previous serving location in the same commit. The blast radius is the live site returning 404 if the cutover is mistimed. Detection is immediate via a live-URL smoke test. Mitigation is performing the Pages source toggle before pushing the deletion commit, keeping the cutover commit message explicit about the UI-side change, and keeping a snapshot branch available.

Phase 5 is low-to-medium risk per module, but the cumulative surface area is large. Because it is deferred and out of scope for this plan, it is not estimated further here.

## 8. Session plan template

Use this for every phase.

Before starting: re-read `CLAUDE.md` and this plan's entry for the phase being executed. Define "done" in one sentence at the top of the session. Create the snapshot branch if the phase requires one. Confirm the current `main` is green on the live site.

During execution: make the scoped change only — no drive-by cleanups, no phase blending. Use grep, line-range reads, and str-replace patches for `index.html` and `template.html`; never open either file in full. Run the local build after each meaningful edit.

Before committing: run the phase's verification steps in order. If any step fails, stop and either fix within the session or abort to the snapshot branch. Do not commit a partial phase.

Committing: one commit per phase, commit message in the form `refactor(phase-N): <one-line summary>`. Request approval before `git commit`. Request separate approval before `git push`. Never chain the two.

After push: watch the Actions run complete. Hit the live site and perform a smoke check. Update a short post-flight note in this plan's phase entry (date, anything surprising, follow-ups). Stop for the night — do not roll straight into the next phase.

Abort trigger: if anything looks inconsistent or harder than expected, stop and flag it rather than pushing forward. A clean plan update beats a half-finished phase committed under pressure.

## 9. Appendix A — File mapping

| PCC (target)                         | equity-defense-dashboard         |
|--------------------------------------|----------------------------------|
| `template.html`                      | `template.html`                  |
| `build.js`                           | `scripts/pipeline.py`            |
| `data/history.json`, `data/fx.json`  | `data/cache.json`                |
| `data/meta.json`                     | `data/signals.json` (metadata)   |
| `docs/index.html`                    | `docs/index.html`                |
| `.github/workflows/update.yml`       | `.github/workflows/update.yml`   |
| `CLAUDE.md`                          | (absent in reference repo)       |
| `package.json`                       | `requirements.txt`               |

## 10. Appendix B — Draft CLAUDE.md for Phase 0

```markdown
# Portfolio Command Centre — Working Notes

This file is durable context for future sessions working on this repository. Read it before starting any non-trivial task.

## What this project is

A single-page, client-side portfolio dashboard deployed via GitHub Pages. The architecture is in transition — see `REFACTOR_PLAN.md` for the target shape and current phase. Treat that plan as load-bearing.

## Size constraint

`index.html` is currently around 4.6 MB because it contains a baked `PRELOADED_HISTORY` blob at roughly line 446. Never open this file fully — it will overwhelm the context window. The same caution applies to `template.html` once it exists, and to any built artefact under `docs/`.

## Editing approach

Work on the large HTML files via grep, line-range reads, and str-replace patches only. No full-file reads. No full-file rewrites. If a change feels like it wants a rewrite, stop and re-scope — the refactor plan exists precisely so that large changes are handled as phases rather than as ad-hoc sweeps.

## Per-session discipline

Define "done" in one sentence at the start of the session. Ship one clean commit per phase and stop. Do not blend phases. Do not pile up small unrelated improvements into a single commit.

## Writing style

No contractions in code comments, commit messages, or documentation. British and Singapore English throughout. Plain prose with minimal headers and bullets unless a structured format is genuinely needed.

## Commit and push discipline

Separate approvals for `git commit` and `git push`. Never chain the two. The user will say "commit" and, after reviewing the result, will separately say "push".

## End-of-session housekeeping

Before typing /clear to end a session, run `git checkout -- data/ docs/` to discard any locally-modified pipeline outputs. These files are regenerated by the build pipeline and are owned by the scheduled workflow; leaving them as dirty working-tree state carries forward to the next session and blocks `git pull --rebase` on the next start-of-session ritual. This is a one-line fix to a recurring friction pattern — skipping it means the next session begins with 30 seconds of stash/rebase/pop recovery instead of clean pull.

## Verification gates for visual changes

Before rebuilding the dashboard, audit the diff against the previous build. After rebuilding, verify visually in a local static server. Cross-browser check in Chrome and Edge before committing. If the change affects the live dashboard, watch the Actions run complete and smoke-test the live URL before considering the session done.

## Related repository

`C:\dev\equity-defense-dashboard` is architectural reference only. Never modify files there from a PCC session. Read-only inspiration.
```
