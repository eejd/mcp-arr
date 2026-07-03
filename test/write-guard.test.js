/**
 * write-guard.test.js — applyWriteGuard gate pipeline with injected fake clients.
 *
 * KEY DESIGN: The write-guard module keeps module-level Maps keyed by service
 * name (lastWriteTime, consecutiveFailures, circuitOpenSince, circuitLastReason).
 * These persist across tests within one process. To prevent cross-test
 * interference, each test uses a UNIQUE fake service name (wg1, wg2, ...).
 * Bulk-write tests suffix the tool name with _search_missing (matches
 * BULK_WRITE_SUFFIXES in write-guard.ts) so the queue and checkpoint gates fire.
 *
 * auditPath: unique tmp file per test; assertions read the JSONL lines after
 * each dispatch call.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

import { ToolRegistry } from "../dist/registry.js";
import { applyWriteGuard } from "../dist/safety/write-guard.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let serviceCounter = 0;
function uniqueService() {
  return `wg${++serviceCounter}`;
}

function tmpAuditPath() {
  return path.join(os.tmpdir(), `mcp-arr-test-${process.pid}-${serviceCounter}.jsonl`);
}

function readAuditLines(auditPath) {
  try {
    const raw = fs.readFileSync(auditPath, "utf8");
    return raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/**
 * Build a registry with one fake write entry and apply the write guard to it.
 * Returns { registry, auditPath, called, result }.
 */
function buildGuardedRegistry({
  service,
  toolName,
  getStatus = async () => ({ version: "5.0", appName: "Fake" }),
  getHealth = async () => [],
  getQueue = async () => ({ totalRecords: 0, records: [] }),
  runBackupCommand = async () => ({ id: 1, status: "completed" }),
  queueSaturationThreshold = 50,
  cooldownMs = 0,
  checkpointBeforeBulk = true,
}) {
  const auditPath = tmpAuditPath();
  let called = false;

  const registry = new ToolRegistry();
  registry.register({
    definition: {
      name: toolName,
      description: "Fake write tool for testing",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    handler: async (_args) => {
      called = true;
      return { content: [{ type: "text", text: "done" }] };
    },
    capabilityGroup: `${service}.writes`,
    isWrite: true,
    alwaysOn: false,
  });

  const fakeClient = { getStatus, getHealth, getQueue, runBackupCommand };
  const clients = { [service]: fakeClient };

  applyWriteGuard(registry, clients, {
    auditPath,
    queueSaturationThreshold,
    cooldownMs,
    checkpointBeforeBulk,
  });

  return {
    registry,
    auditPath,
    get called() { return called; },
    reset() { called = false; },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("write-guard: degraded health (gate 1 — health errors)", () => {
  it("blocks writes when getHealth returns error-typed items", async () => {
    const service = uniqueService();
    const ctx = buildGuardedRegistry({
      service,
      toolName: `${service}_add_thing`,
      getHealth: async () => [{ type: "error", message: "disk full" }],
    });

    const result = await ctx.registry.dispatch(`${service}_add_thing`, {});

    assert.equal(ctx.called, false, "original handler must NOT be called");
    assert.equal(result.isError, true, "result should be an error");
    assert.ok(result.content[0].text.includes("[WRITE_GUARD]"), "text should include [WRITE_GUARD]");

    const lines = readAuditLines(ctx.auditPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].action, "blocked");
    assert.equal(lines[0].gate, "health");
    assert.equal(lines[0].service, service);
    assert.equal(lines[0].tool, `${service}_add_thing`);
  });
});

describe("write-guard: service unreachable + circuit breaker (gate 1 — reachability)", () => {
  it("blocks when getStatus throws (fail-closed)", async () => {
    const service = uniqueService();
    const ctx = buildGuardedRegistry({
      service,
      toolName: `${service}_add_thing`,
      getStatus: async () => { throw new Error("connection refused"); },
    });

    const result = await ctx.registry.dispatch(`${service}_add_thing`, {});

    assert.equal(ctx.called, false);
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("[WRITE_GUARD]"));

    const lines = readAuditLines(ctx.auditPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].gate, "reachability");
    assert.equal(lines[0].action, "blocked");
  });

  it("trips circuit after 3 consecutive failures; 4th call uses cached block (gate: circuit)", async () => {
    const service = uniqueService();
    let statusCallCount = 0;
    const ctx = buildGuardedRegistry({
      service,
      toolName: `${service}_add_thing`,
      getStatus: async () => {
        statusCallCount++;
        throw new Error("timeout");
      },
    });

    const toolName = `${service}_add_thing`;

    // Calls 1, 2, 3 — each hits getStatus and fails (reachability)
    await ctx.registry.dispatch(toolName, {});
    await ctx.registry.dispatch(toolName, {});
    await ctx.registry.dispatch(toolName, {});
    assert.equal(statusCallCount, 3, "getStatus should be called exactly 3 times before circuit trips");

    // Call 4 — circuit is open; getStatus must NOT be called again
    const result4 = await ctx.registry.dispatch(toolName, {});
    assert.equal(statusCallCount, 3, "getStatus must not be called again when circuit is open");
    assert.equal(result4.isError, true);
    assert.ok(result4.content[0].text.includes("[WRITE_GUARD]"));

    const lines = readAuditLines(ctx.auditPath);
    assert.equal(lines.length, 4);
    // First 3: reachability; 4th: circuit
    assert.equal(lines[0].gate, "reachability");
    assert.equal(lines[1].gate, "reachability");
    assert.equal(lines[2].gate, "reachability");
    assert.equal(lines[3].gate, "circuit");
  });
});

describe("write-guard: queue saturation (gate 2 — bulk writes only)", () => {
  it("blocks a bulk write when totalRecords >= threshold", async () => {
    const service = uniqueService();
    // Tool name must end in _search_missing (matches BULK_WRITE_SUFFIXES)
    const toolName = `${service}_search_missing`;
    const ctx = buildGuardedRegistry({
      service,
      toolName,
      getQueue: async () => ({ totalRecords: 999, records: [] }),
      queueSaturationThreshold: 50,
    });

    const result = await ctx.registry.dispatch(toolName, {});

    assert.equal(ctx.called, false, "handler must not run when queue is saturated");
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("[WRITE_GUARD]"));

    const lines = readAuditLines(ctx.auditPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].gate, "queue");
    assert.equal(lines[0].action, "blocked");
  });

  it("does NOT check the queue for a non-bulk write", async () => {
    const service = uniqueService();
    let queueCallCount = 0;
    const ctx = buildGuardedRegistry({
      service,
      toolName: `${service}_add_thing`,  // no bulk suffix
      getQueue: async () => {
        queueCallCount++;
        return { totalRecords: 999, records: [] };
      },
      queueSaturationThreshold: 50,
    });

    // Non-bulk write — should PASS even though queue is saturated, and never call getQueue
    await ctx.registry.dispatch(`${service}_add_thing`, {});
    assert.equal(queueCallCount, 0, "getQueue must not be called for non-bulk writes");
  });
});

describe("write-guard: cooldown (gate 3)", () => {
  it("blocks a second write to the same service within the cooldown window", async () => {
    const service = uniqueService();
    const ctx = buildGuardedRegistry({
      service,
      toolName: `${service}_add_thing`,
      cooldownMs: 10_000, // 10 seconds — far longer than the test runs
    });

    // First dispatch should PASS
    const result1 = await ctx.registry.dispatch(`${service}_add_thing`, {});
    assert.equal(ctx.called, true, "first call should invoke the handler");
    assert.equal(result1.isError, undefined, "first call should not be an error");

    ctx.reset();

    // Second dispatch immediately after — should hit cooldown gate
    const result2 = await ctx.registry.dispatch(`${service}_add_thing`, {});
    assert.equal(ctx.called, false, "second call must not invoke the handler");
    assert.equal(result2.isError, true);
    assert.ok(result2.content[0].text.includes("[WRITE_GUARD]"));

    const lines = readAuditLines(ctx.auditPath);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].action, "allowed");
    assert.equal(lines[1].action, "blocked");
    assert.equal(lines[1].gate, "cooldown");
  });
});

describe("write-guard: happy path (all gates pass)", () => {
  it("non-bulk write: handler runs, audit allowed, no getQueue or runBackupCommand", async () => {
    const service = uniqueService();
    let queueCalls = 0;
    let backupCalls = 0;
    const ctx = buildGuardedRegistry({
      service,
      toolName: `${service}_add_thing`,
      getQueue: async () => { queueCalls++; return { totalRecords: 0, records: [] }; },
      runBackupCommand: async () => { backupCalls++; return { id: 1, status: "completed" }; },
    });

    const result = await ctx.registry.dispatch(`${service}_add_thing`, {});

    assert.equal(ctx.called, true, "handler must be called on happy path");
    assert.equal(result.isError, undefined, "result must not be an error");
    assert.equal(queueCalls, 0, "getQueue must not be called for non-bulk writes");
    assert.equal(backupCalls, 0, "runBackupCommand must not be called for non-bulk writes");

    const lines = readAuditLines(ctx.auditPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].action, "allowed");
    assert.ok(typeof lines[0].durationMs === "number", "audit should record durationMs");
    assert.equal(lines[0].gate, undefined, "allowed entries have no gate field");
  });

  it("bulk write: handler runs, runBackupCommand called, audit allowed", async () => {
    const service = uniqueService();
    let backupCalls = 0;
    const toolName = `${service}_search_missing`;
    const ctx = buildGuardedRegistry({
      service,
      toolName,
      getQueue: async () => ({ totalRecords: 3, records: [] }), // below threshold
      runBackupCommand: async () => { backupCalls++; return { id: 1, status: "completed" }; },
      checkpointBeforeBulk: true,
    });

    const result = await ctx.registry.dispatch(toolName, {});

    assert.equal(ctx.called, true, "handler must be called");
    assert.equal(result.isError, undefined);
    assert.equal(backupCalls, 1, "runBackupCommand should be called once before bulk write");

    const lines = readAuditLines(ctx.auditPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].action, "allowed");
    assert.ok(typeof lines[0].durationMs === "number");
  });

  it("bulk write with checkpointBeforeBulk=false: no runBackupCommand call", async () => {
    const service = uniqueService();
    let backupCalls = 0;
    const toolName = `${service}_search_missing`;
    const ctx = buildGuardedRegistry({
      service,
      toolName,
      getQueue: async () => ({ totalRecords: 0, records: [] }),
      runBackupCommand: async () => { backupCalls++; return { id: 1, status: "completed" }; },
      checkpointBeforeBulk: false,
    });

    await ctx.registry.dispatch(toolName, {});

    assert.equal(backupCalls, 0, "runBackupCommand must not be called when checkpointBeforeBulk=false");
    assert.equal(ctx.called, true);
  });

  it("audit entry does NOT log tool arguments (privacy guard)", async () => {
    const service = uniqueService();
    const ctx = buildGuardedRegistry({
      service,
      toolName: `${service}_add_thing`,
    });

    await ctx.registry.dispatch(`${service}_add_thing`, { sensitiveArg: "api-key-value" });

    const lines = readAuditLines(ctx.auditPath);
    assert.equal(lines.length, 1);
    const entry = lines[0];
    assert.ok(!("args" in entry), "audit entry must not contain args field");
    assert.ok(!JSON.stringify(entry).includes("api-key-value"), "audit must not contain arg values");
  });
});

describe("write-guard: non-write tools are not wrapped", () => {
  it("a tool with isWrite:false is not touched by applyWriteGuard", async () => {
    const service = uniqueService();
    const auditPath = tmpAuditPath();
    let called = false;

    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: `${service}_get_status`,
        description: "Read-only tool",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      handler: async () => {
        called = true;
        return { content: [{ type: "text", text: "ok" }] };
      },
      capabilityGroup: `${service}.library`,
      isWrite: false,    // NOT a write tool
      alwaysOn: false,
    });

    const fakeClient = {
      getStatus: async () => { throw new Error("should not be called"); },
      getHealth: async () => { throw new Error("should not be called"); },
      getQueue: async () => { throw new Error("should not be called"); },
      runBackupCommand: async () => { throw new Error("should not be called"); },
    };

    applyWriteGuard(registry, { [service]: fakeClient }, {
      auditPath,
      queueSaturationThreshold: 50,
      cooldownMs: 0,
      checkpointBeforeBulk: true,
    });

    // Should call through directly without any guard logic
    const result = await registry.dispatch(`${service}_get_status`, {});
    assert.equal(called, true, "read-only handler must be called directly");
    assert.equal(result.isError, undefined);

    // No audit entries for non-write tools
    const lines = readAuditLines(auditPath);
    assert.equal(lines.length, 0, "no audit line should be written for non-write tools");
  });
});
