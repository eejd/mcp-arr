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

export function registerLidarrTools(registry: ToolRegistry, clients: { lidarr?: LidarrClient }): void {
  if (!clients.lidarr) return;

  registry.register({
    definition: {
      name: "lidarr_get_artists",
      description: "Get all artists in Lidarr library",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    handler: async (_args) => {
      if (!clients.lidarr) throw new Error("Lidarr not configured");
      const artists = await clients.lidarr.getArtists();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            count: artists.length,
            artists: artists.map(a => ({
              id: a.id,
              artistName: a.artistName,
              status: a.status,
              albums: a.statistics?.albumCount,
              tracks: a.statistics?.trackFileCount + '/' + a.statistics?.totalTrackCount,
              sizeOnDisk: formatBytes(a.statistics?.sizeOnDisk || 0),
              monitored: a.monitored,
            })),
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "lidarr.library",
    isWrite: false,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "lidarr_search",
      description: "Search for artists by name. Returns results with foreignArtistId needed for lidarr_add_artist.",
      inputSchema: {
        type: "object" as const,
        properties: {
          term: {
            type: "string",
            description: "Search term (artist name)",
          },
        },
        required: ["term"],
      },
    },
    handler: async (args) => {
      if (!clients.lidarr) throw new Error("Lidarr not configured");
      const a = args as { term?: string; query?: string; artist?: string; name?: string };
      const term = a.term ?? a.query ?? a.artist ?? a.name;
      if (!term) throw new Error("term required (artist name)");
      const results = await clients.lidarr.searchArtists(term);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            count: results.length,
            results: results.slice(0, 10).map(r => ({
              artistName: r.artistName ?? r.title,
              disambiguation: r.disambiguation,
              foreignArtistId: r.foreignArtistId,
              overview: r.overview ? (r.overview.substring(0, 200) + (r.overview.length > 200 ? '...' : '')) : undefined,
            })),
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "lidarr.library",
    isWrite: false,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "lidarr_get_queue",
      description: "Get Lidarr download queue. Supports pagination with limit and offset.",
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
      if (!clients.lidarr) throw new Error("Lidarr not configured");
      const result = await getPaginatedQueue(clients.lidarr, args as { limit?: number; offset?: number });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
    capabilityGroup: "lidarr.library",
    isWrite: false,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "lidarr_get_albums",
      description: "Get albums for an artist in Lidarr. Shows which albums are available and which are missing.",
      inputSchema: {
        type: "object" as const,
        properties: {
          artistId: {
            type: "number",
            description: "Artist ID to get albums for",
          },
        },
        required: ["artistId"],
      },
    },
    handler: async (args) => {
      if (!clients.lidarr) throw new Error("Lidarr not configured");
      const artistId = (args as { artistId: number }).artistId;
      const albums = await clients.lidarr.getAlbums(artistId);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            count: albums.length,
            albums: albums.map(a => ({
              id: a.id,
              title: a.title,
              releaseDate: a.releaseDate,
              albumType: a.albumType,
              monitored: a.monitored,
              tracks: a.statistics ? `${a.statistics.trackFileCount}/${a.statistics.totalTrackCount}` : 'unknown',
              sizeOnDisk: formatBytes(a.statistics?.sizeOnDisk || 0),
              percentComplete: a.statistics?.percentOfTracks || 0,
              grabbed: a.grabbed,
            })),
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "lidarr.library",
    isWrite: false,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "lidarr_search_album",
      description: "Trigger a search for a specific album to download",
      inputSchema: {
        type: "object" as const,
        properties: {
          albumId: {
            type: "number",
            description: "Album ID to search for",
          },
        },
        required: ["albumId"],
      },
    },
    handler: async (args) => {
      if (!clients.lidarr) throw new Error("Lidarr not configured");
      const albumId = (args as { albumId: number }).albumId;
      const result = await clients.lidarr.searchAlbum(albumId);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            message: `Search triggered for album`,
            commandId: result.id,
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "lidarr.writes",
    isWrite: true,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "lidarr_search_missing",
      description: "Trigger a search for all missing albums for an artist",
      inputSchema: {
        type: "object" as const,
        properties: {
          artistId: {
            type: "number",
            description: "Artist ID to search missing albums for",
          },
        },
        required: ["artistId"],
      },
    },
    handler: async (args) => {
      if (!clients.lidarr) throw new Error("Lidarr not configured");
      const artistId = (args as { artistId: number }).artistId;
      const result = await clients.lidarr.searchMissingAlbums(artistId);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            message: `Search triggered for missing albums`,
            commandId: result.id,
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "lidarr.writes",
    isWrite: true,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "lidarr_get_calendar",
      description: "Get upcoming album releases from Lidarr",
      inputSchema: {
        type: "object" as const,
        properties: {
          days: {
            type: "number",
            description: "Number of days to look ahead (default: 30)",
          },
        },
        required: [],
      },
    },
    handler: async (args) => {
      if (!clients.lidarr) throw new Error("Lidarr not configured");
      const days = (args as { days?: number })?.days || 30;
      const start = new Date().toISOString().split('T')[0];
      const end = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const calendar = await clients.lidarr.getCalendar(start, end);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            count: calendar.length,
            albums: calendar.map(a => ({
              id: a.id,
              title: a.title,
              artistId: a.artistId,
              releaseDate: a.releaseDate,
              albumType: a.albumType,
              monitored: a.monitored,
            })),
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "lidarr.library",
    isWrite: false,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "lidarr_add_artist",
      description: "Add an artist to Lidarr. Use lidarr_search first to find the foreignArtistId, and lidarr_get_root_folders / lidarr_get_quality_profiles / lidarr_get_metadata_profiles to get valid values. Use lidarr_get_tags to get valid tag IDs.",
      inputSchema: {
        type: "object" as const,
        properties: {
          foreignArtistId: {
            type: "string",
            description: "Foreign artist ID (MusicBrainz ID) from lidarr_search results",
          },
          artistName: {
            type: "string",
            description: "Artist name",
          },
          qualityProfileId: {
            type: "number",
            description: "Quality profile ID from lidarr_get_quality_profiles",
          },
          metadataProfileId: {
            type: "number",
            description: "Metadata profile ID from lidarr_get_metadata_profiles",
          },
          rootFolderPath: {
            type: "string",
            description: "Root folder path from lidarr_get_root_folders",
          },
          monitored: {
            type: "boolean",
            description: "Whether to monitor the artist (default: true)",
          },
          tags: {
            type: "array",
            items: { type: "number" },
            description: "Array of tag IDs from lidarr_get_tags (optional)",
          },
        },
        required: ["foreignArtistId", "artistName", "qualityProfileId", "metadataProfileId", "rootFolderPath"],
      },
    },
    handler: async (args) => {
      if (!clients.lidarr) throw new Error("Lidarr not configured");
      const { foreignArtistId, artistName, qualityProfileId, metadataProfileId, rootFolderPath, monitored, tags } = args as {
        foreignArtistId: string; artistName: string; qualityProfileId: number;
        metadataProfileId: number; rootFolderPath: string; monitored?: boolean; tags?: number[];
      };
      const added = await clients.lidarr.addArtist({
        foreignArtistId, artistName, qualityProfileId, metadataProfileId, rootFolderPath, monitored, tags: tags ?? [],
      });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            message: `Added "${added.artistName}" to Lidarr`,
            id: added.id,
            path: added.path,
            monitored: added.monitored,
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "lidarr.writes",
    isWrite: true,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "lidarr_get_root_folders",
      description: "Get available root folders for Lidarr. Use this to find valid rootFolderPath values when adding an artist.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    handler: async (_args) => {
      if (!clients.lidarr) throw new Error("Lidarr not configured");
      const folders = await clients.lidarr.getRootFolders();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(folders, null, 2),
        }],
      };
    },
    capabilityGroup: "lidarr.library",
    isWrite: false,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "lidarr_get_quality_profiles",
      description: "Get available quality profiles for Lidarr. Use this to find valid qualityProfileId values when adding an artist.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    handler: async (_args) => {
      if (!clients.lidarr) throw new Error("Lidarr not configured");
      const profiles = await clients.lidarr.getQualityProfiles();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(profiles.map(p => ({ id: p.id, name: p.name })), null, 2),
        }],
      };
    },
    capabilityGroup: "lidarr.library",
    isWrite: false,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "lidarr_get_metadata_profiles",
      description: "Get available metadata profiles for Lidarr. Use this to find valid metadataProfileId values when adding an artist.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    handler: async (_args) => {
      if (!clients.lidarr) throw new Error("Lidarr not configured");
      const profiles = await clients.lidarr.getMetadataProfiles();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(profiles.map(p => ({ id: p.id, name: p.name })), null, 2),
        }],
      };
    },
    capabilityGroup: "lidarr.library",
    isWrite: false,
    alwaysOn: false,
  });
}
