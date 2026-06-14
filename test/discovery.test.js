/**
 * discovery.test.js — arr_discover and arr_activate behaviour.
 *
 * Uses a fake McpServer stub instead of a live transport so no network or stdio
 * is involved. The stub records registerTool() calls and exposes captured
 * handlers so we can invoke them directly.
 *
 * Configured services: radarr + trash (sonarr / lidarr / prowlarr unconfigured).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ToolRegistry } from "../dist/registry.js";
import { registerCoreTools } from "../dist/tools/core.js";
import { registerRadarrTools } from "../dist/tools/radarr.js";
import { registerTrashTools } from "../dist/tools/trash.js";
import { registerConfigTools } from "../dist/tools/config.js";
import { registerDiscoveryTools } from "../dist/tools/discovery.js";

// ─── Fake McpServer stub ──────────────────────────────────────────────────────

function makeFakeMcpServer() {
  const handlers = new Map(); // name → handler function
  const stub = {
    registerTool(name, _meta, handler) {
      handlers.set(name, handler);
      return {}; // fake RegisteredTool handle
    },
    _handlers: handlers,
  };
  return stub;
}

// ─── Fake clients ──────────────────────────────────────────────────────────────

const fakeRadarr = {
  getStatus: async () => ({ version: "5.0", appName: "Radarr" }),
  getHealth: async () => [],
  getQueue: async () => ({ totalRecords: 0, records: [] }),
  runBackupCommand: async () => ({ id: 1, status: "completed" }),
  searchMovies: async () => [],
  getMovies: async () => [],
  addMovie: async () => ({}),
  updateMovie: async () => ({}),
  deleteQueueItem: async () => ({}),
  getCalendar: async () => [],
};

const fakeClients = { radarr: fakeRadarr };
const configuredServices = [{ name: "radarr", displayName: "Radarr (Movies)" }];
const allServices = [
  { name: "sonarr", displayName: "Sonarr (TV)" },
  { name: "radarr", displayName: "Radarr (Movies)" },
  { name: "lidarr", displayName: "Lidarr (Music)" },
  { name: "prowlarr", displayName: "Prowlarr (Indexers)" },
];

function buildRegistryAndDiscovery() {
  const registry = new ToolRegistry();
  registerCoreTools(registry, fakeClients, configuredServices, allServices);
  registerRadarrTools(registry, fakeClients);
  registerTrashTools(registry, fakeClients);
  registerConfigTools(registry, fakeClients);

  const configuredServiceNames = new Set(["radarr"]);
  const mcpStub = makeFakeMcpServer();
  const { activateGroup, activeGroups } = registerDiscoveryTools(
    mcpStub,
    registry,
    configuredServiceNames,
  );

  return { registry, mcpStub, activateGroup, activeGroups };
}

// Helper to invoke a captured handler and parse the JSON response body.
async function callHandler(mcpStub, name, args = {}) {
  const handler = mcpStub._handlers.get(name);
  assert.ok(handler !== undefined, `Handler '${name}' not registered on stub`);
  const result = await handler(args);
  const text = result?.content?.[0]?.text;
  assert.ok(typeof text === "string", `Handler '${name}' did not return text content`);
  return JSON.parse(text);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("arr_discover", () => {
  it("registers arr_discover and arr_activate on the McpServer stub", () => {
    const { mcpStub } = buildRegistryAndDiscovery();
    assert.ok(mcpStub._handlers.has("arr_discover"), "arr_discover not registered");
    assert.ok(mcpStub._handlers.has("arr_activate"), "arr_activate not registered");
  });

  it("configured groups show toolCount > 0 and activated:false initially", async () => {
    const { mcpStub } = buildRegistryAndDiscovery();
    const response = await callHandler(mcpStub, "arr_discover");

    const radarrLibrary = response.groups.find((g) => g.id === "radarr.library");
    assert.ok(radarrLibrary !== undefined, "radarr.library group missing");
    assert.ok(radarrLibrary.toolCount > 0, "radarr.library should have tools");
    assert.equal(radarrLibrary.activated, false, "radarr.library should not be activated initially");

    const trashGroup = response.groups.find((g) => g.id === "trash");
    assert.ok(trashGroup !== undefined, "trash group missing");
    assert.ok(trashGroup.toolCount > 0, "trash should have tools");
    assert.equal(trashGroup.activated, false);
  });

  it("unconfigured groups show configured:false and toolCount:0", async () => {
    const { mcpStub } = buildRegistryAndDiscovery();
    const response = await callHandler(mcpStub, "arr_discover");

    for (const id of ["sonarr.library", "sonarr.writes", "sonarr.config",
                       "lidarr.library", "lidarr.writes", "lidarr.config",
                       "prowlarr.library", "prowlarr.writes", "prowlarr.config"]) {
      const g = response.groups.find((g) => g.id === id);
      assert.ok(g !== undefined, `group ${id} missing from response`);
      assert.equal(g.configured, false, `${id} should be configured:false`);
      assert.equal(g.toolCount, 0, `${id} should have toolCount:0`);
    }
  });

  it("alwaysAvailable lists the 6 startup tools", async () => {
    const { mcpStub } = buildRegistryAndDiscovery();
    const response = await callHandler(mcpStub, "arr_discover");

    const expected = ["arr_status", "search", "fetch", "arr_search_all", "arr_discover", "arr_activate"].sort();
    assert.deepEqual(response.alwaysAvailable.slice().sort(), expected);
  });

  it("response includes configuredServices array", async () => {
    const { mcpStub } = buildRegistryAndDiscovery();
    const response = await callHandler(mcpStub, "arr_discover");
    assert.ok(Array.isArray(response.configuredServices));
    assert.ok(response.configuredServices.includes("radarr"));
  });
});

describe("arr_activate", () => {
  it("activates a known configured group and lists its tools", async () => {
    const { mcpStub } = buildRegistryAndDiscovery();
    const response = await callHandler(mcpStub, "arr_activate", { groups: ["radarr.library"] });

    assert.ok(response.activated.includes("radarr.library"), "radarr.library should be in activated");
    assert.ok(Array.isArray(response.toolsNowAvailable), "toolsNowAvailable should be an array");
    assert.ok(response.toolsNowAvailable.includes("radarr_get_movies"), "radarr_get_movies should be available");
    assert.equal(response.alreadyActive.length, 0, "no group should be alreadyActive on first call");
    assert.equal(response.unknown.length, 0);
    assert.equal(response.notConfigured.length, 0);
  });

  it("re-activating an already active group returns alreadyActive", async () => {
    const { mcpStub } = buildRegistryAndDiscovery();
    // First activation
    await callHandler(mcpStub, "arr_activate", { groups: ["radarr.library"] });
    // Second activation — same group
    const response = await callHandler(mcpStub, "arr_activate", { groups: ["radarr.library"] });

    assert.ok(response.alreadyActive.includes("radarr.library"), "second call should report alreadyActive");
    assert.equal(response.activated.length, 0, "nothing new should be activated");
  });

  it("unknown group ids are reported in unknown[]", async () => {
    const { mcpStub } = buildRegistryAndDiscovery();
    const response = await callHandler(mcpStub, "arr_activate", { groups: ["nonexistent.group"] });

    assert.ok(response.unknown.includes("nonexistent.group"));
    assert.equal(response.activated.length, 0);
  });

  it("a known but unconfigured group id is reported in notConfigured[]", async () => {
    const { mcpStub } = buildRegistryAndDiscovery();
    // sonarr is not in configuredServiceNames
    const response = await callHandler(mcpStub, "arr_activate", { groups: ["sonarr.library"] });

    assert.ok(response.notConfigured.includes("sonarr.library"), "sonarr.library should be notConfigured");
    assert.equal(response.activated.length, 0);
  });

  it("activates multiple groups in one call", async () => {
    const { mcpStub } = buildRegistryAndDiscovery();
    const response = await callHandler(mcpStub, "arr_activate", {
      groups: ["radarr.library", "radarr.writes", "trash"],
    });

    assert.ok(response.activated.includes("radarr.library"));
    assert.ok(response.activated.includes("radarr.writes"));
    assert.ok(response.activated.includes("trash"));
    assert.equal(response.activated.length, 3);
  });

  it("totalActiveGroups reflects cumulative state across calls", async () => {
    const { mcpStub, activeGroups } = buildRegistryAndDiscovery();
    await callHandler(mcpStub, "arr_activate", { groups: ["radarr.library"] });
    await callHandler(mcpStub, "arr_activate", { groups: ["radarr.writes"] });

    assert.ok(activeGroups.has("radarr.library"), "radarr.library should be in activeGroups");
    assert.ok(activeGroups.has("radarr.writes"), "radarr.writes should be in activeGroups");
    assert.equal(activeGroups.size, 2);
  });

  it("activateGroup() is idempotent — calling twice returns same handles", () => {
    const { activateGroup, activeGroups } = buildRegistryAndDiscovery();
    const handles1 = activateGroup("radarr.library");
    const handles2 = activateGroup("radarr.library");

    // Idempotent: returns the same handle array reference
    assert.equal(handles1, handles2, "activateGroup should return cached handles on second call");
    assert.equal(activeGroups.size, 1);
  });

  it("activated tools are registered on the McpServer stub", async () => {
    const { mcpStub } = buildRegistryAndDiscovery();
    await callHandler(mcpStub, "arr_activate", { groups: ["radarr.library"] });

    // The radarr.library tools should now be registered on the stub
    assert.ok(mcpStub._handlers.has("radarr_get_movies"), "radarr_get_movies should be registered after activation");
    assert.ok(mcpStub._handlers.has("radarr_search"), "radarr_search should be registered after activation");
    assert.ok(mcpStub._handlers.has("radarr_get_queue"), "radarr_get_queue should be registered after activation");
  });
});
