# SAT Generator

Local-first SAT practice app with EQB sync, filtered practice sessions, full-length tests, score reports, and export support.

## What This Project Is

This repo ships two related experiences:

1. A full local application backed by Node.js and SQLite for EQB sync, question storage, practice sessions, full tests, scoring, and exports.
2. A static GitHub Pages demo built from bundled data so the app can be previewed without the local backend.

The local app is the production workflow. The static demo is a shareable preview.

## Core Features

- Sync questions from the College Board Educator Question Bank
- Cache question content, metadata, assets, and state standards locally
- Build filtered practice sets by assessment, section, domain, skill, difficulty, and state standards
- Build full-length SAT tests with staged module flow
- Track which questions have been seen before
- Grade attempts and generate data-driven score reports
- Use the built-in Desmos calculator and SAT reference sheet
- Export sets and reports as JSON, CSV, and PDF
- Run offline after sync completes

## Quick Start

Install dependencies, then launch the local app:

```powershell
npm install
.\run-local.ps1
```

That script:

- starts the local server
- syncs EQB before opening the browser
- reuses the existing port if possible
- opens `http://localhost:8787`

Useful launch variants:

```powershell
.\run-local.ps1 -NoBrowser
.\run-local.ps1 -NoSync
.\run-local.ps1 -Share
```

## How To Use

1. Open the app.
2. Sync the EQB if the local cache is empty or stale.
3. Choose `Practice` for a filtered session or `Full Test` for a full SAT-length attempt.
4. Adjust only the filters that matter for the session you want.
5. Click the primary action button to generate the session.
6. Answer questions, navigate forward/back, and submit when finished.

## Syncing The EQB

The local app can import EQB content directly from your authenticated College Board session.

1. Sign in to the [College Board Educator Question Bank](https://satsuiteeducatorquestionbank.collegeboard.org).
2. Copy the session cookie from your browser.
3. Click `Sync EQB` in the app and paste the cookie when prompted.
4. Wait for the sync to finish. Questions, metadata, assets, and state standards are cached locally in SQLite.

If you already have a populated local database, the app can work offline from that cache.

## Full Tests

Full tests are generated as a staged SAT flow:

- Reading and Writing Module 1
- Reading and Writing Module 2
- Break
- Math Module 1
- Math Module 2

The results page is computed from the submitted `testAttempt` state, including:

- totals
- correct and incorrect counts
- raw score
- estimated scaled score
- domain performance
- difficulty performance
- question-by-question review

## Data And Storage

The app stores its operational data locally:

- SQLite question cache
- downloaded assets
- sync checkpoints and run history
- generated sets and attempt metadata

The static demo uses `data/demo-data.json`, which is generated from the synced local database.

## Production Build

Build the GitHub Pages bundle with:

```powershell
npm run build
```

The build outputs a versioned static site in `dist/` and rewrites asset references with a build ID so browser caching stays predictable.

To refresh the demo data before building:

```powershell
node scripts/export-demo-data.cjs
npm run build
```

## Scripts

| Script | Description |
| --- | --- |
| `npm start` | Start the local Node server |
| `npm run dev` | Same as `start` |
| `npm run sync` | Start the server and run an EQB sync |
| `npm run build` | Build the static Pages bundle in `dist/` |
| `npm run export-demo` | Regenerate `data/demo-data.json` from the local cache |
| `npm run check` | Syntax-check the main server/build scripts |
| `npm run share` | Start the local server on `0.0.0.0` for LAN access |

## Repository Layout

- `server/` - Node server, sync pipeline, local API, and storage layer
- `public/` - Front-end app shell and UI code
- `data/` - Local cache, demo bundle, score tables, and exported assets
- `scripts/` - Build, export, and launcher utilities
- `dist/` - Production static build output

## Browser Demo

The GitHub Pages site is a static demo. It is useful for previewing the UI and the generated sample data, but it does not replace the local Node app.

## Troubleshooting

- If the app opens to an empty session, run a sync first.
- If a full test has no available questions for the selected filters, relax the section or assessment selection.
- If the browser seems to hold stale assets, run `npm run build` again and refresh without cached data.
- If you want the local app available on your network, use `.\run-local.ps1 -Share`.

## License

No license is currently declared in this repository.
