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

export function registerRadarrTools(registry: ToolRegistry, clients: { radarr?: RadarrClient }): void {
  if (!clients.radarr) return;

  registry.register({
    definition: {
      name: "radarr_get_movies",
      description: "Get movies from Radarr library with optional pagination and title filtering. Defaults to limit=25 to avoid very large responses. Use offset to fetch additional pages.",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: {
            type: "number",
            description: "Maximum number of movies to return (default: 25, max: 100)",
          },
          offset: {
            type: "number",
            description: "Number of movies to skip before returning results (default: 0)",
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
      if (!clients.radarr) throw new Error("Radarr not configured");
      const { limit = 25, offset = 0, search } = args as {
        limit?: number;
        offset?: number;
        search?: string;
      };
      const normalizedLimit = Math.max(1, Math.min(limit, 100));
      const normalizedOffset = Math.max(0, offset);
      const filter = search?.trim().toLowerCase();

      const allMovies = await clients.radarr.getMovies();
      const filteredMovies = filter
        ? allMovies.filter(m => m.title.toLowerCase().includes(filter))
        : allMovies;
      const pagedMovies = filteredMovies.slice(normalizedOffset, normalizedOffset + normalizedLimit);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            total: allMovies.length,
            filteredCount: filteredMovies.length,
            returned: pagedMovies.length,
            offset: normalizedOffset,
            limit: normalizedLimit,
            hasMore: normalizedOffset + normalizedLimit < filteredMovies.length,
            nextOffset: normalizedOffset + normalizedLimit < filteredMovies.length
              ? normalizedOffset + normalizedLimit
              : null,
            search: search ?? null,
            movies: pagedMovies.map(m => ({
              id: m.id,
              title: m.title,
              year: m.year,
              status: m.status,
              hasFile: m.hasFile,
              sizeOnDisk: formatBytes(m.sizeOnDisk),
              monitored: m.monitored,
              studio: m.studio,
              qualityProfileId: m.qualityProfileId,
              ...(m.movieFile ? {
                quality: m.movieFile.quality?.quality?.name ?? null,
                resolution: m.movieFile.mediaInfo?.resolution ?? null,
                videoCodec: m.movieFile.mediaInfo?.videoCodec ?? null,
                videoDynamicRange: m.movieFile.mediaInfo?.videoDynamicRange ?? null,
                audioCodec: m.movieFile.mediaInfo?.audioCodec ?? null,
                audioChannels: m.movieFile.mediaInfo?.audioChannels ?? null,
              } : {}),
              ratings: Object.fromEntries(
                Object.entries(m.ratings || {})
                  .filter(([, v]) => v && v.value > 0)
                  .map(([k, v]) => [k, v.value])
              ),
            })),
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "radarr.library",
    isWrite: false,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "radarr_search",
      description: "Search for movies by name. Returns results with tmdbId needed for radarr_add_movie.",
      inputSchema: {
        type: "object" as const,
        properties: {
          term: {
            type: "string",
            description: "Search term (movie name)",
          },
        },
        required: ["term"],
      },
    },
    handler: async (args) => {
      if (!clients.radarr) throw new Error("Radarr not configured");
      const term = (args as { term: string }).term;
      const results = await clients.radarr.searchMovies(term);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            count: results.length,
            results: results.slice(0, 10).map(r => ({
              title: r.title,
              year: r.year,
              tmdbId: r.tmdbId,
              imdbId: r.imdbId,
              overview: r.overview?.substring(0, 200) + (r.overview && r.overview.length > 200 ? '...' : ''),
            })),
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "radarr.library",
    isWrite: false,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "radarr_get_queue",
      description: "Get Radarr download queue. Supports pagination with limit and offset.",
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
      if (!clients.radarr) throw new Error("Radarr not configured");
      const result = await getPaginatedQueue(clients.radarr, args as { limit?: number; offset?: number });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
    capabilityGroup: "radarr.library",
    isWrite: false,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "radarr_get_calendar",
      description: "Get upcoming movie releases from Radarr",
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
      if (!clients.radarr) throw new Error("Radarr not configured");
      const days = (args as { days?: number })?.days || 30;
      const start = new Date().toISOString().split('T')[0];
      const end = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const calendar = await clients.radarr.getCalendar(start, end);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(calendar, null, 2) }],
      };
    },
    capabilityGroup: "radarr.library",
    isWrite: false,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "radarr_search_movie",
      description: "Trigger a search to download a movie that's already in your library",
      inputSchema: {
        type: "object" as const,
        properties: {
          movieId: {
            type: "number",
            description: "Movie ID to search for",
          },
        },
        required: ["movieId"],
      },
    },
    handler: async (args) => {
      if (!clients.radarr) throw new Error("Radarr not configured");
      const movieId = (args as { movieId: number }).movieId;
      const result = await clients.radarr.searchMovie(movieId);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            message: `Search triggered for movie`,
            commandId: result.id,
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "radarr.writes",
    isWrite: true,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "radarr_refresh_movie",
      description: "Trigger a metadata refresh for a specific movie in Radarr",
      inputSchema: {
        type: "object" as const,
        properties: {
          movieId: {
            type: "number",
            description: "Movie ID to refresh",
          },
        },
        required: ["movieId"],
      },
    },
    handler: async (args) => {
      if (!clients.radarr) throw new Error("Radarr not configured");
      const movieId = (args as { movieId: number }).movieId;
      const movie = await clients.radarr.getMovieById(movieId);
      const result = await clients.radarr.refreshMovie(movieId);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            message: `Refresh triggered for movie`,
            movie: {
              id: movie.id,
              title: movie.title,
              year: movie.year,
            },
            commandId: result.id,
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "radarr.writes",
    isWrite: true,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "radarr_add_movie",
      description: "Add a movie to Radarr. Use radarr_search first to find the tmdbId, and radarr_get_root_folders / radarr_get_quality_profiles to get valid values. Use radarr_get_tags to get valid tag IDs.",
      inputSchema: {
        type: "object" as const,
        properties: {
          tmdbId: {
            type: "number",
            description: "TMDB ID from radarr_search results",
          },
          title: {
            type: "string",
            description: "Movie title",
          },
          qualityProfileId: {
            type: "number",
            description: "Quality profile ID from radarr_get_quality_profiles",
          },
          rootFolderPath: {
            type: "string",
            description: "Root folder path from radarr_get_root_folders",
          },
          monitored: {
            type: "boolean",
            description: "Whether to monitor the movie (default: true)",
          },
          minimumAvailability: {
            type: "string",
            enum: ["announced", "inCinemas", "released", "tba"],
            description: "When to consider the movie available (default: announced)",
          },
          tags: {
            type: "array",
            items: { type: "number" },
            description: "Array of tag IDs from radarr_get_tags (optional)",
          },
        },
        required: ["tmdbId", "title", "qualityProfileId", "rootFolderPath"],
      },
    },
    handler: async (args) => {
      if (!clients.radarr) throw new Error("Radarr not configured");
      const { tmdbId, title, qualityProfileId, rootFolderPath, monitored, minimumAvailability, tags } = args as {
        tmdbId: number; title: string; qualityProfileId: number; rootFolderPath: string;
        monitored?: boolean; minimumAvailability?: string; tags?: number[];
      };
      const added = await clients.radarr.addMovie({
        tmdbId, title, qualityProfileId, rootFolderPath, monitored, minimumAvailability, tags: tags ?? [],
      });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            message: `Added "${added.title}" (${added.year}) to Radarr`,
            id: added.id,
            path: added.path,
            monitored: added.monitored,
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "radarr.writes",
    isWrite: true,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "radarr_update_movie",
      description: "Update a movie in Radarr. Can change qualityProfileId, monitored status, minimumAvailability, tags, and path. Fetches the full movie object, applies your changes, and PUTs it back.",
      inputSchema: {
        type: "object" as const,
        properties: {
          movieId: {
            type: "number",
            description: "Movie ID to update",
          },
          qualityProfileId: {
            type: "number",
            description: "New quality profile ID (from radarr_get_quality_profiles)",
          },
          monitored: {
            type: "boolean",
            description: "Whether to monitor the movie",
          },
          minimumAvailability: {
            type: "string",
            enum: ["announced", "inCinemas", "released", "tba"],
            description: "When to consider the movie available",
          },
          tags: {
            type: "array",
            items: { type: "number" },
            description: "Replace all tags with this list of tag IDs",
          },
          path: {
            type: "string",
            description: "New file path for the movie",
          },
        },
        required: ["movieId"],
      },
    },
    handler: async (args) => {
      if (!clients.radarr) throw new Error("Radarr not configured");
      const { movieId, qualityProfileId, monitored, minimumAvailability, tags, path } = args as {
        movieId: number; qualityProfileId?: number; monitored?: boolean;
        minimumAvailability?: string; tags?: number[]; path?: string;
      };
      // Fetch the full movie object first
      const movie = await clients.radarr.getMovieById(movieId);
      // Apply updates
      if (qualityProfileId !== undefined) movie.qualityProfileId = qualityProfileId;
      if (monitored !== undefined) movie.monitored = monitored;
      if (minimumAvailability !== undefined) movie.minimumAvailability = minimumAvailability;
      if (tags !== undefined) movie.tags = tags;
      if (path !== undefined) movie.path = path;
      const updated = await clients.radarr.updateMovie(movie);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            message: `Updated "${updated.title}" (${updated.year})`,
            movie: {
              id: updated.id,
              title: updated.title,
              year: updated.year,
              qualityProfileId: updated.qualityProfileId,
              monitored: updated.monitored,
              minimumAvailability: updated.minimumAvailability,
              tags: updated.tags,
              path: updated.path,
            },
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "radarr.writes",
    isWrite: true,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "radarr_delete_queue_item",
      description: "Remove an item from the Radarr download queue. Use radarr_get_queue to find queue item IDs. Can optionally blocklist the release to prevent re-grabbing.",
      inputSchema: {
        type: "object" as const,
        properties: {
          queueId: {
            type: "number",
            description: "Queue item ID (from radarr_get_queue)",
          },
          removeFromClient: {
            type: "boolean",
            description: "Also remove from download client (default: true)",
          },
          blocklist: {
            type: "boolean",
            description: "Add release to blocklist to prevent re-grabbing (default: false)",
          },
        },
        required: ["queueId"],
      },
    },
    handler: async (args) => {
      if (!clients.radarr) throw new Error("Radarr not configured");
      const { queueId, removeFromClient = true, blocklist = false } = args as {
        queueId: number; removeFromClient?: boolean; blocklist?: boolean;
      };
      await clients.radarr.deleteQueueItem(queueId, { removeFromClient, blocklist });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            message: `Removed queue item ${queueId}${blocklist ? ' and added to blocklist' : ''}`,
            queueId,
            removedFromClient: removeFromClient,
            blocklisted: blocklist,
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "radarr.writes",
    isWrite: true,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "radarr_search_movies",
      description: "Trigger a search for multiple movies at once. Accepts an array of movie IDs. Use this for bulk upgrade requests instead of calling radarr_search_movie one at a time.",
      inputSchema: {
        type: "object" as const,
        properties: {
          movieIds: {
            type: "array",
            items: { type: "number" },
            description: "Array of movie IDs to search for",
          },
        },
        required: ["movieIds"],
      },
    },
    handler: async (args) => {
      if (!clients.radarr) throw new Error("Radarr not configured");
      const { movieIds } = args as { movieIds: number[] };
      if (!movieIds || movieIds.length === 0) throw new Error("movieIds array is required and must not be empty");
      const result = await clients.radarr.searchMoviesBulk(movieIds);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            message: `Search triggered for ${movieIds.length} movie(s)`,
            commandId: result.id,
            movieIds,
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "radarr.writes",
    isWrite: true,
    alwaysOn: false,
  });
}
