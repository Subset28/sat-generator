# SAT Generator

Local EQB-backed SAT practice generator with a single-process local server, SQLite-compatible persistence, randomized set generation, and export support.

## Run

Open the project and start the server:

```powershell
node server/index.cjs
```

Then open `http://localhost:8787`.

## Production Build

Create a static production bundle:

```powershell
npm run build
```

To preview the Pages build locally, start the server with `SAT_SERVE_DIST=1`.

```powershell
$env:SAT_SERVE_DIST='1'
npm start
```

The full local EQB-backed app remains the default when `SAT_SERVE_DIST` is not set.

## GitHub Pages Demo

The repository also includes a static demo entrypoint for GitHub Pages at the repository root. It uses bundled demo content and does not require the local server.

The full local app is still the main build for sync, exports, and EQB-backed data.
