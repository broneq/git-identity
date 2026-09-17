import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  buildMessage,
  profileNameFrom,
  projectDirFromPayload,
  readBinding,
} from "./session-start.mjs";

/** @type {string[]} */
const tmpRoots = [];

/**
 * Create a throwaway project directory, optionally containing a settings file.
 *
 * @param {string} [settingsJson] Raw contents for .claude/settings.local.json.
 * @returns {string} Path to the project directory.
 */
function projectWith(settingsJson) {
  const root = mkdtempSync(join(tmpdir(), "git-identity-test-"));
  tmpRoots.push(root);
  if (settingsJson !== undefined) {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.local.json"), settingsJson);
  }
  return root;
}

after(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
});

describe("projectDirFromPayload", () => {
  it("takes cwd from the hook payload", () => {
    assert.equal(projectDirFromPayload('{"cwd":"/some/project"}'), "/some/project");
  });

  it("returns null for empty, malformed, or cwd-less payloads", () => {
    assert.equal(projectDirFromPayload(""), null);
    assert.equal(projectDirFromPayload("   "), null);
    assert.equal(projectDirFromPayload("not json"), null);
    assert.equal(projectDirFromPayload("{}"), null);
    assert.equal(projectDirFromPayload('{"cwd":""}'), null);
    assert.equal(projectDirFromPayload('{"cwd":42}'), null);
  });
});

describe("readBinding", () => {
  it("reads GH_CONFIG_DIR and GIT_CONFIG_GLOBAL", () => {
    const dir = projectWith(
      JSON.stringify({
        env: {
          GH_CONFIG_DIR: "/home/me/.config/gh-private",
          GIT_CONFIG_GLOBAL: "/home/me/.config/git-identity/private.gitconfig",
        },
      }),
    );
    assert.deepEqual(readBinding(dir), {
      ghConfigDir: "/home/me/.config/gh-private",
      gitConfig: "/home/me/.config/git-identity/private.gitconfig",
    });
  });

  it("omits gitConfig when the profile does not set one", () => {
    const dir = projectWith(JSON.stringify({ env: { GH_CONFIG_DIR: "/gh-private" } }));
    assert.deepEqual(readBinding(dir), { ghConfigDir: "/gh-private" });
  });

  it("treats a missing file as no binding", () => {
    assert.equal(readBinding(projectWith()), null);
  });

  it("treats malformed JSON as no binding rather than throwing", () => {
    assert.equal(readBinding(projectWith("{ not json")), null);
  });

  it("treats a settings file without our env keys as no binding", () => {
    assert.equal(readBinding(projectWith(JSON.stringify({ permissions: { allow: [] } }))), null);
    assert.equal(readBinding(projectWith(JSON.stringify({ env: {} }))), null);
    assert.equal(readBinding(projectWith(JSON.stringify({ env: { GH_CONFIG_DIR: "" } }))), null);
  });
});

describe("profileNameFrom", () => {
  it("strips the gh- prefix", () => {
    assert.equal(profileNameFrom("/home/me/.config/gh-private"), "private");
  });

  it("calls the plain gh directory the default profile", () => {
    assert.equal(profileNameFrom("/home/me/.config/gh"), "default");
  });

  it("tolerates a trailing slash", () => {
    assert.equal(profileNameFrom("/home/me/.config/gh-work/"), "work");
  });

  it("reports an unconventional directory as-is instead of guessing", () => {
    assert.equal(profileNameFrom("/home/me/elsewhere/custom"), "custom");
  });
});

describe("buildMessage", () => {
  const binding = {
    ghConfigDir: "/home/me/.config/gh-private",
    gitConfig: "/home/me/.config/git-identity/private.gitconfig",
  };

  it("stays silent when there is no binding", () => {
    assert.equal(buildMessage(null, {}), null);
  });

  it("reports the profile when the environment matches", () => {
    const message = buildMessage(binding, {
      GH_CONFIG_DIR: binding.ghConfigDir,
      GIT_CONFIG_GLOBAL: binding.gitConfig,
    });
    assert.equal(message, "[git-identity] profile: private");
  });

  it("warns when the binding has not reached the environment yet", () => {
    const message = buildMessage(binding, {});
    assert.match(message ?? "", /bound but not active/);
    assert.match(message ?? "", /private/);
  });

  it("warns when gh is switched but the git identity is stale", () => {
    const message = buildMessage(binding, {
      GH_CONFIG_DIR: binding.ghConfigDir,
      GIT_CONFIG_GLOBAL: "/home/me/.config/git-identity/work.gitconfig",
    });
    assert.match(message ?? "", /git identity is not/);
  });

  it("does not check the git identity when the profile sets none", () => {
    const message = buildMessage({ ghConfigDir: "/gh-private" }, { GH_CONFIG_DIR: "/gh-private" });
    assert.equal(message, "[git-identity] profile: private");
  });
});
