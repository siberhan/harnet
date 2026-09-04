/** Delivery stub. README: Teslimat + Cakisma Yonetimi. Merge bottom-up, abort on conflict, report file list. */

export function deliveryPlan({ childBranch, parentBranch }) {
  return `merge ${childBranch} into ${parentBranch}; on conflict: git merge --abort, report file list`;
}
