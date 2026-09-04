/**
 * Test helper: a runner that answers from a routing table instead of spawning
 * processes. Any command that is not routed throws, so a test fails loudly
 * when the implementation issues a command it did not expect.
 *
 * Matching is longest-prefix first: "git worktree add -b" wins over
 * "git worktree add" when both are routed.
 */

/**
 * @typedef {object} FakeResponse
 * @property {number} [status] default 0
 * @property {string} [stdout] default ""
 * @property {string} [stderr] default ""
 */

/**
 * @param {Record<string, FakeResponse>} routes
 * @param {{ calls?: string[] }} [sink]
 * @returns {import("../src/git/worktree.js").Runner}
 */
export function runnerFor(routes, sink = { calls: [] }) {
  const patterns = Object.keys(routes).sort((a, b) => b.length - a.length);
  return (argv, opts) => {
    const key = argv.join(" ");
    sink.calls?.push(`${opts.cwd} :: ${key}`);
    const match = patterns.find((pattern) => key.startsWith(pattern));
    if (match === undefined) throw new Error(`unexpected command: ${key}`);
    const res = routes[match];
    return {
      status: res.status ?? 0,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
    };
  };
}
