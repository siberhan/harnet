import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { start, renderHtml } from "../src/panel/server.js";

describe("panel: permissions endpoints & provider", () => {
  it("GET /api/permissions returns empty array by default", async () => {
    const { port, close } = await start({ port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/permissions`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
      const data = await res.json();
      assert.deepEqual(data, []);
    } finally {
      await close();
    }
  });

  it("HEAD /api/permissions returns 200 with empty body", async () => {
    const { port, close } = await start({ port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/permissions`, { method: "HEAD" });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
      const body = await res.text();
      assert.equal(body, "");
    } finally {
      await close();
    }
  });

  it("GET /api/permissions returns injected array provider items", async () => {
    const now = Date.now();
    /** @type {import("../src/panel/server.js").PermissionItem[]} */
    const permissions = [
      { id: "perm-1", agentId: "agent-a", kind: "permission", prompt: "Run npm install", createdAt: now },
      { id: "perm-2", agentId: "agent-b", kind: "bash", prompt: "Execute rm -rf /tmp/cache", createdAt: now + 100 },
    ];

    const { port, close } = await start({ port: 0, permissions });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/permissions`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(data, permissions);
    } finally {
      await close();
    }
  });

  it("GET /api/permissions returns items from function provider", async () => {
    const now = Date.now();
    let dynamicCount = 1;
    const provider = () => [
      { id: `p-${dynamicCount++}`, agentId: "bot", kind: "permission", prompt: "test question", createdAt: now },
    ];

    const { port, close } = await start({ port: 0, permissions: provider });
    try {
      const res1 = await fetch(`http://127.0.0.1:${port}/api/permissions`);
      const data1 = await res1.json();
      assert.equal(data1[0].id, "p-1");

      const res2 = await fetch(`http://127.0.0.1:${port}/api/permissions`);
      const data2 = await res2.json();
      assert.equal(data2[0].id, "p-2");
    } finally {
      await close();
    }
  });

  it("GET /api/permissions returns items from object provider (.all() or .list())", async () => {
    const now = Date.now();
    const objectProvider = {
      all: () => [
        { id: "obj-perm", agentId: "worker", kind: "permission", prompt: "Allow file write", createdAt: now },
      ],
    };

    const { port, close } = await start({ port: 0, permissions: objectProvider });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/permissions`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.length, 1);
      assert.equal(data[0].id, "obj-perm");
      assert.equal(data[0].agentId, "worker");
    } finally {
      await close();
    }
  });

  it("GET /api/permissions/<id> returns single permission item", async () => {
    const now = Date.now();
    const permissions = [
      { id: "perm-xyz", agentId: "agent-x", kind: "permission", prompt: "Ask for token", createdAt: now },
    ];

    const { port, close } = await start({ port: 0, permissions });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/permissions/perm-xyz`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.id, "perm-xyz");
      assert.equal(data.agentId, "agent-x");

      // Non-existent id returns 404
      const res404 = await fetch(`http://127.0.0.1:${port}/api/permissions/non-existent`);
      assert.equal(res404.status, 404);
      const err = await res404.json();
      assert.equal(err.error, "Permission not found");
    } finally {
      await close();
    }
  });

  it("POST /api/permissions/<id> approves permission and triggers callback", async () => {
    /** @type {Array<{ id: string, decision: string }>} */
    const recordedDecisions = [];
    const permissions = [
      { id: "perm-app", agentId: "bot", kind: "permission", prompt: "Run tests", createdAt: Date.now() },
    ];

    const { port, close } = await start({
      port: 0,
      permissions,
      onPermissionDecision: (id, decision) => {
        recordedDecisions.push({ id, decision });
      },
    });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/permissions/perm-app`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
      const data = await res.json();
      assert.deepEqual(data, { ok: true });

      assert.equal(recordedDecisions.length, 1);
      assert.equal(recordedDecisions[0].id, "perm-app");
      assert.equal(recordedDecisions[0].decision, "approve");
    } finally {
      await close();
    }
  });

  it("POST /api/permissions/<id> denies permission and delegates to object provider decide()", async () => {
    /** @type {Array<{ id: string, decision: string }>} */
    const decisions = [];
    const provider = {
      all: () => [{ id: "perm-deny-test", agentId: "bot", kind: "permission", prompt: "Delete file", createdAt: Date.now() }],
      decide: (/** @type {string} */ id, /** @type {"approve"|"deny"} */ decision) => {
        decisions.push({ id, decision });
      },
    };

    const { port, close } = await start({ port: 0, permissions: provider });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/permissions/perm-deny-test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "deny" }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(data, { ok: true });

      assert.equal(decisions.length, 1);
      assert.equal(decisions[0].id, "perm-deny-test");
      assert.equal(decisions[0].decision, "deny");
    } finally {
      await close();
    }
  });

  it("POST /api/permissions/<id> removes item from mutable permissions array by default", async () => {
    const permissions = [
      { id: "item-1", agentId: "a1", kind: "permission", prompt: "step 1", createdAt: Date.now() },
      { id: "item-2", agentId: "a2", kind: "permission", prompt: "step 2", createdAt: Date.now() },
    ];

    const { port, close } = await start({ port: 0, permissions });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/permissions/item-1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      });

      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });

      // item-1 was removed, item-2 remains
      assert.equal(permissions.length, 1);
      assert.equal(permissions[0].id, "item-2");
    } finally {
      await close();
    }
  });

  it("POST /api/permissions/<id> rejects invalid decision with 400", async () => {
    const { port, close } = await start({ port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/permissions/perm-1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "maybe" }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.ok(data.error.includes("Invalid decision"));
    } finally {
      await close();
    }
  });

  it("POST /api/permissions/<id> rejects malformed JSON body with 400", async () => {
    const { port, close } = await start({ port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/permissions/perm-1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not a valid json {",
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.error, "Invalid JSON body");
    } finally {
      await close();
    }
  });

  it("POST to unknown route returns 405 Method Not Allowed", async () => {
    const { port, close } = await start({ port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      });

      assert.equal(res.status, 405);
      const data = await res.json();
      assert.equal(data.error, "Method Not Allowed");
    } finally {
      await close();
    }
  });
});

describe("panel: HTML permissions section rendering", () => {
  it("renders empty state when no permissions are pending", () => {
    const html = renderHtml([], [], []);
    assert.ok(html.includes("Bekleyen İzinler (0)"));
    assert.ok(html.includes("Bekleyen izin isteği bulunmuyor."));
  });

  it("renders pending permissions table with approve and deny buttons", () => {
    const now = Date.now();
    /** @type {import("../src/panel/server.js").PermissionItem[]} */
    const permissions = [
      { id: "perm-render-1", agentId: "agent-claude", kind: "permission", prompt: "Run npm test in terminal", createdAt: now },
      { id: "perm-render-2", agentId: "agent-codex", kind: "bash", prompt: "Deploy to staging", createdAt: now + 500 },
    ];

    const html = renderHtml([], [], permissions);
    assert.ok(html.includes("Bekleyen İzinler (2)"));
    assert.ok(html.includes("perm-render-1"));
    assert.ok(html.includes("agent-claude"));
    assert.ok(html.includes("Run npm test in terminal"));
    assert.ok(html.includes("Onayla"));
    assert.ok(html.includes("Reddet"));
    assert.ok(html.includes("decidePermission('perm-render-1', 'approve')"));
    assert.ok(html.includes("decidePermission('perm-render-1', 'deny')"));
    assert.ok(html.includes('data-perm-id="perm-render-2"'));
    assert.ok(html.includes("Deploy to staging"));
  });

  it("home page GET / serves rendered permissions from provider", async () => {
    const permissions = [
      { id: "perm-web", agentId: "web-agent", kind: "permission", prompt: "Allow web access", createdAt: Date.now() },
    ];

    const { port, close } = await start({ port: 0, permissions });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
      const html = await res.text();
      assert.ok(html.includes("Bekleyen İzinler (1)"));
      assert.ok(html.includes("perm-web"));
      assert.ok(html.includes("Allow web access"));
      assert.ok(html.includes("Onayla"));
      assert.ok(html.includes("Reddet"));
    } finally {
      await close();
    }
  });
});
