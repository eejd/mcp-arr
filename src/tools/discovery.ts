/**
 * Progressive mode discovery tools: arr_discover and arr_activate.
 *
 * These tools are always visible in progressive mode (ARR_TOOL_MODE=progressive)
 * and let an agent discover what capability groups exist, then activate the ones
 * it needs — causing those tools to appear in tools/list via the McpServer
 * registerTool + listChanged mechanism.
 */

import { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import type { Clients } from "./core.js";

// Shape that callers pass in so we can construct group metadata.
export interface ServiceConfig {
  name: keyof Clients;
  displayName: string;
  url?: string;
  apiKey?: string;
}

// All known capability groups in definition order.
// Each entry describes one group independently of whether it is configured.
interface GroupMeta {
  id: string;
  service: string;
  type: string;
  description: string;
}

const ALL_GROUPS: GroupMeta[] = [
  {
    id: "sonarr.library",
    service: "sonarr",
    type: "library",
    description:
      "Sonarr read-only library tools: get_series, search, get_episodes, get_queue, get_calendar",
  },
  {
    id: "sonarr.writes",
    service: "sonarr",
    type: "writes",
    description:
      "Sonarr write tools: add_series, search_missing, search_episode, refresh_series",
  },
  {
    id: "sonarr.config",
    service: "sonarr",
    type: "config",
    description:
      "Sonarr configuration tools: get_quality_profiles, get_health, get_root_folders, get_download_clients, get_naming, get_tags, review_setup",
  },
  {
    id: "radarr.library",
    service: "radarr",
    type: "library",
    description:
      "Radarr read-only library tools: get_movies, search, get_queue, get_calendar",
  },
  {
    id: "radarr.writes",
    service: "radarr",
    type: "writes",
    description:
      "Radarr write tools: add_movie, update_movie, delete_queue_item, search_movie, search_movies, refresh_movie",
  },
  {
    id: "radarr.config",
    service: "radarr",
    type: "config",
    description:
      "Radarr configuration tools: get_quality_profiles, get_health, get_root_folders, get_download_clients, get_naming, get_tags, review_setup",
  },
  {
    id: "lidarr.library",
    service: "lidarr",
    type: "library",
    description:
      "Lidarr read-only library tools: get_artists, search, get_queue, get_albums, get_calendar, get_root_folders, get_quality_profiles, get_metadata_profiles",
  },
  {
    id: "lidarr.writes",
    service: "lidarr",
    type: "writes",
    description: "Lidarr write tools: add_artist, search_album, search_missing",
  },
  {
    id: "lidarr.config",
    service: "lidarr",
    type: "config",
    description:
      "Lidarr configuration tools: get_quality_profiles, get_health, get_root_folders, get_download_clients, get_naming, get_tags, review_setup",
  },
  {
    id: "prowlarr.library",
    service: "prowlarr",
    type: "library",
    description: "Prowlarr read-only tools: get_indexers, test_indexers, get_stats",
  },
  {
    id: "prowlarr.writes",
    service: "prowlarr",
    type: "writes",
    description: "Prowlarr write tools: search",
  },
  {
    id: "prowlarr.config",
    service: "prowlarr",
    type: "config",
    description:
      "Prowlarr configuration tools: get_quality_profiles, get_health, get_root_folders, get_download_clients, get_naming, get_tags, review_setup",
  },
  {
    id: "trash",
    service: "trash",
    type: "reference",
    description:
      "TRaSH Guides reference tools (no service required): list_profiles, get_profile, list_custom_formats, get_naming, get_quality_sizes, compare_profile, compare_naming",
  },
];

// The always-available tools visible in progressive mode from startup.
const ALWAYS_AVAILABLE = [
  "arr_status",
  "search",
  "fetch",
  "arr_search_all",
  "arr_discover",
  "arr_activate",
];

/**
 * Register arr_discover and arr_activate on an McpServer instance.
 *
 * Returns an `activateGroup` helper and the live `activeGroups` map so the
 * caller can inspect activation state if needed.
 */
export function registerDiscoveryTools(
  mcpServer: McpServer,
  registry: ToolRegistry,
  configuredServiceNames: Set<string>,
): {
  activateGroup: (groupId: string) => RegisteredTool[];
  activeGroups: Map<string, RegisteredTool[]>;
} {
  // Track which groups have been activated this session.
  const activeGroups = new Map<string, RegisteredTool[]>();

  /**
   * Activate one capability group: register all its tools on the McpServer
   * (which auto-fires tools/list_changed) and record the handles.
   * Idempotent — calling twice for the same group returns the existing handles.
   */
  function activateGroup(groupId: string): RegisteredTool[] {
    const existing = activeGroups.get(groupId);
    if (existing) return existing;

    const entries = registry.byGroup(groupId);
    const handles: RegisteredTool[] = [];
    for (const entry of entries) {
      // McpServer.registerTool requires Zod schemas; the registry stores plain
      // JSON Schema objects. Omitting inputSchema disables SDK-level validation
      // (args come through as-is), which matches the existing flat-mode behaviour
      // where validation is handled by each tool's own handler.
      const handle = mcpServer.registerTool(
        entry.definition.name,
        { description: entry.definition.description },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (args: any) => {
          const result = await entry.handler(args as Record<string, unknown>);
          return result as { content: Array<{ type: "text"; text: string }>; isError?: boolean };
        },
      );
      handles.push(handle);
    }
    activeGroups.set(groupId, handles);
    return handles;
  }

  // ── arr_discover ──────────────────────────────────────────────────────────
  mcpServer.registerTool(
    "arr_discover",
    {
      description:
        "List all capability groups available on this server. " +
        "Returns configured services, group ids, tool counts, and activation status. " +
        "Call this before arr_activate to learn which group ids to request. " +
        "Groups whose service is not configured are listed with configured:false and toolCount:0.",
      // Empty Zod raw shape = tool with no parameters.
      inputSchema: {},
    },
    async () => {
      const groups = ALL_GROUPS.map((g) => {
        const isConfigured =
          g.service === "trash" || configuredServiceNames.has(g.service);
        const toolCount = isConfigured ? registry.byGroup(g.id).length : 0;
        const activated = activeGroups.has(g.id);

        return isConfigured
          ? {
              id: g.id,
              service: g.service,
              type: g.type,
              description: g.description,
              toolCount,
              activated,
            }
          : {
              id: g.id,
              service: g.service,
              type: g.type,
              configured: false,
              toolCount: 0,
            };
      });

      const response = {
        configuredServices: Array.from(configuredServiceNames),
        groups,
        alwaysAvailable: ALWAYS_AVAILABLE,
        hint:
          "Call arr_activate with one or more group ids to register their tools. " +
          "Groups stay active for the session.",
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  // ── arr_activate ──────────────────────────────────────────────────────────
  mcpServer.registerTool(
    "arr_activate",
    {
      description:
        "Activate one or more capability groups, making their tools available via tools/list. " +
        "Get group ids from arr_discover first. " +
        "Activation is idempotent — activating an already-active group is a no-op. " +
        "After activation your MCP client will receive a tools/list_changed notification (if supported); " +
        "otherwise re-request the tool list manually.",
      // Zod raw shape for the groups parameter.
      inputSchema: {
        groups: z
          .array(z.string())
          .describe(
            'Capability group ids to activate (e.g. ["radarr.library", "sonarr.writes"]). ' +
              "Get group ids from arr_discover.",
          ),
      },
    },
    async (args) => {
      const requestedGroups: string[] = Array.isArray(args.groups) ? args.groups : [];

      const knownGroupIds = new Set(ALL_GROUPS.map((g) => g.id));
      const activated: string[] = [];
      const alreadyActive: string[] = [];
      const unknown: string[] = [];
      const notConfigured: string[] = [];

      for (const groupId of requestedGroups) {
        if (!knownGroupIds.has(groupId)) {
          unknown.push(groupId);
          continue;
        }

        const meta = ALL_GROUPS.find((g) => g.id === groupId)!;
        const isConfigured =
          meta.service === "trash" || configuredServiceNames.has(meta.service);

        if (!isConfigured) {
          notConfigured.push(groupId);
          continue;
        }

        if (activeGroups.has(groupId)) {
          alreadyActive.push(groupId);
          continue;
        }

        activateGroup(groupId);
        activated.push(groupId);
      }

      // Collect tool names from all currently active groups.
      const toolsNowAvailable: string[] = [];
      for (const gid of activeGroups.keys()) {
        for (const entry of registry.byGroup(gid)) {
          toolsNowAvailable.push(entry.definition.name);
        }
      }

      const response = {
        activated,
        alreadyActive,
        unknown,
        notConfigured,
        totalActiveGroups: Array.from(activeGroups.keys()),
        toolsNowAvailable,
        hint:
          "Tools are now registered. Your MCP client should receive a tools/list_changed " +
          "notification if it supports it. If not, re-request the tool list.",
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );

  return { activateGroup, activeGroups };
}
