# 0001 - Runtime, architecture and stack

- **Status:** accepted
- **Date:** 2026-09-17
- **Applies to:** git-identity and the Claude Code plugins that follow it in this
  ecosystem

## Context

The plugin binds a project to a GitHub account and a git identity. The technical
core of that is three jobs:

1. read and write a registry of profiles,
2. merge an `env` block into the user's `.claude/settings.local.json` without
   destroying their other keys,
3. a `SessionStart` hook that compares the state of the file against the state of
   the environment and reports the drift.

The question was what to write it in. The context shifted during the analysis -
git-identity stopped being a one-off tool and became the first piece of an
ecosystem with helper packages planned. That invalidated part of the earlier
reasoning and forced a second pass.

## Evidence

Every number here was measured or quoted, not estimated. Without them this
document would be a record of someone's preference.

### What the ecosystem does

GitHub code search, `hooks.json` files containing `CLAUDE_PLUGIN_ROOT`, over a
corpus of 15,744 files:

| Runtime | Occurrences | Share |
|---|---:|---:|
| bash / shell | 6,192 | ~39% |
| node | 3,672 | ~23% |
| python / python3 | 2,800 | ~18% |
| bun | 482 | ~3% |
| uv | 293 | ~2% |
| npx | 199 | ~1.3% |

The results overlap, so read them as a direction, not a partition. Anthropic's
own plugins (`skill-creator`, `frontend-design`, `serena`) have no hooks at all.
The documentation guarantees no runtime is present.

### Cost of an invocation, measured locally

The hook fires on every session start, so every ten milliseconds counts.

| Method | Time |
|---|---:|
| jq | 6 ms |
| /bin/sh | 10 ms |
| node script.mjs | 32 ms |
| python3 script.py (3.14) | 32 ms |
| /usr/bin/python3 (3.9.6) | 45 ms |
| npx -y, warm cache | 390-550 ms |
| npx -y, slow registry | 4,584 ms |
| **npx -y, no network** | **70,310 ms**, then an error |

`bun build --compile` on a script that reads a single JSON file: a **57 MB**
binary. Covering five platforms means roughly 285 MB in the repository, plus
notarization on macOS, without which Gatekeeper blocks the user's first run.

### Runtime availability

| Runtime | macOS | Linux | Windows | Speaks JSON |
|---|---|---|---|---|
| bash / sh | present | present | only with Git for Windows | no |
| jq | `/usr/bin/jq` | must be installed | must be installed | yes |
| python3 | Xcode CLT | in practice always | must be installed | stdlib |
| node | must be installed | must be installed | must be installed | natively |

On Windows bash is not a safe bet: Git for Windows is optional, and without it
Claude Code uses PowerShell.

### Does Claude Code imply Node

No. The recommended install is the native installer; there are also Homebrew,
WinGet, apt, dnf and apk. The npm path still exists, but the documentation says
of it:

> The npm package installs the same native binary as the standalone installer.
> (...) The installed `claude` binary does not itself invoke Node.

### Dependencies in plugins

Auto-install fires when the plugin root holds both a `package.json` **and** a
lockfile: `npm ci --ignore-scripts` or
`bun install --frozen-lockfile --ignore-scripts`, frozen, no lifecycle scripts,
60-second limit.

The npm documentation, on the default value of `--omit`:

> 'dev' if the `NODE_ENV` environment variable is set to 'production'; otherwise, **empty**

So `npm ci` installs `devDependencies` too. Without a way around that, the entire
development toolchain would land on the disk of every user of the plugin.

The Claude Code documentation on what a failure does:

> A failed or skipped install never blocks the plugin. (...)
> **A timed-out install can leave a partial `node_modules` tree in the cached copy.**

And the opening we use:

> Claude Code **skips `yarn.lock` and `pnpm-lock.yaml`** because Yarn and pnpm
> support resolution-time configuration hooks that bypass `--ignore-scripts`.

No build step runs when a plugin is installed.

### Verifying the `env` mechanism on a live system

Before any code was written we checked that the foundation works at all - this
machine had not held a single `env` block across 16 settings files.

- `gh` under a substituted `GH_CONFIG_DIR` reported that it was not logged in -
  the mechanism works.
- `gh-axi` returned `AUTH_REQUIRED`, which confirms inheritance through
  `execFile` without an `env` option on a live process, not merely from reading
  the code.
- **`GIT_CONFIG_*` is not blocked.** The earlier assumption, based on reading
  sanitization strings out of the binary, turned out to be false.
- Propagation is non-deterministic: creating the file can take effect
  immediately, changing a value lands at least one tool call late, and removing
  one does not propagate within a session at all.

The `[include]` pattern was checked on two worktrees of the same repository at
once: each with its own `GIT_CONFIG_GLOBAL` reported its own identity, the
worktree without the variable fell back to `~/.gitconfig`, and `core.autocrlf`
survived from the global config. No writes to shared state.

## Decision

### Architecture: split along the dependency boundary

**The core has no runtime.** Skills do all the work with the model's own tools.
The precedent is first-party: the built-in `update-config` skill operates on the
same file, has `Read` as its only tool, and its instruction reads
"1. Decide 2. Read: Target file 3. Merge: Add to env object".

**The hook is a bonus.** It is the only file with code in it. Losing it costs one
line of a report and nothing else.

This split matters more than the choice of language. It makes the functionality
work for everyone regardless of what they have installed, and narrows the runtime
question to an add-on.

### Language: Node, plain ESM `.mjs`

For the hook alone this would be a coin toss - python3 and sh+jq win on
availability. The ecosystem context settled it: **npm is the only built-in
channel for shipping code between plugins**. For Python there is nothing; the
documentation points at bootstrapping `uv` from your own hook code, which means
building machinery.

Node also has the numbers on its side: 3,672 occurrences against 2,800 for
Python.

TypeScript is **not** the source in a plugin while there is no bundling step - no
build runs at install time, so `.ts` would mean committing artifacts. Types go in
JSDoc, checked with `tsc --checkJs --noEmit`.

### Git identity: `GIT_CONFIG_GLOBAL`, not `GIT_AUTHOR_*`

A profile gets its own gitconfig file with `[include] path = ~/.gitconfig` at the
top. It has one advantage over the `GIT_AUTHOR_*` variables, and it is a real
one: `git config user.email` reports the truth. With the variables that command
would show the old address even though commits go out under the new one -
misleading for a human and for any tool that reads configuration instead of
making a commit.

The price: the profile file is shared between sessions, so **writes must be
atomic** - temp file, then `rename`. With environment variables that problem
would not exist, because the values are frozen for the session.

Rejected: `git config --local user.email`. It is the one variant that genuinely
conflicts - local config is shared across every worktree of the repository and
visible to every session and to a bare terminal.

### Package manager: pnpm

It resolves the `devDependencies` dilemma with no machinery at all.
`pnpm-lock.yaml` gives reproducible CI, and Claude Code skips that lockfile **by
the vendor's design**, not through a loophole. The user installs nothing.

### Stack

| Area | Choice | Why |
|---|---|---|
| Types | `tsc --checkJs --noEmit` + JSDoc | the only tool that catches real errors here |
| Tests | `node --test` | built in, zero dependencies |
| Lint and format | Biome | one dependency instead of a dozen, both jobs at once |
| Versioning | release-please | same as in bdk, configuration already written |
| Node | `engines >=20`, `.nvmrc` | where `node --test` is stable |

Deliberately rejected: husky and lint-staged (CI is enough with a single source
file), commitlint (release-please enforces Conventional Commits), Vitest, a
bundler in phase one.

## Consequences

- The core functionality works for everyone, on every system, without installing
  anything.
- A user without Node loses one line of a report at session start. Nothing more.
- There is no unit test for the JSON merge. Explicit steps in `SKILL.md` replace
  it: read the file whole, show a diff before writing.
- The ecosystem has two languages - bdk stays in Python. That is accepted: bdk is
  self-sufficient, has its own CI, and does not have to consume these helpers.
- Writing the profile file must be atomic in every skill that touches it.

## Planned path: bundling instead of shipping

When the first shared dependency appears we do **not** turn on auto-install via
`npm ci`. CI bundles it into one self-contained file:

```
pnpm exec esbuild src/session-start.ts --bundle \
  --platform=node --format=esm --outfile=hooks/session-start.mjs
git diff --exit-code hooks/session-start.mjs
```

Bundling beats shipping on every axis: the user installs nothing and never will,
it works offline and against a dead registry, and the 60-second limit and the
risk of a partial `node_modules` both disappear. "No imports outside `node:`"
stops being a promise policed in review and becomes a property of the artifact's
shape - you cannot break something that physically is not there.

The cost: plugins are consumed straight from git, so the bundled file has to be
committed. Drift from the source is caught mechanically by `git diff
--exit-code` in CI rather than watched for in review. What remains is noise in
diffs and one more development dependency.

A side effect: at that point **TypeScript comes back as the source**, because the
build happens on CI and not at install time.

## What would invalidate this

- **Anthropic adds auto-install for Python dependencies** (say, `uv sync
  --frozen` with a `uv.lock`). Python wins immediately then: available by
  default, consistent with bdk, and the same distribution channel. Worth watching
  the Claude Code changelog.
- **The helpers are to be consumed by bdk.** Then bdk dictates the language.
- **After two or three plugins it turns out there are no shared helpers.**
  python3, stdlib only, would then be simpler. The risk is acceptable - the cost
  of Node without helpers is one more `package.json`, not an architecture to
  unwind.
- **Windows becomes a first-class platform.** Then it is worth adding a `.cmd`
  wrapper in the style of Superpowers, which looks for Git Bash on Windows and
  exits quietly when it cannot find one.

---

## Rules for Claude Code plugins

This section is written impersonally and deliberately detached from
git-identity. For the next plugin, copy it whole without rewriting the reasoning
above.

### Runtime and hooks

1. **A hook imports nothing outside `node:`.** Installing dependencies can fail
   or exceed 60 seconds and leave a partial `node_modules`, so code from that
   directory may simply not exist at runtime.
2. **A missing runtime ends the hook in silent success.** The invocation in
   `hooks.json` is guarded by the pattern
   `command -v <runtime> >/dev/null 2>&1 && <runtime> ... || true`. A missing
   bonus feature never breaks someone else's session.
3. **No `npx` in hooks.** 0.4 s on a good network, 70 seconds of hanging without
   one, on every session start.
4. **A hook reads `cwd` from the payload on stdin**, not from `process.cwd()`.
   The hook process does not have to start in the project directory. Always read
   stdin, even when the payload is not needed - otherwise the caller can block on
   a full pipe.
5. **A hook stays silent when it has nothing to say.** A broken configuration
   file is no reason to litter every session.

### Dependencies and building

6. **While a plugin has no runtime dependencies - pnpm.** Reproducible CI, and
   Claude Code skips `pnpm-lock.yaml` by design, so the user never pulls down a
   development toolchain. `npm ci` installs `devDependencies`.
7. **Runtime dependencies are bundled on CI**, not shipped through auto-install.
   The bundled artifact is committed, and `git diff --exit-code` in CI enforces
   that it matches the source.
8. **TypeScript as the source only once a bundling step exists.** No build runs
   when a plugin is installed.

### Architecture

9. **The core functionality has no runtime.** Logic that operates on
   configuration files belongs in `SKILL.md`, not in a script. The pattern: the
   built-in `update-config`.
10. **A skill that modifies someone else's file reads it whole and shows a diff
    before writing.** This replaces the unit test that does not exist at this
    layer.
11. **Writes to a file shared between sessions are atomic** - temp file, then
    `rename`.
12. **Never write to the shared `.claude/settings.json` or to the project's
    `.gitignore`.** The binding goes to `settings.local.json`, and a local
    exclusion to `.git/info/exclude`.
13. **A plugin assumes no other plugin.** The marketplace entry schema has no
    dependency field, so "B requires A" can be neither expressed nor checked.

### Portability

14. **`SKILL.md` and plain scripts port between ecosystems. Hooks and manifests
    do not.** Every ecosystem has its own event names and its own structure. The
    less logic in the hook, the cheaper the port.

### Verification

15. **A platform mechanism is checked on a live system before the code that
    stands on it is written.** A smoke test with a positive and a negative
    control costs five minutes and settles what the documentation does not say
    outright.
16. **A verification tool is checked with a negative control.** A typecheck or a
    linter that passes because it checks nothing is worse than not having one.
