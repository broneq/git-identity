#!/usr/bin/env node
/**
 * SessionStart hook: report which git-identity profile this project is bound to.
 *
 * Contract:
 *   - No binding in this project -> print nothing, exit 0.
 *   - Binding active            -> one line naming the profile and identity.
 *   - Binding present but stale -> one line warning that a restart is needed.
 *
 * This file must never import anything outside `node:`. Claude Code installs a
 * plugin's dependencies with a 60-second budget and a timed-out install leaves a
 * partial node_modules tree behind, so anything from there may simply not exist
 * at runtime. Keeping the import list to builtins makes that failure impossible
 * rather than merely unlikely.
 *
 * See docs/decisions/0001-runtime-i-stack.md.
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

const TAG = "[git-identity]";

/**
 * @typedef {object} Binding
 * @property {string} ghConfigDir   Value of GH_CONFIG_DIR the project is bound to.
 * @property {string} [gitConfig]   Value of GIT_CONFIG_GLOBAL, when the profile sets one.
 */

/**
 * Read everything the hook receives on stdin.
 *
 * Claude Code passes a JSON payload describing the session. Reading it is part
 * of the hook protocol even when only one field is needed, and a hook that
 * leaves stdin unread can make the caller block on a full pipe.
 *
 * @returns {string} Raw stdin, or an empty string when it cannot be read.
 */
function readStdin() {
  // A terminal on fd 0 means nobody is piping a payload in, and reading it would
  // block until the user typed something. Only Claude Code's own invocation is
  // worth waiting on.
  if (process.stdin.isTTY) return "";
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * Work out which directory the session is rooted at.
 *
 * The payload's `cwd` is authoritative: a hook process does not necessarily
 * start in the project directory, so `process.cwd()` is not a safe substitute.
 *
 * @param {string} rawStdin
 * @returns {string | null} Absolute project directory, or null when unknown.
 */
export function projectDirFromPayload(rawStdin) {
  if (!rawStdin.trim()) return null;
  try {
    const payload = JSON.parse(rawStdin);
    const cwd = payload?.cwd;
    return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
  } catch {
    return null;
  }
}

/**
 * Read the project's binding out of .claude/settings.local.json.
 *
 * Any failure means "no binding": an unreadable or malformed settings file is
 * not this hook's problem to report, and staying silent keeps a broken file
 * from adding noise to every single session.
 *
 * @param {string} projectDir
 * @returns {Binding | null}
 */
export function readBinding(projectDir) {
  let raw;
  try {
    raw = readFileSync(join(projectDir, ".claude", "settings.local.json"), "utf8");
  } catch {
    return null;
  }

  let env;
  try {
    env = JSON.parse(raw)?.env;
  } catch {
    return null;
  }

  const ghConfigDir = env?.GH_CONFIG_DIR;
  if (typeof ghConfigDir !== "string" || ghConfigDir.length === 0) return null;

  const gitConfig = env?.GIT_CONFIG_GLOBAL;
  return {
    ghConfigDir,
    ...(typeof gitConfig === "string" && gitConfig.length > 0 ? { gitConfig } : {}),
  };
}

/**
 * Turn a profile's gh config directory into the profile name.
 *
 * The naming convention is `<something>/gh-<profile>`, with a bare `gh` meaning
 * the default profile. Anything else is reported as-is rather than guessed at.
 *
 * @param {string} ghConfigDir
 * @returns {string}
 */
export function profileNameFrom(ghConfigDir) {
  const name = basename(ghConfigDir.replace(/\/+$/, ""));
  if (name === "gh") return "default";
  return name.startsWith("gh-") ? name.slice(3) : name;
}

/**
 * Decide what the hook should print.
 *
 * Kept free of I/O so the decision table can be tested directly.
 *
 * @param {Binding | null} binding
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null} Line to print, or null to stay silent.
 */
export function buildMessage(binding, env) {
  if (!binding) return null;

  const profile = profileNameFrom(binding.ghConfigDir);

  if (env.GH_CONFIG_DIR !== binding.ghConfigDir) {
    return `${TAG} profile "${profile}" is bound but not active - restart Claude Code to apply it`;
  }

  if (binding.gitConfig && env.GIT_CONFIG_GLOBAL !== binding.gitConfig) {
    return `${TAG} profile "${profile}" is active for gh but its git identity is not - restart Claude Code to apply it`;
  }

  return `${TAG} profile: ${profile}`;
}

function main() {
  const projectDir = projectDirFromPayload(readStdin());
  if (!projectDir) return;

  const message = buildMessage(readBinding(projectDir), process.env);
  if (message) console.log(message);
}

// Only run when executed directly, so the test file can import the pure helpers.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
