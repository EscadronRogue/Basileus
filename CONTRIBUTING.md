# Contributing to Basileus

Thanks for thinking about contributing. A few light conventions to keep the
project readable.

## Branches

`main` is the only branch that's deployed. Open PRs from feature branches
against `main`.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/). The CI
prefix is already used by Dependabot:

| Prefix     | When to use it                                              |
| ---------- | ----------------------------------------------------------- |
| `feat:`    | A new user-visible feature                                  |
| `fix:`     | A bug fix                                                   |
| `refactor:`| Internal change with no behaviour change                    |
| `perf:`    | Performance improvement                                     |
| `docs:`    | Documentation only                                          |
| `test:`    | Tests only                                                  |
| `chore:`   | Tooling, build, repository hygiene                          |
| `ci:`      | GitHub Actions / Dependabot only (Dependabot uses this)     |
| `deps:`    | Dependency bumps (Dependabot uses this)                     |

Each commit message should describe the **change**, not the **mood at the
time**. `fix: prevent double-submit on order lock` is reviewable a year
later; `fixfix` or `hope` is not.

## Code

- Node `>=22.4` (see `engines` in `package.json`).
- No runtime npm dependencies. Browser code is plain ES modules; the server
  uses Node built-ins only. Playwright is the only (dev) dependency, used by
  the browser smoke tests. Add dependencies only with a strong reason and
  bump the lockfile.
- Keep the layers apart: `engine/` imports only `data/` and itself, `ai/`
  never imports `ui/` or `render/`, and browser code never imports `node:`
  modules. `scripts/layering.test.js` enforces this.
- The rules text lives in `ui/rules.js`. After editing it, run
  `npm run build:rules-doc`; after editing `assets/*.svg`, run
  `npm run build:svg-fallback`. Tests fail when either generated file is
  stale.
- Engine modules under `engine/` must stay deterministic. Use `state.rng`,
  never `Math.random()`, for any value that affects gameplay. Read it through
  `requireRng(state)` from `engine/state.js`, which throws when the seeded
  RNG is missing instead of silently falling back to `Math.random()`.

## Tests

```
npm test
```

runs the full unit suite without a browser. The real-browser smoke tests
need Chromium once (`npx playwright install chromium`), then:

```
npm run test:browser
```

Add tests next to the code they cover (`engine/*.test.js`, `ai/*.test.js`,
`game/*.test.js`, `ui/*.test.js`, `multiplayer/*.test.js`), repository-wide
checks under `scripts/`, and user flows under `e2e/`. CI runs both suites on
every pull request, and the Pages deploy only ships commits whose unit suite
passes.

## Security

See `SECURITY.md` for the disclosure process.
