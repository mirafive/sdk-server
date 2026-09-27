# Contributing

Thanks for helping with the MIRA FIVE server SDK.

## Before you start

Small fixes (a bug, a typo, a missing test) can go straight to a pull request. For
anything that changes behavior or the public API, open an issue first so we can agree on
the approach before you write it. The public API of every SDK is defined in
[mirafive/protocol](https://github.com/mirafive/protocol) (API.md, PROTOCOL.md, FLAGS.md),
so an API change starts there.

## Setup

```sh
bun install --frozen-lockfile
bun run check
```

`check` runs format, lint, typecheck, tests, build, publint, attw and size-limit. CI runs the same, so a green `check` locally means a green PR.

## Rules

- `src/protocol/` is copied from [mirafive/protocol](https://github.com/mirafive/protocol).
  Never edit it here; change the protocol and run `bun run vendor:protocol`.
- Test fixtures come from mirafive/protocol unchanged, pinned by sha256. Never edit them.
- No new runtime dependencies without an issue that agrees on it.
- Bundle size is a feature. Every public entry point has a size-limit budget; a change
  that grows one says why in the PR.
- A secret key never reaches browser code.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>
```

- Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`, `revert`.
- The scope is optional and names the area, e.g. `flags`, `pageviews`, `cdn`.
- The description is lowercase, has no trailing period and says what changed:
  `fix: count property bytes as UTF-8, as the server now does`.
- A breaking change gets a `!`: `feat(flags)!: drop the v0 bootstrap format`.
- One logical change per commit.

## Pull requests

- PRs are squash-merged, so the PR title becomes the commit on `main` and must follow
  the commit format above. CI checks it.
- Keep a PR to one change. Say what changed and why; link the issue.
- Don't edit `CHANGELOG.md` or the version. The maintainer writes both when releasing.

## Security

Don't open a public issue for a vulnerability. Report it privately through
**Security → Report a vulnerability** on this repository.

## License

By contributing you agree that your contribution is licensed under the repository's
[MIT license](LICENSE).
