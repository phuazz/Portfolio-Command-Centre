# Portfolio Command Centre — Working Notes

This file is durable context for future sessions working on this repository. Read it before starting any non-trivial task.

## What this project is

A single-page, client-side portfolio dashboard deployed via GitHub Pages. The delivery architecture (template → `docs/data/*.json` → `docs/index.html`, scheduled bake) was migrated under `REFACTOR_PLAN.md`, which is complete. Since 2026-07-11 the site publishes through GitHub Actions (`actions/upload-pages-artifact` + `actions/deploy-pages` in `update.yml`), not the legacy branch-based Pages builder, which had degraded on GitHub's side and stopped deploying; the deploy runs in the same workflow as the bake and is immune to repository size. The domain architecture was migrated under `REFACTOR_PLAN_V2.md` — ledger-first data model, unified valuation core, attribution v2. Phases A, A.1, B and C are complete and closed; Phase D (real-time hardening) is optional and deliberately parked. Treat both plans as load-bearing records of design intent and per-phase post-flight notes.

## Data model (ledger-first, since v2 Phase A)

`trades.json` at the repository root is the single manual input: one appended JSON row per fill. `book.json` carries the opening book at the 2026-01-01 epoch, static per-ticker metadata, cash reconciliation anchors (`cashAnchor` holds the last verified brokerage balances; trades dated strictly after the anchor date adjust the buckets), `costAdjustments` (broker-fee residues baked into historical cost figures) and `ledgerOverrides` (named, logged patches over known ledger gaps). Positions, average costs, invested amounts, cash buckets and pre-YTD bases are all derived at boot by `replayLedger()` in `template.html` — never hand-edited. `theses.json` is the third user-authored input: one concise investment thesis per holding, feeding the Thesis tab. `build.js` reads its ticker universe from the ledger files, validates the replay (a failed validation stops the bake), and copies all three into `docs/data/` for the client to fetch.

## Trade entry workflow

For a fill on an existing ticker: `node scripts/add_trade.js <YYYY-MM-DD> <B|S> <qty> <ticker> <price>` appends the row with currency, Yahoo symbol and theme resolved from the book (it refuses duplicates and unknown tickers), then `node scripts/validate_ledger.js` (structural gate — catches locally what would fail the bake), commit, push, trigger the build. Nothing else. For a brand-new ticker: also add one `meta` entry to `book.json` (name, exchange, ccy, theme, type, availLTV). When closing a position bought before 2026, ensure `epochCloses` in `book.json` carries its Dec-31-2025 close. Fees are not entered at order time; the monthly reconciliation below backfills them.

## Monthly statement reconciliation

Once a month the brokerage statement re-anchors the book, in one commit. The recipe: (1) reconcile every statement fill 1:1 against that month's `trades.json` rows on date, quantity and price — a statement fill missing from the ledger is added, statement-sourced; a ledger row absent from the statement stops the session; (2) backfill explicit `fee` values from the statement cash movements (buy fee = |cash| − q×p; sell fee = q×p − proceeds); (3) re-anchor `cashAnchor` to the statement's month-end Balance C/F per currency, keeping every existing currency key and writing zero where the statement prints no balance; (4) refresh the hand-maintained price of every position carrying a `noQuote` note in `book.json` — currently V7AB (Astrea 7A) alone — by updating its `mktPriceSnap`, and record in the commit message both the figure used and the date it was read; nothing refreshes these automatically, so a skipped month means the position simply carries its previous mark; (5) gate with `node scripts/validate_ledger.js --expect <expectations file>` — quantity exact, average within broker rounding, buckets tie exactly; any failure stops the session for review rather than being papered over with ad-hoc adjustments; (6) update the two HANDOVER bullets (fills reconciled, `cashAnchor`), commit, push, trigger `update.yml`, smoke-test the live data files. The expectations file is statement-derived and lives outside the repository; statements are personal documents and are never copied into this repository.

On sourcing the step-4 price: V7AB is held in CDP, not the brokerage sleeve, so it never appears on the SCB statement and the statement cannot supply its mark. The intended source is the public SGX quote for the counter (`https://www.sgx.com/fixed-income/products/V7AB`, listed as Astrea7A1 4.125%320527) or the CDP holdings statement. Two caveats to carry into the session. First, that page is a JavaScript application which failed to render in an automated browser on 2026-08-07, so the first reconciliation to run this step should establish by hand whether a last-done price is readable there and record the working source here for the next session. Second, the bond is a thinly traded retail issue: any last-done may be several days stale, so treat the figure as an approximate mark and not a live valuation. The position was S$10,340 at a `mktPriceSnap` of 1.034 when this step was written, 0.71 per cent of a S$1,451,355 book (measured 2026-08-07), so a wrong or missed mark is a small absolute error — but an undated one is invisible, which is why the date read belongs in the commit message.

## File sizes

`template.html` is ~332 KB (~5,800 lines, measured 2026-07-02) and fetch-based — safe to read in line ranges, never in full. The genuinely large file is `docs/data/history.json` (~11 MB); never open it. Since the 2026-07-11 Pages migration it is no longer tracked in git — it is gitignored and regenerated by every bake, and the live site serves it from the freshly-built Pages artifact rather than a committed copy. A fresh clone will not contain it until `node build.js` runs, and it is expected to show as untracked in a working tree that has been baked locally; this is correct, not a problem to fix. `docs/index.html` is a straight copy of the template.

## Editing approach

Work on the large HTML files via grep, line-range reads, and str-replace patches only. No full-file reads. No full-file rewrites. If a change feels like it wants a rewrite, stop and re-scope — the refactor plans exist precisely so that large changes are handled as phases rather than as ad-hoc sweeps.

## Per-session discipline

Define "done" in one sentence at the start of the session. Ship one clean commit per phase and stop. Do not blend phases. Do not pile up small unrelated improvements into a single commit.

## Writing style

No contractions in code comments, commit messages, or documentation. British and Singapore English throughout. Plain prose with minimal headers and bullets unless a structured format is genuinely needed.

## Commit and push discipline

Separate approvals for `git commit` and `git push`. Never chain the two. The user will say "commit" and, after reviewing the result, will separately say "push".

## End-of-session housekeeping

Before typing /clear to end a session, run `git checkout -- docs/` to discard any locally-modified pipeline outputs (there is no root `data/` directory in this repository). These files are regenerated by the build pipeline and are owned by the scheduled workflow; leaving them as dirty working-tree state carries forward to the next session and blocks `git pull --rebase` on the next start-of-session ritual. This is a one-line fix to a recurring friction pattern — skipping it means the next session begins with 30 seconds of stash/rebase/pop recovery instead of clean pull.

## Verification gates for visual changes

Before rebuilding the dashboard, audit the diff against the previous build. After rebuilding, verify visually in a local static server. Cross-browser check in Chrome and Edge before committing. If the change affects the live dashboard, watch the Actions run complete and smoke-test the live URL before considering the session done.

## Related repository

`C:\dev\equity-defense-dashboard` is architectural reference only. Never modify files there from a PCC session. Read-only inspiration.
