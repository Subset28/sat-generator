# SAT Practice

Digital SAT practice generator — 2,900+ real EQB questions, practice sets, full-length tests, score reports, and export support.

## Quick Start (Personal Use)

```powershell
.\run-local.ps1
```

Opens the app in your browser at `http://localhost:8787`.

## Share with Classmates (School Network)

Run with `--share` to make the app accessible to anyone on your WiFi:

```powershell
.\run-local.ps1 -Share
```

The console will print your local IP address, e.g.:

```
Share with classmates on your network: http://192.168.1.42:8787
```

Send that URL to anyone on the same network. They open it in their browser — no install needed.

## First-Time Setup (Sync Questions)

1. Log into the [College Board Educator Question Bank](https://satsuiteeducatorquestionbank.collegeboard.org)
2. Copy your session cookie
3. Click **Sync EQB** in the app and paste the cookie when prompted
4. Sync takes ~10 minutes; questions are cached locally in SQLite

## Rebuild Demo Data

After syncing, regenerate the bundled demo for GitHub Pages:

```powershell
node scripts/export-demo-data.cjs
npm run build
```

## Production Build (GitHub Pages)

```powershell
npm run build
```

Output goes to `dist/`. The static demo uses `data/demo-data.json` — run `export-demo-data.cjs` first so the bundle includes real questions.

## Features

- Practice sets filtered by section, domain, difficulty, or skill
- Full-length tests (54 RW + 44 Math) with realistic timing
- Score report with domain breakdown and estimated scaled score
- Desmos calculator and SAT reference sheet built in
- Export to PDF, CSV, or JSON
- Tracks which questions you have already seen
