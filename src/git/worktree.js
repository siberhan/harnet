/** Worktree manager stub. README: Worktree Yonetimi. Layout: .harnet/agents/<id>/wt on branch harnet/<id>. */

/** @param {string} agentId @returns {string} */
export function worktreePath(agentId) {
  return `.harnet/agents/${agentId}/wt`;
}

/** @param {string} agentId @returns {string} */
export function branchName(agentId) {
  return `harnet/${agentId}`;
}
