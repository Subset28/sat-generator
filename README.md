# SAT Generator

Local EQB-backed SAT practice generator with a single-process local server, SQLite-compatible persistence, randomized set generation, and export support.

## Run

Open the project and start the server:

```powershell
node server/index.cjs
```

Then open `http://localhost:8787`.

## GitHub Pages Demo

The repository also includes a static demo entrypoint for GitHub Pages at the repository root. It uses bundled demo content and does not require the local server.

The full local app is still the main build for sync, exports, and EQB-backed data.
