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

- Node `>=22.4` (see `engines` in `package.json`). The multiplayer verifier
  needs the global `WebSocket`.
- No runtime npm dependencies. Browser code is plain ES modules; the server
  uses Node built-ins only. Add dependencies only with a strong reason and
  bump the lockfile.
- Engine modules under `engine/` must stay deterministic. Use `state.rng`,
  never `Math.random()`, for any value that affects gameplay. The
  `engine/actions.js` bishop-displacement path will throw if `state.rng` is
  missing — preserve that guarantee in new code.

## Tests

```
npm test
```

runs the full suite. Add tests under the matching directory (`engine/*.test.js`,
`ai/*.test.js`, `ui/*.test.js`, `multiplayer/verify.js`) for new behaviour.

## Security

See `SECURITY.md` for the disclosure process.
