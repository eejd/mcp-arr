/**
 * registry.test.js — ToolRegistry coverage, group flags, and write-tool invariants.
 *
 * Builds a ToolRegistry with all four services registered (using fake clients),
 * then verifies:
 *  - Every expected tool name is present (former switch-arm coverage).
 *  - Every definition has name + description.
 *  - dispatch() throws "Unknown tool:" for missing names.
 *  - core group = 4 always-on tools; all alwaysOn:true.
 *  - Write tools carry isWrite:true; library/read tools carry isWrite:false.
 *
 * No network calls are made — fake clients are plain objects.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ToolRegistry } from "../dist/registry.js";
import { registerCoreTools } from "../dist/tools/core.js";
import { registerSonarrTools } from "../dist/tools/sonarr.js";
import { registerRadarrTools } from "../dist/tools/radarr.js";
import { registerLidarrTools } from "../dist/tools/lidarr.js";
import { registerProwlarrTools } from "../dist/tools/prowlarr.js";
import { registerTrashTools } from "../dist/tools/trash.js";
import { registerConfigTools } from "../dist/tools/config.js";

// ─── Fake clients ──────────────────────────────────────────────────────────────
// Each client method will throw if accidentally invoked during registration —
// handlers should not be called at register time.

function makeClient(name) {
  const bomb = (method) => { throw new Error(`${name}.${method} called unexpectedly during registration`); };
  return {
    getStatus: () => bomb("getStatus"),
    getHealth: () => bomb("getHealth"),
    getQueue: () => bomb("getQueue"),
    runBackupCommand: () => bomb("runBackupCommand"),
    getSeries: () => bomb("getSeries"),
    searchSeries: () => bomb("searchSeries"),
    getSeriesById: () => bomb("getSeriesById"),
    searchMissing: () => bomb("searchMissing"),
    searchEpisode: () => bomb("searchEpisode"),
    refreshSeries: () => bomb("refreshSeries"),
    addSeries: () => bomb("addSeries"),
    getEpisodes: () => bomb("getEpisodes"),
    getCalendar: () => bomb("getCalendar"),
    getMovies: () => bomb("getMovies"),
    searchMovies: () => bomb("searchMovies"),
    addMovie: () => bomb("addMovie"),
    updateMovie: () => bomb("updateMovie"),
    deleteQueueItem: () => bomb("deleteQueueItem"),
    getArtists: () => bomb("getArtists"),
    searchArtists: () => bomb("searchArtists"),
    addArtist: () => bomb("addArtist"),
    getAlbums: () => bomb("getAlbums"),
    searchAlbum: () => bomb("searchAlbum"),
    getIndexers: () => bomb("getIndexers"),
    testIndexers: () => bomb("testIndexers"),
    getStats: () => bomb("getStats"),
    getQualityProfiles: () => bomb("getQualityProfiles"),
    getRootFolders: () => bomb("getRootFolders"),
    getDownloadClients: () => bomb("getDownloadClients"),
    getNaming: () => bomb("getNaming"),
    getTags: () => bomb("getTags"),
    getMetadataProfiles: () => bomb("getMetadataProfiles"),
  };
}

const fakeClients = {
  sonarr: makeClient("sonarr"),
  radarr: makeClient("radarr"),
  lidarr: makeClient("lidarr"),
  prowlarr: makeClient("prowlarr"),
};

const configuredServices = [
  { name: "sonarr", displayName: "Sonarr (TV)" },
  { name: "radarr", displayName: "Radarr (Movies)" },
  { name: "lidarr", displayName: "Lidarr (Music)" },
  { name: "prowlarr", displayName: "Prowlarr (Indexers)" },
];

const allServices = [...configuredServices];

// ─── Build a full registry once ───────────────────────────────────────────────

function buildRegistry() {
  const registry = new ToolRegistry();
  registerCoreTools(registry, fakeClients, configuredServices, allServices);
  registerSonarrTools(registry, fakeClients);
  registerRadarrTools(registry, fakeClients);
  registerLidarrTools(registry, fakeClients);
  registerProwlarrTools(registry, fakeClients);
  registerTrashTools(registry, fakeClients);
  registerConfigTools(registry, fakeClients);
  return registry;
}

// ─── Expected tool name sets ───────────────────────────────────────────────────

const CORE_TOOLS = ["arr_status", "search", "fetch", "arr_search_all"];

const SONARR_TOOLS = [
  "sonarr_get_series", "sonarr_search", "sonarr_get_queue", "sonarr_get_calendar", "sonarr_get_episodes",
  "sonarr_search_missing", "sonarr_search_episode", "sonarr_refresh_series", "sonarr_add_series",
];

const RADARR_TOOLS = [
  "radarr_get_movies", "radarr_search", "radarr_get_queue", "radarr_get_calendar",
  "radarr_search_movie", "radarr_refresh_movie", "radarr_add_movie",
  "radarr_update_movie", "radarr_delete_queue_item", "radarr_search_movies",
];

const LIDARR_TOOLS = [
  "lidarr_get_artists", "lidarr_search", "lidarr_get_queue", "lidarr_get_albums",
  "lidarr_search_album", "lidarr_search_missing", "lidarr_get_calendar",
  "lidarr_add_artist", "lidarr_get_root_folders", "lidarr_get_quality_profiles",
  "lidarr_get_metadata_profiles",
];

const PROWLARR_TOOLS = [
  "prowlarr_get_indexers", "prowlarr_search", "prowlarr_test_indexers", "prowlarr_get_stats",
];

const TRASH_TOOLS = [
  "trash_list_profiles", "trash_get_profile", "trash_list_custom_formats",
  "trash_get_naming", "trash_get_quality_sizes", "trash_compare_profile", "trash_compare_naming",
];

// Config tools are generated per service for sonarr / radarr / lidarr
const CONFIG_SUFFIXES = [
  "_get_quality_profiles", "_get_health", "_get_root_folders",
  "_get_download_clients", "_get_naming", "_get_tags", "_review_setup",
];
const CONFIG_TOOLS = ["sonarr", "radarr", "lidarr"].flatMap(
  (svc) => CONFIG_SUFFIXES.map((s) => `${svc}${s}`)
);

// Tools that MUST carry isWrite: true
const WRITE_TOOLS = new Set([
  "sonarr_search_missing", "sonarr_search_episode", "sonarr_refresh_series", "sonarr_add_series",
  "radarr_search_movie", "radarr_refresh_movie", "radarr_add_movie",
  "radarr_update_movie", "radarr_delete_queue_item", "radarr_search_movies",
  "lidarr_search_album", "lidarr_search_missing", "lidarr_add_artist",
  "prowlarr_search",
]);

// Tools that MUST carry isWrite: false (a representative subset)
const READONLY_TOOLS = new Set([
  "arr_status", "search", "fetch", "arr_search_all",
  "sonarr_get_series", "sonarr_search", "sonarr_get_queue", "sonarr_get_calendar", "sonarr_get_episodes",
  "radarr_get_movies", "radarr_search", "radarr_get_queue", "radarr_get_calendar",
  "lidarr_get_artists", "lidarr_search", "lidarr_get_queue", "lidarr_get_albums",
  "prowlarr_get_indexers", "prowlarr_test_indexers", "prowlarr_get_stats",
]);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ToolRegistry", () => {
  const registry = buildRegistry();

  describe("coverage — all former switch arms present", () => {
    const allExpected = [
      ...CORE_TOOLS, ...SONARR_TOOLS, ...RADARR_TOOLS, ...LIDARR_TOOLS,
      ...PROWLARR_TOOLS, ...TRASH_TOOLS, ...CONFIG_TOOLS,
    ];

    it("every expected tool is registered", () => {
      for (const name of allExpected) {
        assert.ok(registry.get(name) !== undefined, `Missing tool: ${name}`);
      }
    });

    it("every definition has name and description strings", () => {
      for (const entry of registry.all()) {
        assert.equal(typeof entry.definition.name, "string", `${entry.definition.name}.name not a string`);
        assert.ok(entry.definition.name.length > 0, `${entry.definition.name} has empty name`);
        assert.equal(typeof entry.definition.description, "string", `${entry.definition.name}.description not a string`);
        assert.ok(entry.definition.description.length > 0, `${entry.definition.name} has empty description`);
      }
    });
  });

  describe("dispatch()", () => {
    it("throws 'Unknown tool: <name>' for unregistered tools", async () => {
      await assert.rejects(
        () => registry.dispatch("__missing_tool__", {}),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes("Unknown tool:"));
          return true;
        },
      );
    });
  });

  describe("core group", () => {
    it("exactly 4 always-on tools in 'core' group", () => {
      const coreEntries = registry.byGroup("core");
      const coreNames = coreEntries.map((e) => e.definition.name).sort();
      assert.deepEqual(coreNames, [...CORE_TOOLS].sort());
    });

    it("all core tools are alwaysOn:true", () => {
      for (const entry of registry.byGroup("core")) {
        assert.ok(entry.alwaysOn === true, `${entry.definition.name} should be alwaysOn:true`);
      }
    });

    it("all core tools are isWrite:false", () => {
      for (const entry of registry.byGroup("core")) {
        assert.ok(entry.isWrite === false, `${entry.definition.name} should be isWrite:false`);
      }
    });
  });

  describe("isWrite flags", () => {
    it("write tools carry isWrite:true", () => {
      for (const name of WRITE_TOOLS) {
        const entry = registry.get(name);
        assert.ok(entry !== undefined, `Write tool not registered: ${name}`);
        assert.ok(entry.isWrite === true, `${name} should be isWrite:true`);
      }
    });

    it("read-only tools carry isWrite:false", () => {
      for (const name of READONLY_TOOLS) {
        const entry = registry.get(name);
        assert.ok(entry !== undefined, `Read tool not registered: ${name}`);
        assert.ok(entry.isWrite === false, `${name} should be isWrite:false`);
      }
    });
  });

  describe("definitions()", () => {
    it("returns an array of Tool objects equal to all().length", () => {
      const defs = registry.definitions();
      assert.equal(defs.length, registry.all().length);
      assert.ok(defs.every((d) => typeof d.name === "string" && d.name.length > 0));
    });
  });
});
