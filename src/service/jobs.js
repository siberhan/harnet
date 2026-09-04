/**
 * Result groups stub. README: Calistirma Sonuclari ve Grup Bekleme + Sonuc Formati.
 * @param {{ from: string, jobId: string, elapsed: string, task: string, status: string, report: string }} args
 * @returns {string}
 */
export function formatResult({ from, jobId, elapsed, task, status, report }) {
  return [
    `[harnet] Result from ${from} (job ${jobId}, ${elapsed})`,
    `Task you sent: ${task}`,
    `Status: ${status}`,
    `Report: ${report}`,
  ].join("\n");
}
