/**
 * search-fetch-schema.test.js — R3 regression lock.
 *
 * Captures the exact definition objects for the `search` and `fetch` tools
 * and asserts they are byte-identical on each build. These are the ChatGPT
 * discovery pair that must not change without an intentional upstream PR.
 *
 * If a test here fails, you modified the schema; update the snapshot AND
 * bump the minor version + note it in CHANGELOG.md.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ToolRegistry } from "../dist/registry.js";
import { registerCoreTools } from "../dist/tools/core.js";

// Minimal fake clients — handlers are never called during registration.
const fakeClients = {};
const configuredServices = [];
const allServices = [
  { name: "sonarr", displayName: "Sonarr (TV)" },
  { name: "radarr", displayName: "Radarr (Movies)" },
  { name: "lidarr", displayName: "Lidarr (Music)" },
  { name: "prowlarr", displayName: "Prowlarr (Indexers)" },
];

function buildCoreRegistry() {
  const registry = new ToolRegistry();
  registerCoreTools(registry, fakeClients, configuredServices, allServices);
  return registry;
}

// ─── SNAPSHOT — edit only when intentionally changing the schema ──────────────

const EXPECTED_SEARCH = {
  name: "search",
  description:
    "Search across configured *arr libraries plus TRaSH Guides reference profiles. This is the primary discovery tool for remote MCP clients such as ChatGPT.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language search query",
      },
    },
    required: ["query"],
  },
};

const EXPECTED_FETCH = {
  name: "fetch",
  description:
    "Fetch a specific item returned by search. Accepts an opaque item id from the search tool.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Opaque result id returned by search",
      },
    },
    required: ["id"],
  },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("search/fetch schema regression lock (R3)", () => {
  const registry = buildCoreRegistry();

  it("'search' definition is byte-identical to snapshot", () => {
    const entry = registry.get("search");
    assert.ok(entry !== undefined, "search tool must be registered");
    assert.deepEqual(entry.definition, EXPECTED_SEARCH);
  });

  it("'fetch' definition is byte-identical to snapshot", () => {
    const entry = registry.get("fetch");
    assert.ok(entry !== undefined, "fetch tool must be registered");
    assert.deepEqual(entry.definition, EXPECTED_FETCH);
  });

  it("'search' is alwaysOn:true and isWrite:false", () => {
    const entry = registry.get("search");
    assert.ok(entry !== undefined);
    assert.equal(entry.alwaysOn, true);
    assert.equal(entry.isWrite, false);
    assert.equal(entry.capabilityGroup, "core");
  });

  it("'fetch' is alwaysOn:true and isWrite:false", () => {
    const entry = registry.get("fetch");
    assert.ok(entry !== undefined);
    assert.equal(entry.alwaysOn, true);
    assert.equal(entry.isWrite, false);
    assert.equal(entry.capabilityGroup, "core");
  });
});
