# git-identity

Claude Code plugin binding a project to a GitHub account and git identity.
Rationale and measurements: `docs/decisions/0001-runtime-i-stack.md`.

## Layout

```
.claude-plugin/plugin.json   manifest
skills/<name>/SKILL.md       all logic lives here, no runtime
hooks/session-start.mjs      the only code in the plugin
docs/decisions/              ADRs
```

## Rules

These are the ones whose violation fails silently. Everything else is in the ADR.

- **Never write to a shared file.** Binding goes to `.claude/settings.local.json`,
  local exclusion to `.git/info/exclude`. Not `settings.json`, not the project's
  `.gitignore` - both are committed and carry absolute paths off this machine.
- **A skill touching a user's file reads it whole and shows a diff first.**
  There is no test behind that layer; this is what replaces one.
- **Writes to files shared between sessions are atomic** - temp file, then rename.
  A profile gitconfig can be read by another session mid-write.
- **`hooks/session-start.mjs` imports nothing outside `node:`.** A timed-out
  dependency install leaves a partial `node_modules`, so that code may not exist
  at runtime.
- **The hook stays silent when it has nothing to say**, and its `hooks.json`
  invocation exits 0 when Node is missing.
- **No TypeScript as source** while there is no bundling step. Nothing builds at
  install time. Types go in JSDoc, checked by `tsc --checkJs`.
- **pnpm, not npm.** `npm ci` installs devDependencies onto every user's machine;
  Claude Code skips `pnpm-lock.yaml` by design.
- **This plugin assumes no other plugin.** The marketplace schema has no
  dependency field, so a missing prerequisite cannot be declared or detected.

## Commands

```
pnpm run verify     # biome + tsc + node --test
pnpm run format     # apply formatting

claude --plugin-dir ~/projects/git-identity    # load it locally
```

Use `pnpm run <script>` rather than `pnpm exec <tool>` - the latter adds process
layers that fall over under memory pressure.

## Conventions

Conventional Commits; release-please derives versions and syncs `$.version` in
`.claude-plugin/plugin.json`.

When changing anything that depends on plugin loader behaviour - layout, manifest
fields, hook events, frontmatter, `${CLAUDE_PLUGIN_ROOT}` - check
https://code.claude.com/docs/en/plugins-reference against the current spec first.
