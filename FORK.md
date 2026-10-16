# Fork notes

`trazyn/oh-my-pi` is a personal fork of [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi).
Fork-local changes are kept as separate commits **on top of upstream `main`** and must survive
every upstream update. Read this file before rebasing, merging, or resetting the branch, and
keep it current when making further fork-local changes.

- Upstream base of the current fork commits — update this line after every rebase:
  `714a63689bb4551e59dd27efba2e894d31aec86e` (upstream v18.11.2).
- Fork commits on top of that base, oldest first (short hashes as of that base):
  1. `30eb94a1da` — `fix(catalog,ai): pass the OpenCode Zen/Go free-tier gate with the decoded client identity`
  2. `52ac26ab51` — `docs(catalog,ai): record the OpenCode free-tier gate contract and regression guards`
  3. `ba9af0a219` — `ci(workflows): built macos binaries natively on hosted macs` (file later renamed)
  4. `81958bfe7c` — `ci(workflows): published binaries to a rolling amp-latest release for curl installs`

## 1. OpenCode Zen/Go free-tier gate fix

Upstream's OpenCode Zen/Go free tiers reject requests that do not carry the decoded client
session identity; this fork implements the gate — a time-encoded session token plus a
read-only tool pad, threaded through the provider plumbing.

- `packages/catalog/src/wire/opencode.ts` — the single source of truth (token encoding, request pad).
- `packages/catalog/src/provider-models/openai-compat.ts` — applies the gate headers on discovery/requests.
- `packages/ai/src/utils/opencode-gate.ts` — gate funnel/decision helpers.
- `packages/ai/src/providers/inference-headers.ts` — header application.
- Also touched: `packages/ai/src/auth-retry.ts`, `packages/ai/src/error/auth-classify.ts`,
  `packages/ai/src/error/flags.ts`, `packages/ai/src/error/format.ts`,
  `packages/ai/src/providers/google-shared.ts`, `packages/ai/src/stream.ts`,
  `packages/ai/src/usage/opencode-go.ts`, `packages/catalog/src/index.ts`,
  `packages/utils/src/ptree.ts`, and both package `CHANGELOG.md`s.
- Docs: `docs/opencode-free-tier-gate.md` (contract), cross-linked from `docs/provider-quirks.md`.

Regression guards — keep green after every upstream update:

```sh
bun test packages/ai/test/opencode-free-tier-gate.test.ts \
  packages/ai/test/opencode-session-header.test.ts \
  packages/ai/test/auth-retry.test.ts \
  packages/ai/test/opencode-go-usage.test.ts \
  packages/catalog/test/opencode-provider.test.ts
```

If upstream ever ships an equivalent fix, drop the corresponding fork commits during the
rebase, confirm the tests above still pass against upstream behavior, and update this file.

## 2. Fork binary distribution (`amp`)

Upstream's `omp.sh` binaries do not contain the gate fix, so the fork builds and publishes
its own:

- `.github/workflows/build-binaries.yml` — native macOS builds on GitHub-hosted runners
  (`macos-15` arm64, `macos-15-intel` x64), each smoke-tested (`--version`, `--smoke-test`)
  before upload (a short-lived Linux leg was removed; its asset is cleaned up by the next
  publish). Trigger: push a tag `v<version>-build.<n>`
  (e.g. `git tag v18.11.2-build.3 && git push origin v18.11.2-build.3`).
- Rolling GitHub Release **`amp-latest`** — macOS-only assets `amp-darwin-arm64`,
  `amp-darwin-x64`, `SHA256SUMS`. Workflow artifacts require a GitHub login to download;
  release assets do not, which is why the installer uses the release.
- `scripts/install-amp.sh` — the curl installer (macOS arm64/x64 incl. Rosetta detection;
  verifies `SHA256SUMS`; installs as `amp`, default `~/.local/bin`; on Linux it points at
  building from source):

  ```sh
  curl -fsSL https://raw.githubusercontent.com/trazyn/oh-my-pi/main/scripts/install-amp.sh | sh
  ```

- `README.md` — the Install section points at the fork installer; upstream's
  `curl -fsSL https://omp.sh/install | sh` block was replaced on purpose, including the note
  below it. On conflicts, keep the fork block.

## Updating from upstream

```sh
git fetch upstream
git rebase upstream/main        # fork commits replay on top; resolve conflicts, never --skip them
bun install --frozen-lockfile
bun check                       # typecheck
git push --force-with-lease origin main
```

- NEVER `git reset --hard upstream/main` (or `git checkout upstream/main -- .`) followed by a
  force-push: that silently deletes every change listed above. If it happens, recover the
  commits from `git reflog` (and the reflog on any clone that fetched them) before GC.
- Recurring conflict candidates: `README.md` (keep the fork install block), `AGENTS.md`
  (keep the Fork Notes section), `packages/{ai,catalog}/CHANGELOG.md` (keep fork entries).
- After a rebase that changes shipped behavior, re-trigger a build with a fresh
  `v<version>-build.<n>` tag so `amp-latest` keeps serving the newest binary.

## Local machine (not tracked by git)

- `~/.bun/bin/amp` is a symlink to `packages/coding-agent/dist/amp`. After a local rebuild —
  `bun --cwd=packages/natives run build` when the native addon stamp changed, then
  `bun --cwd=packages/coding-agent run build` — the fresh binary lands at
  `packages/coding-agent/dist/omp` (or `dist/omp-<target>` when `CROSS_TARGET` is set);
  rename/copy it to `dist/amp` to keep the symlink working.
- `~/.omp/agent/config.yml` — small-model slot pinned to `opencode-zen/deepseek-v4.1-flash-free:auto`.
