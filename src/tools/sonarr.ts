import type { SonarrClient, RadarrClient, LidarrClient } from "../arr-client.js";
import type { ToolRegistry } from "../registry.js";

type QueueCapableClient = SonarrClient | RadarrClient | LidarrClient;

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function getPaginatedQueue(
  client: QueueCapableClient,
  args: { limit?: number; offset?: number } | undefined
) {
  const limit = Math.min(Math.max(Math.floor(args?.limit ?? 25), 1), 100);
  const offset = Math.max(Math.floor(args?.offset ?? 0), 0);
  const pageSize = 100;
  const records = [];
  let totalRecords = 0;
  let page = 1;

  while (true) {
    const queuePage = await client.getQueue(page, pageSize);
    totalRecords = queuePage.totalRecords;
    records.push(...queuePage.records);

    if (records.length >= totalRecords || queuePage.records.length === 0) {
      break;
    }

    page += 1;
  }

  const items = records.slice(offset, offset + limit).map((q) => ({
    id: q.id,
    title: q.title,
    status: q.status,
    progress: q.size > 0 ? ((1 - q.sizeleft / q.size) * 100).toFixed(1) + "%" : "unknown",
    timeLeft: q.timeleft,
    downloadClient: q.downloadClient,
    protocol: q.protocol,
    trackedDownloadStatus: q.trackedDownloadStatus,
    trackedDownloadState: q.trackedDownloadState,
  }));

  return {
    total: totalRecords,
    returned: items.length,
    offset,
    limit,
    hasMore: offset + items.length < totalRecords,
    nextOffset: offset + items.length < totalRecords ? offset + items.length : null,
    items,
  };
}

export function registerSonarrTools(registry: ToolRegistry, clients: { sonarr?: SonarrClient }): void {
  if (!clients.sonarr) return;

  registry.register({
    definition: {
      name: "sonarr_get_series",
      description: "Get TV series from Sonarr library with optional pagination and title filtering. Defaults to limit=25 to avoid very large responses. Use offset to fetch additional pages.",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: {
            type: "number",
            description: "Maximum number of series to return (default: 25, max: 100)",
          },
          offset: {
            type: "number",
            description: "Number of series to skip before returning results (default: 0)",
          },
          search: {
            type: "string",
            description: "Optional case-insensitive title filter",
          },
        },
        required: [],
      },
    },
    handler: async (args) => {
      if (!clients.sonarr) throw new Error("Sonarr not configured");
      const { limit = 25, offset = 0, search } = args as {
        limit?: number;
        offset?: number;
        search?: string;
      };
      const normalizedLimit = Math.max(1, Math.min(limit, 100));
      const normalizedOffset = Math.max(0, offset);
      const filter = search?.trim().toLowerCase();

      const allSeries = await clients.sonarr.getSeries();
      const filteredSeries = filter
        ? allSeries.filter(s => s.title.toLowerCase().includes(filter))
        : allSeries;
      const pagedSeries = filteredSeries.slice(normalizedOffset, normalizedOffset + normalizedLimit);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            total: allSeries.length,
            filteredCount: filteredSeries.length,
            returned: pagedSeries.length,
            offset: normalizedOffset,
            limit: normalizedLimit,
            hasMore: normalizedOffset + normalizedLimit < filteredSeries.length,
            nextOffset: normalizedOffset + normalizedLimit < filteredSeries.length
              ? normalizedOffset + normalizedLimit
              : null,
            search: search ?? null,
            series: pagedSeries.map(s => ({
              id: s.id,
              title: s.title,
              year: s.year,
              status: s.status,
              network: s.network,
              seasons: s.statistics?.seasonCount,
              episodes: s.statistics?.episodeFileCount + '/' + s.statistics?.totalEpisodeCount,
              sizeOnDisk: formatBytes(s.statistics?.sizeOnDisk || 0),
              monitored: s.monitored,
            })),
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "sonarr.library",
    isWrite: false,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "sonarr_search",
      description: "Search for TV series by name. Returns results with tvdbId needed for sonarr_add_series.",
      inputSchema: {
        type: "object" as const,
        properties: {
          term: {
            type: "string",
            description: "Search term (show name)",
          },
        },
        required: ["term"],
      },
    },
    handler: async (args) => {
      if (!clients.sonarr) throw new Error("Sonarr not configured");
      const term = (args as { term: string }).term;
      const results = await clients.sonarr.searchSeries(term);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            count: results.length,
            results: results.slice(0, 10).map(r => ({
              title: r.title,
              year: r.year,
              tvdbId: r.tvdbId,
              overview: r.overview?.substring(0, 200) + (r.overview && r.overview.length > 200 ? '...' : ''),
            })),
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "sonarr.library",
    isWrite: false,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "sonarr_get_queue",
      description: "Get Sonarr download queue. Supports pagination with limit and offset.",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: {
            type: "number",
            description: "Maximum number of queue items to return (default: 25, max: 100)",
          },
          offset: {
            type: "number",
            description: "Number of queue items to skip before returning results (default: 0)",
          },
        },
        required: [],
      },
    },
    handler: async (args) => {
      if (!clients.sonarr) throw new Error("Sonarr not configured");
      const result = await getPaginatedQueue(clients.sonarr, args as { limit?: number; offset?: number });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
    capabilityGroup: "sonarr.library",
    isWrite: false,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "sonarr_get_calendar",
      description: "Get upcoming TV episodes from Sonarr",
      inputSchema: {
        type: "object" as const,
        properties: {
          days: {
            type: "number",
            description: "Number of days to look ahead (default: 7)",
          },
        },
        required: [],
      },
    },
    handler: async (args) => {
      if (!clients.sonarr) throw new Error("Sonarr not configured");
      const days = (args as { days?: number })?.days || 7;
      const start = new Date().toISOString().split('T')[0];
      const end = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const calendar = await clients.sonarr.getCalendar(start, end);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(calendar, null, 2) }],
      };
    },
    capabilityGroup: "sonarr.library",
    isWrite: false,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "sonarr_get_episodes",
      description: "Get episodes for a TV series. Shows which episodes are available and which are missing.",
      inputSchema: {
        type: "object" as const,
        properties: {
          seriesId: {
            type: "number",
            description: "Series ID to get episodes for",
          },
          seasonNumber: {
            type: "number",
            description: "Optional: filter to a specific season",
          },
        },
        required: ["seriesId"],
      },
    },
    handler: async (args) => {
      if (!clients.sonarr) throw new Error("Sonarr not configured");
      const { seriesId, seasonNumber } = args as { seriesId: number; seasonNumber?: number };
      const episodes = await clients.sonarr.getEpisodes(seriesId, seasonNumber);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            count: episodes.length,
            episodes: episodes.map(e => ({
              id: e.id,
              seasonNumber: e.seasonNumber,
              episodeNumber: e.episodeNumber,
              title: e.title,
              airDate: e.airDate,
              hasFile: e.hasFile,
              monitored: e.monitored,
            })),
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "sonarr.library",
    isWrite: false,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "sonarr_search_missing",
      description: "Trigger a search for all missing episodes in a series",
      inputSchema: {
        type: "object" as const,
        properties: {
          seriesId: {
            type: "number",
            description: "Series ID to search for missing episodes",
          },
        },
        required: ["seriesId"],
      },
    },
    handler: async (args) => {
      if (!clients.sonarr) throw new Error("Sonarr not configured");
      const seriesId = (args as { seriesId: number }).seriesId;
      const result = await clients.sonarr.searchMissing(seriesId);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            message: `Search triggered for missing episodes`,
            commandId: result.id,
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "sonarr.writes",
    isWrite: true,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "sonarr_search_episode",
      description: "Trigger a search for specific episode(s)",
      inputSchema: {
        type: "object" as const,
        properties: {
          episodeIds: {
            type: "array",
            items: { type: "number" },
            description: "Episode ID(s) to search for",
          },
        },
        required: ["episodeIds"],
      },
    },
    handler: async (args) => {
      if (!clients.sonarr) throw new Error("Sonarr not configured");
      const episodeIds = (args as { episodeIds: number[] }).episodeIds;
      const result = await clients.sonarr.searchEpisode(episodeIds);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            message: `Search triggered for ${episodeIds.length} episode(s)`,
            commandId: result.id,
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "sonarr.writes",
    isWrite: true,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "sonarr_refresh_series",
      description: "Trigger a metadata refresh for a specific series in Sonarr",
      inputSchema: {
        type: "object" as const,
        properties: {
          seriesId: {
            type: "number",
            description: "Series ID to refresh",
          },
        },
        required: ["seriesId"],
      },
    },
    handler: async (args) => {
      if (!clients.sonarr) throw new Error("Sonarr not configured");
      const seriesId = (args as { seriesId: number }).seriesId;
      const series = await clients.sonarr.getSeriesById(seriesId);
      const result = await clients.sonarr.refreshSeries(seriesId);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            message: `Refresh triggered for series`,
            series: {
              id: series.id,
              title: series.title,
              year: series.year,
            },
            commandId: result.id,
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "sonarr.writes",
    isWrite: true,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "sonarr_add_series",
      description: "Add a TV series to Sonarr. Use sonarr_search first to find the tvdbId, and sonarr_get_root_folders / sonarr_get_quality_profiles to get valid values for rootFolderPath and qualityProfileId. Use sonarr_get_tags to get valid tag IDs.",
      inputSchema: {
        type: "object" as const,
        properties: {
          tvdbId: {
            type: "number",
            description: "TVDB ID from sonarr_search results",
          },
          title: {
            type: "string",
            description: "Series title",
          },
          qualityProfileId: {
            type: "number",
            description: "Quality profile ID from sonarr_get_quality_profiles",
          },
          rootFolderPath: {
            type: "string",
            description: "Root folder path from sonarr_get_root_folders",
          },
          monitored: {
            type: "boolean",
            description: "Whether to monitor the series (default: true)",
          },
          seasonFolder: {
            type: "boolean",
            description: "Whether to use season folders (default: true)",
          },
          tags: {
            type: "array",
            items: { type: "number" },
            description: "Array of tag IDs from sonarr_get_tags (optional)",
          },
        },
        required: ["tvdbId", "title", "qualityProfileId", "rootFolderPath"],
      },
    },
    handler: async (args) => {
      if (!clients.sonarr) throw new Error("Sonarr not configured");
      const { tvdbId, title, qualityProfileId, rootFolderPath, monitored, seasonFolder, tags } = args as {
        tvdbId: number; title: string; qualityProfileId: number; rootFolderPath: string;
        monitored?: boolean; seasonFolder?: boolean; tags?: number[];
      };
      const added = await clients.sonarr.addSeries({
        tvdbId, title, qualityProfileId, rootFolderPath, monitored, seasonFolder, tags: tags ?? [],
      });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            message: `Added "${added.title}" (${added.year}) to Sonarr`,
            id: added.id,
            path: added.path,
            monitored: added.monitored,
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "sonarr.writes",
    isWrite: true,
    alwaysOn: false,
  });
}
