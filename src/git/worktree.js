/** Worktree manager stub. README: Worktree Yonetimi. Layout: .harnet/agents/<id>/wt on branch harnet/<id>. */

export function worktreePath(agentId) {
  return `.harnet/agents/${agentId}/wt`;
}

export function branchName(agentId) {
  return `harnet/${agentId}`;
}
