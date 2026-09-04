/**
 * Agent Profiles and Templates management.
 * README: Ajan Şablonları ve Profilleri, Profil Başına Kalıcı Worktree.
 *
 * Each agent profile is derived from a template (role, default prompt, capabilities).
 * Each profile maps 1:1 to a permanent worktree (.harnet/agents/<id>/wt) on branch
 * harnet/<id>, and a live tmux session (harnet-<id>) via adapters.
 *
 * Abandoning a profile closes the tmux session while preserving the worktree and branch.
 * Removing a profile removes the worktree AND deletes the branch by default.
 */

import { resolve } from "node:path";
import { createClaudeAdapter } from "../adapters/claude.js";
import { createCodexAdapter } from "../adapters/codex.js";
import {
  branchName,
  createWorktreeManager,
  sessionName,
  transcriptDir,
  worktreePath,
} from "../git/worktree.js";

/**
 * @typedef {object} Template
 * @property {string} name
 * @property {string} role
 * @property {string} defaultPrompt
 * @property {readonly string[] | string[]} capabilities
 * @property {"claude"|"codex"|string} harness
 */

/**
 * @typedef {object} Profile
 * @property {string} id agent id
 * @property {Template} template
 * @property {string} worktree relative worktree path (.harnet/agents/<id>/wt)
 * @property {string} branch branch name (harnet/<id>)
 * @property {string} session tmux session name (harnet-<id>)
 * @property {"claude"|"codex"|string} harness
 * @property {"active"|"abandoned"|"removed"} state
 * @property {number} createdAt
 * @property {number|null} [abandonedAt]
 * @property {unknown} [sessionInfo]
 */

/**
 * @typedef {object} CreateProfileSpec
 * @property {string} id
 * @property {string|Partial<Template>} [template]
 * @property {string} [base]
 * @property {string} [command]
 */

/**
 * @typedef {object} OpenProfileSpec
 * @property {string} id
 * @property {string|Partial<Template>} [template]
 * @property {string} [base]
 * @property {string} [command]
 */

/**
 * @typedef {object} AbandonProfileSpec
 * @property {string} id
 */

/**
 * @typedef {object} RemoveProfileSpec
 * @property {string} id
 * @property {boolean} [force]
 * @property {boolean} [deleteBranch] defaults to true
 */

/**
 * @typedef {object} ProfileManagerOptions
 * @property {string} [root]
 * @property {import("../git/worktree.js").Runner} [run]
 * @property {import("../git/worktree.js").Runner} [runner]
 * @property {ReturnType<typeof import("../git/worktree.js").createWorktreeManager>} [worktreeManager]
 * @property {ReturnType<typeof import("../adapters/claude.js").createClaudeAdapter>} [claudeAdapter]
 * @property {ReturnType<typeof import("../adapters/codex.js").createCodexAdapter>} [codexAdapter]
 * @property {string} [base]
 */

export const DEFAULT_TEMPLATE = Object.freeze({
  name: "default",
  role: "general assistant",
  defaultPrompt: "You are a helpful coding assistant working in this repository.",
  capabilities: Object.freeze(["read", "write", "bash"]),
  harness: "claude",
});

export const TEMPLATES = Object.freeze({
  default: DEFAULT_TEMPLATE,
  developer: Object.freeze({
    name: "developer",
    role: "software engineer",
    defaultPrompt: "Implement code changes, write tests, and maintain existing patterns.",
    capabilities: Object.freeze(["read", "write", "bash", "git"]),
    harness: "claude",
  }),
  reviewer: Object.freeze({
    name: "reviewer",
    role: "code reviewer",
    defaultPrompt: "Review code changes for style, correctness, tests, and security.",
    capabilities: Object.freeze(["read"]),
    harness: "claude",
  }),
  codex: Object.freeze({
    name: "codex",
    role: "codex assistant",
    defaultPrompt: "You are a helpful coding assistant powered by Codex.",
    capabilities: Object.freeze(["read", "write", "bash"]),
    harness: "codex",
  }),
});

/**
 * Resolves a template specification into a concrete Template object.
 * Defaults to DEFAULT_TEMPLATE if not specified.
 * @param {string|Partial<Template>} [template]
 * @returns {Template}
 */
export function resolveTemplate(template) {
  if (!template) {
    return DEFAULT_TEMPLATE;
  }
  if (typeof template === "string") {
    const named = TEMPLATES[/** @type {keyof typeof TEMPLATES} */ (template)];
    if (named) return named;
    return {
      name: template,
      role: template,
      defaultPrompt: DEFAULT_TEMPLATE.defaultPrompt,
      capabilities: DEFAULT_TEMPLATE.capabilities,
      harness: DEFAULT_TEMPLATE.harness,
    };
  }
  return {
    name: template.name ?? "custom",
    role: template.role ?? DEFAULT_TEMPLATE.role,
    defaultPrompt: template.defaultPrompt ?? DEFAULT_TEMPLATE.defaultPrompt,
    capabilities: template.capabilities ?? DEFAULT_TEMPLATE.capabilities,
    harness: template.harness ?? DEFAULT_TEMPLATE.harness,
  };
}

/**
 * Creates an agent profile manager.
 * @param {ProfileManagerOptions} [options]
 */
export function createProfileManager(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const run = options.run ?? options.runner;
  const defaultBase = options.base ?? "main";

  const worktreeManager =
    options.worktreeManager ??
    createWorktreeManager({
      root,
      run,
    });

  const claudeAdapter =
    options.claudeAdapter ??
    createClaudeAdapter({
      root,
      run,
    });

  const codexAdapter =
    options.codexAdapter ??
    createCodexAdapter({
      root,
      run,
    });

  /** @type {Map<string, Profile>} */
  const profiles = new Map();

  /**
   * @param {string} harness
   * @returns {ReturnType<typeof createClaudeAdapter> | ReturnType<typeof createCodexAdapter>}
   */
  function getAdapter(harness) {
    if (harness === "codex") {
      return codexAdapter;
    }
    return claudeAdapter;
  }

  /**
   * Creates a new profile: opens worktree + branch, and spawns tmux session via adapter.
   * @param {CreateProfileSpec} spec
   * @returns {Profile}
   */
  function createProfile(spec) {
    const id = spec.id;
    if (!id || typeof id !== "string") {
      throw new Error("createProfile requires a non-empty string id");
    }

    const template = resolveTemplate(spec.template);
    const base = spec.base ?? defaultBase;

    // 1. Open worktree + branch
    const wt = worktreeManager.open({ agentId: id, base });

    // 2. Spawn tmux session via adapter
    const adapter = getAdapter(template.harness);
    const absWorktree = resolve(root, wt.path);
    let sessionInfo = null;

    if (!adapter.isAlive(id)) {
      sessionInfo = adapter.spawn({
        agentId: id,
        worktree: absWorktree,
        command: spec.command,
      });
    }

    /** @type {Profile} */
    const profile = {
      id,
      template,
      worktree: wt.path,
      branch: wt.branch,
      session: sessionName(id),
      harness: template.harness,
      state: "active",
      createdAt: Date.now(),
      sessionInfo,
    };

    profiles.set(id, profile);
    return profile;
  }

  /**
   * Opens / reconnects to a profile: opens worktree and starts session if dead.
   * @param {OpenProfileSpec} spec
   * @returns {Profile}
   */
  function openProfile(spec) {
    const id = spec.id;
    if (!id || typeof id !== "string") {
      throw new Error("openProfile requires a non-empty string id");
    }

    const existing = profiles.get(id);
    const template = resolveTemplate(spec.template ?? existing?.template);
    const base = spec.base ?? defaultBase;

    // Open worktree (idempotent)
    const wt = worktreeManager.open({ agentId: id, base });

    // Spawn session if not alive
    const adapter = getAdapter(template.harness);
    const absWorktree = resolve(root, wt.path);
    let sessionInfo = existing?.sessionInfo ?? null;

    if (!adapter.isAlive(id)) {
      sessionInfo = adapter.spawn({
        agentId: id,
        worktree: absWorktree,
        command: spec.command,
      });
    }

    /** @type {Profile} */
    const profile = {
      id,
      template,
      worktree: wt.path,
      branch: wt.branch,
      session: sessionName(id),
      harness: template.harness,
      state: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      sessionInfo,
    };

    profiles.set(id, profile);
    return profile;
  }

  /**
   * Abandons a profile: closes the tmux session while keeping worktree and branch.
   * @param {AbandonProfileSpec} spec
   * @returns {{ id: string, session: string, sessionClosed: boolean, kept: { worktree: string, branch: string, transcriptDir: string } }}
   */
  function abandonProfile(spec) {
    const id = spec.id;
    if (!id || typeof id !== "string") {
      throw new Error("abandonProfile requires a non-empty string id");
    }

    const abandonResult = worktreeManager.abandon({ agentId: id });
    const profile = profiles.get(id);
    if (profile) {
      profile.state = "abandoned";
      profile.abandonedAt = Date.now();
    }

    return {
      id,
      session: abandonResult.session,
      sessionClosed: abandonResult.sessionClosed,
      kept: {
        worktree: worktreePath(id),
        branch: branchName(id),
        transcriptDir: transcriptDir(id),
      },
    };
  }

  /**
   * Removes a profile: closes session if active, removes worktree and deletes branch by default.
   * (varsayılan dalsız silme kapalı -> deleteBranch: true by default)
   * @param {RemoveProfileSpec} spec
   * @returns {{ id: string, path: string, branch: string, removed: boolean, branchDeleted: boolean }}
   */
  function removeProfile(spec) {
    const id = spec.id;
    if (!id || typeof id !== "string") {
      throw new Error("removeProfile requires a non-empty string id");
    }

    // 1. Close session if alive
    const adapter = getAdapter(profiles.get(id)?.harness ?? "claude");
    if (adapter.isAlive(id)) {
      worktreeManager.abandon({ agentId: id });
    }

    // 2. Remove worktree and delete branch by default
    const force = spec.force ?? true;
    const deleteBranch = spec.deleteBranch ?? true;

    const removeResult = worktreeManager.remove({
      agentId: id,
      force,
      deleteBranch,
    });

    const profile = profiles.get(id);
    if (profile) {
      profile.state = "removed";
    }
    profiles.delete(id);

    return {
      id,
      path: removeResult.path,
      branch: removeResult.branch,
      removed: removeResult.removed,
      branchDeleted: removeResult.branchDeleted,
    };
  }

  /**
   * @param {string} id
   * @returns {Profile|null}
   */
  function getProfile(id) {
    return profiles.get(id) ?? null;
  }

  /**
   * @returns {Profile[]}
   */
  function listProfiles() {
    return [...profiles.values()];
  }

  /**
   * @param {string} id
   * @returns {boolean}
   */
  function hasProfile(id) {
    return profiles.has(id);
  }

  return {
    createProfile,
    openProfile,
    abandonProfile,
    removeProfile,
    getProfile,
    listProfiles,
    hasProfile,
    worktreeManager,
    claudeAdapter,
    codexAdapter,
  };
}

/**
 * Standalone createProfile helper.
 * @param {CreateProfileSpec} spec
 * @param {ProfileManagerOptions} [options]
 * @returns {Profile}
 */
export function createProfile(spec, options = {}) {
  const manager = createProfileManager(options);
  return manager.createProfile(spec);
}

/**
 * Standalone openProfile helper.
 * @param {OpenProfileSpec} spec
 * @param {ProfileManagerOptions} [options]
 * @returns {Profile}
 */
export function openProfile(spec, options = {}) {
  const manager = createProfileManager(options);
  return manager.openProfile(spec);
}

/**
 * Standalone abandonProfile helper.
 * @param {AbandonProfileSpec} spec
 * @param {ProfileManagerOptions} [options]
 * @returns {{ id: string, session: string, sessionClosed: boolean, kept: { worktree: string, branch: string, transcriptDir: string } }}
 */
export function abandonProfile(spec, options = {}) {
  const manager = createProfileManager(options);
  return manager.abandonProfile(spec);
}

/**
 * Standalone removeProfile helper.
 * @param {RemoveProfileSpec} spec
 * @param {ProfileManagerOptions} [options]
 * @returns {{ id: string, path: string, branch: string, removed: boolean, branchDeleted: boolean }}
 */
export function removeProfile(spec, options = {}) {
  const manager = createProfileManager(options);
  return manager.removeProfile(spec);
}
