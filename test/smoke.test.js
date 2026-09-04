import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createQueue, JobStatus } from "../src/service/queue.js";
import { formatResult } from "../src/service/jobs.js";
import { worktreePath, branchName } from "../src/git/worktree.js";
import { deliveryPlan } from "../src/git/deliver.js";
import { summarizeUsage } from "../src/observe/transcript.js";

describe("scaffold", () => {
  it("queue starts empty, push queues", () => {
    const q = createQueue();
    assert.equal(q.pending().length, 0);
    q.push({ id: "1", prompt: "hi" });
    assert.equal(q.pending().length, 1);
    assert.equal(q.pending()[0].status, JobStatus.QUEUED);
  });

  it("result block matches README format", () => {
    const out = formatResult({
      from: "B",
      jobId: "4f21",
      elapsed: "4m 12s",
      task: "do x",
      status: "done",
      report: "did x",
    });
    assert.ok(out.startsWith("[harnet] Result from B (job 4f21, 4m 12s)"));
  });

  it("worktree layout matches README", () => {
    assert.equal(worktreePath("a1"), ".harnet/agents/a1/wt");
    assert.equal(branchName("a1"), "harnet/a1");
  });

  it("delivery plan mentions abort", () => {
    assert.ok(deliveryPlan({ childBranch: "harnet/b", parentBranch: "main" }).includes("abort"));
  });

  it("usage sums tokens", () => {
    assert.deepEqual(summarizeUsage([{ tokens: 3 }]), { tokens: 3 });
  });
});
