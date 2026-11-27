# Contributing to Everport

Thanks for taking an interest. Bug reports, fixes and small improvements are welcome. For anything big, please open an issue first so we can agree on the direction before you spend time on it.

## Reporting a problem

- **Bug or question:** open an issue with the "Bug report" template. Include the output of `everport doctor` and `everport ls --health`, your operating system, and `everport --version`. Remove anything private first.
- **Security problem:** do **not** open a public issue. See [SECURITY.md](SECURITY.md).
- **Never paste** API tokens, the contents of `relay-secret`, or your Cloudflare login.

## Setting up

You need Node.js 22.12 or newer (the repository's `.nvmrc` says 24) and npm.

```bash
git clone https://github.com/ptduy14/everport.git
cd everport
npm install
npm run build
npm test
```

## How the code is laid out

This is an npm workspaces monorepo:

| Package           | What it holds                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/relay`  | The wire protocol, the shared relay core, and the Worker and Durable Object that run on Cloudflare                                              |
| `packages/core`   | The `Everport` class that the CLI and VS Code call, the code that deploys to Cloudflare through wrangler, the config store, and fakes for tests |
| `packages/agent`  | The background process, its control API, and the code that wires everything to the real world                                                   |
| `packages/cli`    | The `everport` command, and the npm package that is published                                                                                   |
| `packages/vscode` | The VS Code extension                                                                                                                           |

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the pieces fit together. The core never calls `child_process`, `fetch` or the file system directly: it goes through small interfaces ("ports") that tests replace with fakes. Please keep it that way.

## Everyday commands

```bash
npm run build          # build every package
npm test               # unit tests, no network, a few seconds
npm run typecheck      # tsc for every package
npm run lint           # eslint
npm run format         # prettier --write
```

Run all four of build, typecheck, test and lint before you open a pull request. CI runs them on Ubuntu and Windows.

## Tests that need more

Slower tests are kept apart so `npm test` stays fast and offline.

```bash
# The relay Worker in a local workerd (no account needed)
npm run test:e2e -- packages/agent/src/workerd.e2e.test.ts

# Real Cloudflare (needs YOUR account and a login; creates and removes Workers named ep-smoke-*)
EVERPORT_CLOUDFLARE=1 npm run test:e2e -- packages/agent/src/everport.e2e.test.ts

# The extension inside a real VS Code (downloads VS Code the first time)
npm run test:vscode -w everport-vscode
```

Tests that touch Cloudflare only ever use Worker names starting with `ep-smoke-` or `ep-poc-` and remove them afterwards. If one fails halfway, delete the leftover Worker with `wrangler delete --name <name> --force`. You do not need a Cloudflare account to work on most of the code: the unit tests use fakes.

## Making a change

- Branch from `main` and keep the change focused.
- Add or update tests for behaviour you change. A bug fix should come with a test that fails without it.
- Write code in TypeScript, formatted by Prettier (single quotes, 120 columns). Keep comments short and about the idea; do not narrate history.
- User-facing text is plain and says how to fix the problem, not only what went wrong.
- Commit messages follow Conventional Commits: `feat(core): ...`, `fix(agent): ...`, `docs: ...`, `test: ...`, `chore: ...`, `ci: ...`. Say what changed and why in the body.
- Do not commit secrets, `tunnels.json`, `relay-secret` or build output (`dist/`).
- Changes to `.github/workflows/` need a maintainer's review.

## Releasing (maintainers)

A release happens when `main` gets a version that has no tag yet. In the pull request that prepares it:

1. Set the same new version in `packages/cli/package.json` and `packages/vscode/package.json`, and in the two matching entries of `package-lock.json`.
2. Add a `## <version>` section to `packages/vscode/CHANGELOG.md`. Its text becomes the GitHub Release notes.

`node scripts/check-release.mjs` checks both. On the pull request, the release workflow runs the checks and a dry run that publishes nothing. After the merge it waits for a maintainer to approve the `release` environment. It then publishes the CLI to npm and the extension to the VS Code Marketplace and Open VSX, tags `v<version>` and creates the GitHub Release with the `.vsix`. Each step skips a registry that already has the version, so a failed run can be started again. Do not tag or publish a version by hand. A published version can never be replaced: fix forward with a new version.

## License

By contributing you agree that your contribution is released under the [MIT license](LICENSE).
