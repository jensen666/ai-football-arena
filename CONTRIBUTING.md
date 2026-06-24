# Contributing

Thanks for taking a look at AI Football Arena.

## Setup

```bash
git clone <repo-url>
cd ai-football-arena
npm install
```

## Run

```bash
npm start
```

Open `http://127.0.0.1:3000` in a browser.

## Build

There is currently no compile or bundle step. The build script is a no-op check for CI and common tooling:

```bash
npm run build
```

## Test

```bash
npm test
```

Browser-flow checks are manual for now:

```bash
npm run test:e2e-note
```

## Pull Requests

- Keep changes focused and easy to review.
- Add or update tests when behavior changes.
- Do not commit local runtime files, generated match data, screenshots from `cache/`, or private planning documents.
- Do not commit API keys, tokens, or local machine paths.
