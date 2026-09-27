# Agents working in mirafive/sdk-server

`@mirafive/sdk-server`: events and feature flags from servers and edge runtimes (Node, Bun,
Deno, workerd). Part of the MIRA FIVE SDK family; the wire contract, flag semantics and
public API live in [mirafive/protocol](https://github.com/mirafive/protocol) (PROTOCOL.md,
FLAGS.md, API.md).

## Commands

```sh
bun install --frozen-lockfile
bun run check            # format, lint, typecheck, test, build, publint, attw, size-limit
bun run test             # vitest
bun run test:runtimes    # build, then smoke-test Node, Bun, Deno and workerd (Miniflare) against a local stub
bun run size             # size-limit against the limits in package.json
bun run golden           # rewrite test/golden/server.json after a wire change
bun run vendor:protocol  # refresh src/protocol from ../protocol (or MIRAFIVE_PROTOCOL)
```

## Layout

- `src/mira.ts`: `Mira` (buffer, split, retries, idempotency) and the shared `Core`.
- `src/flags.ts`: `MiraFlags` (document refresh, segments, exposures, bootstrap).
- `src/http.ts`, `src/error.ts`: the request helper and `MiraError`, shared by both
  entries (built into `dist/shared.js`).
- `test/golden/server.json`: the batch the Laravel app's SDK contract test ingests
  (`tests/Fixtures/sdk/sdk-server.json` there).

## Rules

- API.md is the contract for this package's public surface. Do not add, rename or
  remove exports without changing API.md first.
- `src/protocol/` is vendored. Never edit it; change mirafive/protocol and run
  `bun run vendor:protocol`. Which modules are vendored is listed in
  `package.json#mirafive.protocol`.
- Test fixtures in `test/fixtures/` come from mirafive/protocol, copied unchanged, their
  sha256 pinned in `test/protocol.test.ts`. Never edit them. Every batch a test emits is
  validated against `batch.schema.json`.
- Bundle size is the headline goal (min + gzip, shared chunk included; limits are measured
  + ~3 %, `./flags` capped at 4 kB), but robustness wins over bytes: reads never throw, errors reach
  `onError`. A change that grows an entry explains why. No runtime dependencies.
- WinterTC APIs only: no `node:` imports, no `process`, no DOM. `test:runtimes` proves it.
- Each feature is its own entry point; `sideEffects: false` must stay true.
- Transport failures never throw into the caller's code (API.md, shared rules).
- A secret key never reaches browser code; `new Mira()` refuses to run in a browser.
- Comments only for a non-obvious constraint, one or two lines.
- Do not run git write commands unless asked; the maintainer commits.

## Releasing

To release, bump `version` in `package.json` (and any SDK version constant), add a `## X.Y.Z — YYYY-MM-DD` section to `CHANGELOG.md`, commit, then `git tag vX.Y.Z && git push origin vX.Y.Z`. `.github/workflows/release.yml` checks both, runs `bun run check`, stages it on npm through trusted publishing (no token) and creates the GitHub release from the changelog section. The version goes live only after a maintainer approves it with 2FA on npmjs.com (`npm stage approve`). Never `npm publish` from a laptop.
