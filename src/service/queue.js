/** Job queue stub. README: Kontrol Servisi + Is Kuyrugu ve Hatalar. */

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
  const items = [];
  return {
    push(job) {
      const entry = { status: JobStatus.QUEUED, ...job };
      items.push(entry);
      return entry;
    },
    pending() {
      return items.filter((j) => j.status === JobStatus.QUEUED);
    },
  };
}
