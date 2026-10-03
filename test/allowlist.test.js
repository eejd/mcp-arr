/**
 * allowlist.test.js — MCP_ARR_TOOLS parsing and registry pruning.
 * Fake clients only; no network calls.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ToolRegistry } from "../dist/registry.js";
import { parseToolAllowlist, applyToolAllowlist } from "../dist/allowlist.js";
import { registerCoreTools } from "../dist/tools/core.js";
import { registerRadarrTools } from "../dist/tools/radarr.js";
import { registerTrashTools } from "../dist/tools/trash.js";

const clients = { radarr: {} };
const services = [{ name: "radarr", displayName: "Radarr (Movies)" }];

function buildRegistry() {
  const registry = new ToolRegistry();
  registerCoreTools(registry, clients, services, services);
  registerRadarrTools(registry, clients);
  registerTrashTools(registry, clients);
  return registry;
}

describe("parseToolAllowlist", () => {
  it("treats unset as all tools", () => {
    assert.equal(parseToolAllowlist(undefined), null);
  });

  it("throws when set but naming nothing (never fails open)", () => {
    for (const raw of ["", "  ", " , ,"]) {
      assert.throws(() => parseToolAllowlist(raw), /names no tools/);
    }
  });

  it("trims whitespace and dedupes", () => {
    assert.deepEqual([...parseToolAllowlist(" a, b ,a,,b ")].sort(), ["a", "b"]);
  });
});

describe("applyToolAllowlist", () => {
  it("null leaves the registry unchanged", () => {
    const registry = buildRegistry();
    const before = registry.all().length;
    const active = applyToolAllowlist(registry, null);
    assert.equal(registry.all().length, before);
    assert.equal(active.length, before);
  });

  it("keeps exactly the named tools and hides the rest from dispatch", async () => {
    const registry = buildRegistry();
    const active = applyToolAllowlist(
      registry,
      parseToolAllowlist("arr_status,radarr_get_movies"),
    );
    assert.deepEqual(active, ["arr_status", "radarr_get_movies"]);
    assert.deepEqual(
      registry.definitions().map((d) => d.name).sort(),
      ["arr_status", "radarr_get_movies"],
    );
    assert.equal(registry.get("radarr_add_movie"), undefined);
    await assert.rejects(
      registry.dispatch("radarr_add_movie", {}),
      /Unknown tool: radarr_add_movie/,
    );
  });

  it("throws on an unknown name, naming it, and does not prune", () => {
    const registry = buildRegistry();
    const before = registry.all().length;
    assert.throws(
      () => applyToolAllowlist(registry, parseToolAllowlist("arr_status,radar_get_movies")),
      /unknown tool\(s\): radar_get_movies/,
    );
    assert.equal(registry.all().length, before);
  });
});
