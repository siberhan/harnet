/**
 * Job queue stub. README: Kontrol Servisi + Is Kuyrugu ve Hatalar.
 * @typedef {"queued"|"running"|"done"|"error"|"timeout"|"crashed"|"refused"} JobStatusName
 * @typedef {{ id: string, prompt: string, status?: JobStatusName }} Job
 * @typedef {{ push: (job: Job) => Job, pending: () => Job[] }} Queue
 */

export const JobStatus = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  DONE: "done",
  ERROR: "error",
  TIMEOUT: "timeout",
  CRASHED: "crashed",
  REFUSED: "refused",
});

export function createQueue() {
  /** @type {Job[]} */
  const items = [];
  return {
    /** @param {Job} job @returns {Job} */
    push(job) {
      /** @type {Job} */
      const entry = { status: /** @type {JobStatusName} */ (JobStatus.QUEUED), ...job };
      items.push(entry);
      return entry;
    },
    pending() {
      return items.filter((j) => j.status === JobStatus.QUEUED);
    },
  };
}
