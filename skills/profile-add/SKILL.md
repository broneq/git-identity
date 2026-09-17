---
name: profile-add
description: Create a git-identity profile - a named pairing of a GitHub account and a git commit identity. Run once per account, then bind projects to it with /git-identity:use.
argument-hint: "<profile-name>"
disable-model-invocation: true
allowed-tools: Read Write Edit Bash AskUserQuestion
---

# Add a profile

A profile is a name that ties together one GitHub account and one git commit
identity. Creating it is a one-off: afterwards `/git-identity:use <name>` binds
any project to it in seconds.

This skill does not log you in. Browser OAuth is yours to complete, so every
step that needs it prints a command for you to run with the `!` prefix.

## Paths

| What | Where |
|---|---|
| Registry | `${XDG_CONFIG_HOME:-~/.config}/git-identity/profiles.json` |
| gh config for a profile | `${XDG_CONFIG_HOME:-~/.config}/gh-<name>` |
| git identity for a profile | `${XDG_CONFIG_HOME:-~/.config}/git-identity/<name>.gitconfig` |

Resolve `XDG_CONFIG_HOME` once at the start and use absolute paths from then on.

## Workflow

### 1. Settle the name

Take it from `$ARGUMENTS`. If it is missing, ask for one. Use short, lowercase,
filesystem-safe names: `work`, `private`, `client-acme`.

Read the registry. If it does not exist yet, treat it as `{"version": 1, "profiles": {}}`.
If the name is already there, show the existing entry and ask whether to
overwrite it or pick a different name. Never silently replace one.

### 2. Decide the gh config directory

The convention is `<config>/gh-<name>`. The one exception is a profile that
should reuse the account you are already logged into: for that, point
`ghConfigDir` at the plain `<config>/gh` directory and skip step 3.

Use `GH_CONFIG_DIR=<dir> gh auth status` to check whether the directory already
holds a login. If it does, note which account and skip step 3.

### 3. Have the user log in

Print these two commands and ask the user to run them. Both matter:

```
! GH_CONFIG_DIR=<dir> gh auth login
! GH_CONFIG_DIR=<dir> gh auth setup-git
```

The second one is not optional. The system git config on macOS sets
`credential.helper = osxkeychain` globally, which caches whichever token it saw
first for github.com and hands it to every profile afterwards. `gh auth setup-git`
writes a per-host helper entry that resets that list, so HTTPS remotes follow
`GH_CONFIG_DIR` like everything else. Skipping it produces a profile that looks
correct and pushes as the wrong account.

Wait for the user to confirm, then verify:

```
GH_CONFIG_DIR=<dir> gh auth status
GH_CONFIG_DIR=<dir> gh api user --jq .login
```

Do not continue until the login reported is the account the user expects. If it
is not, say which account it actually is and stop.

### 4. Settle the git identity

Offer the GitHub noreply address as the default, built from the login you just
read: `<login>@users.noreply.github.com`. It keeps a private address out of
public history and GitHub still attributes the commits.

Ask for the display name too, defaulting to whatever `git config --global user.name`
returns.

### 5. Write the profile gitconfig

Write `<config>/git-identity/<name>.gitconfig`:

```gitconfig
[include]
	path = <absolute path to the user's ~/.gitconfig>
[user]
	name = <name>
	email = <email>
```

The `[include]` line comes first on purpose. Everything from the user's normal
global config - `core.autocrlf`, aliases, editor - stays in effect, and only the
identity below it wins. Without that line `GIT_CONFIG_GLOBAL` would replace the
global config outright and quietly drop every other setting.

**Write it atomically.** Other sessions may be reading this file while a git
command runs. Write to a temporary file in the same directory and rename it over
the target; a rename is atomic, a partial write is a parse error in someone
else's terminal.

```
! tmp=$(mktemp) && cat > "$tmp" <<'EOF'
<contents>
EOF
mv "$tmp" <config>/git-identity/<name>.gitconfig
```

Verify it resolves the way it should:

```
GIT_CONFIG_GLOBAL=<path> git config --global --includes --get user.email
GIT_CONFIG_GLOBAL=<path> git config --global --includes --get core.autocrlf
```

The first must return the new address. The second must return whatever the
user's global config had, proving the include works.

### 6. Record the profile

Read the registry **in full**, add or replace this one entry, and write the whole
object back. Never append or patch blindly - that file is the only record of
every other profile.

```json
{
  "version": 1,
  "profiles": {
    "<name>": {
      "ghConfigDir": "<absolute path>",
      "gitConfig": "<absolute path>",
      "login": "<github login, for display only>"
    }
  }
}
```

Create the directory first if it is missing. Write atomically, for the same
reason as step 5.

### 7. Report

State the profile name, the GitHub login, and the commit address, then point at
the next step: `/git-identity:use <name>` inside a project.
