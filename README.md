# git-identity

Per-project GitHub account and git identity profiles for Claude Code.

Bind a project to a profile once. From then on every `gh` call, every `gh-axi`
call and every commit in that project uses the right account - because the
binding is environment variables, not a note in a prompt that a subagent can
miss.

## The problem

`gh` keeps one active account globally. In a personal project, `gh pr create`
goes out as your work account. `gh auth switch` does not fix it: it breaks the
other direction and races with every other terminal and session you have open.

There is usually a second half to this that goes unnoticed. `~/.gitconfig` holds
one email, and most repositories never override it - so personal commits are
signed with a work address, quietly, for years.

## Installation

1. Add the marketplace:

   ```
   /plugin marketplace add broneq/bdk
   ```

2. Install:

   ```
   /plugin install git-identity@bdk
   ```

## Usage

Create a profile once per account:

```
/git-identity:profile-add private
```

It walks you through `gh auth login` for a separate config directory, sets up the
git credential helper for it, and records the commit identity you want.

Then bind a project to it:

```
/git-identity:use private
```

Restart Claude Code, and check:

```
/git-identity:status
```

## Skills

| Skill | What it does |
|---|---|
| `/git-identity:profile-add <name>` | Create a profile: a GitHub account plus a commit identity under one name |
| `/git-identity:use <name>` | Bind the current project to a profile |
| `/git-identity:status` | Show the account and identity in effect, and flag disagreements |

All three are user-invocable only. Nothing here runs on its own in the middle of
another task.

## How it works

A profile is a name for two paths:

```
~/.config/gh-private                              gh's config directory
~/.config/git-identity/private.gitconfig           git identity, with [include] of your ~/.gitconfig
```

Binding a project writes them into `.claude/settings.local.json`:

```json
{
  "env": {
    "GH_CONFIG_DIR": "/Users/you/.config/gh-private",
    "GIT_CONFIG_GLOBAL": "/Users/you/.config/git-identity/private.gitconfig"
  }
}
```

Claude Code applies an `env` block to every session and every subprocess it
spawns. `gh` reads `GH_CONFIG_DIR`, git reads `GIT_CONFIG_GLOBAL`, and tools that
shell out to `gh` inherit both. Nothing has to be remembered, and nothing global
is modified - your plain terminal and your other projects are untouched.

Both accounts stay logged in at the same time, in separate config directories.
There is no switching.

The profile's gitconfig starts with `[include] path = ~/.gitconfig`, so your
normal settings stay in force and only the identity is overridden. That also
means `git config user.email` reports the truth, rather than showing one address
while commits carry another.

## Limitations

- **Restart after binding.** Changes to an `env` block do not reliably reach a
  running session. `/git-identity:use` says so, and the `SessionStart` hook warns
  when a binding exists but has not taken effect.
- **Inside Claude Code only.** A `git commit` you run in a plain terminal still
  uses your global identity. If that starts to matter, `includeIf` in
  `~/.gitconfig` is the native complement.
- **Workspace trust.** `env` values apply once you have trusted the folder.
- **One profile per session.** A session spanning two projects on different
  profiles gets one environment, so one of them will be wrong.
- **Without Node the hook stays silent.** Everything else works; you lose the
  status line at session start.

## Development

```
pnpm install
pnpm run verify      # biome + tsc --checkJs + node --test
```

Test the plugin locally without publishing:

```
claude --plugin-dir ~/projects/git-identity
```

Design decisions, with the measurements behind them, are in
[`docs/decisions/0001-runtime-and-stack.md`](docs/decisions/0001-runtime-and-stack.md).

## License

MIT
