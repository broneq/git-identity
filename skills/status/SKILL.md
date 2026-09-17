---
name: status
description: Show which GitHub account and git identity this project is actually using right now, and whether that matches what it is bound to.
disable-model-invocation: true
allowed-tools: Read Bash
---

# What account is this project on?

Reports three things and, more usefully, whether they agree: what the project is
**bound** to, what the environment is **actually** applying, and what `gh` and
`git` therefore do right now.

Read-only. It never changes a file.

## Workflow

### 1. Collect the facts

```
# What the project is bound to
cat <project>/.claude/settings.local.json

# What this session actually has
printenv GH_CONFIG_DIR
printenv GIT_CONFIG_GLOBAL

# What that produces in practice
gh api user --jq .login
git config user.email
git config user.name
git remote get-url origin
```

Also read the registry at `${XDG_CONFIG_HOME:-~/.config}/git-identity/profiles.json`
so the profile can be named rather than shown as a path.

### 2. Report

Keep it to a few lines. State the profile name, the GitHub login, the commit
address, and the origin remote.

### 3. Call out disagreements

These are the cases worth the skill existing, in order of how badly they bite:

**Bound but not applied.** `settings.local.json` names a profile, the
environment does not match it. The project looks configured and behaves as if it
were not. Almost always means `/git-identity:use` ran without a restart
afterwards. Say: restart Claude Code.

**Applied but not bound.** The environment carries a `GH_CONFIG_DIR` that no
settings file in this project asks for. Usually left over from an earlier
binding in the same session, since a removed `env` value does not leave a
running session. Say: restart Claude Code.

**Bound to a dead profile.** `<ghConfigDir>/hosts.yml` is missing, or
`gh api user` fails. The account was logged out or the token was revoked. Say:
rerun `/git-identity:profile-add <name>`.

**Owner mismatch.** The `origin` remote belongs to an owner that does not look
like it matches the active account - a personal account against a company
organisation, or the reverse. This one is a hint, not a verdict: plenty of
legitimate setups cross those lines. Mention it, do not act on it.

**No binding at all.** Say so, name the account the project falls back to, and
mention `/git-identity:use` for binding one. This is a normal state, not a
problem.
