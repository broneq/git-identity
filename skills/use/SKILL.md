---
name: use
description: Bind the current project to a git-identity profile, so every gh call and every commit in it uses that GitHub account and identity.
argument-hint: "<profile-name>"
disable-model-invocation: true
allowed-tools: Read Write Edit Bash AskUserQuestion
---

# Bind this project to a profile

Writes an `env` block into the project's `.claude/settings.local.json`. Claude
Code applies that block to every session and every subprocess it spawns, so
`gh`, `gh-axi` and `git` all follow it without anyone having to remember
anything.

## Workflow

### 1. Resolve the profile

Read `${XDG_CONFIG_HOME:-~/.config}/git-identity/profiles.json`. If it is missing
or empty, say so and point at `/git-identity:profile-add`.

Take the name from `$ARGUMENTS`. If it is missing, list the profiles with their
logins and ask which one.

Check the profile still works before writing anything:

- `<ghConfigDir>/hosts.yml` exists. If not, the profile was never logged in or
  was logged out - say so and stop rather than binding a dead profile.
- `GH_CONFIG_DIR=<ghConfigDir> gh api user --jq .login` returns the login the
  registry recorded. If it differs, report both and ask before continuing.

### 2. Read the settings file in full

Read `<project>/.claude/settings.local.json` completely. If it does not exist,
treat it as `{}`.

Read it **whole, every time**. This file is the user's own: it may hold
`permissions`, `hooks`, `enabledPlugins`, anything. This skill owns exactly five
keys inside `env` and must leave every other byte of that file alone. There is no
test suite standing behind this step - reading before writing is what replaces
one.

### 3. Build the merged result

Set these inside `env`, leaving any other `env` keys untouched:

| Key | Value |
|---|---|
| `GH_CONFIG_DIR` | profile's `ghConfigDir` |
| `GIT_CONFIG_GLOBAL` | profile's `gitConfig` |

Absolute paths, no `~`. Neither `gh` nor `git` expands a tilde from an
environment variable.

If the project is already bound to a different profile, say which one it is
leaving and which it is joining.

### 4. Show the diff, then write

Show the user exactly what changes - the `env` block before and after. Then
write the merged object back.

Create `<project>/.claude/` if needed.

### 5. Keep it out of the repository

`settings.local.json` holds absolute paths from this machine's home directory, so
it must not reach a shared repository.

```
git check-ignore -q .claude/settings.local.json
```

If that fails, the file is not ignored. Add it to `.git/info/exclude`, **not** to
the project's `.gitignore`: `.gitignore` is committed and shared with everyone
else on the project, while `.git/info/exclude` is local to this clone. Do not
touch a `.gitignore` that is already tracked.

### 6. Tell the user to restart

Say this plainly, because it is the one thing that makes the feature look broken:

> The profile is bound. **Restart Claude Code for it to take effect.**

Changes to an `env` block do not reliably reach a session that is already
running. A newly created settings file sometimes applies immediately, a changed
value usually does not, and a removed one never does. Restarting is the only
behaviour worth relying on.

Then verify - after the restart, in a new session:

```
gh api user --jq .login
git config user.email
```

If the plugin's `SessionStart` hook is active it reports the same thing on its
own, and warns when a binding exists but has not reached the environment yet.
