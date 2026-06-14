import type { SonarrClient, RadarrClient, LidarrClient, ProwlarrClient } from "../arr-client.js";
import { trashClient } from "../trash-client.js";
import type { ToolRegistry } from "../registry.js";

export type Clients = {
  sonarr?: SonarrClient;
  radarr?: RadarrClient;
  lidarr?: LidarrClient;
  prowlarr?: ProwlarrClient;
};

type ServiceConfig = {
  name: keyof Clients;
  displayName: string;
};

type SearchEntry = {
  id: string;
  title: string;
  url: string;
  type: string;
  service: string;
  summary?: string;
};

function buildResourceUrl(path: string): string {
  return `mcp-arr://${path}`;
}

export async function runUnifiedSearch(query: string, clients: Clients): Promise<SearchEntry[]> {
  const results: SearchEntry[] = [];
  const trimmedQuery = query.trim();

  if (trimmedQuery.length === 0) {
    return results;
  }

  const lowerQuery = trimmedQuery.toLowerCase();

  for (const service of ["radarr", "sonarr"] as const) {
    const profiles = await trashClient.listProfiles(service);
    results.push(
      ...profiles
        .filter((profile) =>
          profile.name.toLowerCase().includes(lowerQuery) ||
          profile.description?.toLowerCase().includes(lowerQuery)
        )
        .slice(0, 8)
        .map((profile) => ({
          id: `trash-profile:${service}:${profile.name}`,
          title: `${profile.name} (${service})`,
          url: buildResourceUrl(`trash/profile/${service}/${encodeURIComponent(profile.name)}`),
          type: "trash_profile",
          service,
          summary: profile.description?.replace(/<br>/g, " "),
        }))
    );
  }

  if (clients.sonarr) {
    const series = await clients.sonarr.searchSeries(trimmedQuery);
    results.push(
      ...series.slice(0, 5).map((item) => ({
        id: `arr:sonarr:series:${item.tvdbId}`,
        title: `${item.title}${item.year ? ` (${item.year})` : ""}`,
        url: buildResourceUrl(`arr/sonarr/series/${item.tvdbId}`),
        type: "series",
        service: "sonarr",
        summary: item.overview?.slice(0, 220),
      }))
    );
  }

  if (clients.radarr) {
    const movies = await clients.radarr.searchMovies(trimmedQuery);
    results.push(
      ...movies.slice(0, 5).map((item) => ({
        id: `arr:radarr:movie:${item.tmdbId}`,
        title: `${item.title}${item.year ? ` (${item.year})` : ""}`,
        url: buildResourceUrl(`arr/radarr/movie/${item.tmdbId}`),
        type: "movie",
        service: "radarr",
        summary: item.overview?.slice(0, 220),
      }))
    );
  }

  if (clients.lidarr) {
    const artists = await clients.lidarr.searchArtists(trimmedQuery);
    results.push(
      ...artists.slice(0, 5).map((item) => ({
        id: `arr:lidarr:artist:${item.foreignArtistId}`,
        title: item.artistName || item.title,
        url: buildResourceUrl(`arr/lidarr/artist/${item.foreignArtistId}`),
        type: "artist",
        service: "lidarr",
        summary: item.overview?.slice(0, 220),
      }))
    );
  }

  return results;
}

export async function fetchSearchEntry(id: string, clients: Clients): Promise<unknown> {
  const [kind, service, subtype, rawId] = id.split(":");

  if (kind === "trash-profile" && (service === "radarr" || service === "sonarr")) {
    const profile = await trashClient.getProfile(service as "radarr" | "sonarr", rawId);
    if (!profile) {
      throw new Error(`TRaSH profile '${rawId}' not found for ${service}`);
    }

    return {
      id,
      title: `${profile.name} (${service})`,
      url: buildResourceUrl(`trash/profile/${service}/${encodeURIComponent(profile.name)}`),
      service,
      type: "trash_profile",
      data: {
        name: profile.name,
        description: profile.trash_description?.replace(/<br>/g, "\n"),
        upgradeAllowed: profile.upgradeAllowed,
        cutoff: profile.cutoff,
        minFormatScore: profile.minFormatScore,
        cutoffFormatScore: profile.cutoffFormatScore,
        language: profile.language,
        qualities: profile.items,
        customFormats: Object.entries(profile.formatItems || {}).map(([name, trashId]) => ({
          name,
          trash_id: trashId,
        })),
      },
    };
  }

  if (kind !== "arr") {
    throw new Error(`Unsupported fetch id '${id}'`);
  }

  if (service === "sonarr" && subtype === "series" && clients.sonarr) {
    const tvdbId = Number(rawId);
    const matches = (await clients.sonarr.searchSeries(rawId)).filter((item) => item.tvdbId === tvdbId);
    return {
      id,
      title: matches[0]?.title || rawId,
      url: buildResourceUrl(`arr/sonarr/series/${rawId}`),
      service,
      type: subtype,
      data: matches.slice(0, 10),
    };
  }

  if (service === "radarr" && subtype === "movie" && clients.radarr) {
    const tmdbId = Number(rawId);
    const matches = (await clients.radarr.searchMovies(rawId)).filter((item) => item.tmdbId === tmdbId);
    return {
      id,
      title: matches[0]?.title || rawId,
      url: buildResourceUrl(`arr/radarr/movie/${rawId}`),
      service,
      type: subtype,
      data: matches.slice(0, 10),
    };
  }

  if (service === "lidarr" && subtype === "artist" && clients.lidarr) {
    const matches = (await clients.lidarr.searchArtists(rawId)).filter((item) => item.foreignArtistId === rawId);
    return {
      id,
      title: matches[0]?.artistName || matches[0]?.title || rawId,
      url: buildResourceUrl(`arr/lidarr/artist/${rawId}`),
      service,
      type: subtype,
      data: matches.slice(0, 10),
    };
  }

  throw new Error(`Unsupported or unavailable fetch target '${id}'`);
}

export function registerCoreTools(
  registry: ToolRegistry,
  clients: Clients,
  configuredServices: ServiceConfig[],
  services: ServiceConfig[],
): void {
  // arr_status
  registry.register({
    definition: {
      name: "arr_status",
      description: configuredServices.length > 0
        ? `Get status of all configured *arr services. Currently configured: ${configuredServices.map(s => s.displayName).join(', ')}`
        : "Get status of all supported *arr services. No local *arr services are currently configured, but TRaSH reference tools remain available.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    handler: async (_args) => {
      const statuses: Record<string, unknown> = {};
      for (const service of configuredServices) {
        try {
          const client = clients[service.name];
          if (client) {
            const status = await client.getStatus();
            statuses[service.name] = {
              configured: true,
              connected: true,
              version: status.version,
              appName: status.appName,
            };
          }
        } catch (error) {
          statuses[service.name] = {
            configured: true,
            connected: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      // Add unconfigured services
      for (const service of services) {
        if (!statuses[service.name]) {
          statuses[service.name] = { configured: false };
        }
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(statuses, null, 2) }],
      };
    },
    capabilityGroup: "core",
    isWrite: false,
    alwaysOn: true,
  });

  // search
  registry.register({
    definition: {
      name: "search",
      description: "Search across configured *arr libraries plus TRaSH Guides reference profiles. This is the primary discovery tool for remote MCP clients such as ChatGPT.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Natural-language search query",
          },
        },
        required: ["query"],
      },
    },
    handler: async (args) => {
      const query = (args as { query: string }).query;
      const results = await runUnifiedSearch(query, clients);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ results }, null, 2) }],
      };
    },
    capabilityGroup: "core",
    isWrite: false,
    alwaysOn: true,
  });

  // fetch
  registry.register({
    definition: {
      name: "fetch",
      description: "Fetch a specific item returned by search. Accepts an opaque item id from the search tool.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "string",
            description: "Opaque result id returned by search",
          },
        },
        required: ["id"],
      },
    },
    handler: async (args) => {
      const id = (args as { id: string }).id;
      const result = await fetchSearchEntry(id, clients);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
    capabilityGroup: "core",
    isWrite: false,
    alwaysOn: true,
  });

  // arr_search_all
  registry.register({
    definition: {
      name: "arr_search_all",
      description: "Search across all configured *arr services for any media",
      inputSchema: {
        type: "object" as const,
        properties: {
          term: {
            type: "string",
            description: "Search term",
          },
        },
        required: ["term"],
      },
    },
    handler: async (args) => {
      const term = (args as { term: string }).term;
      const results: Record<string, unknown> = {};

      if (clients.sonarr) {
        try {
          const sonarrResults = await clients.sonarr.searchSeries(term);
          results.sonarr = { count: sonarrResults.length, results: sonarrResults.slice(0, 5) };
        } catch (e) {
          results.sonarr = { error: e instanceof Error ? e.message : String(e) };
        }
      }

      if (clients.radarr) {
        try {
          const radarrResults = await clients.radarr.searchMovies(term);
          results.radarr = { count: radarrResults.length, results: radarrResults.slice(0, 5) };
        } catch (e) {
          results.radarr = { error: e instanceof Error ? e.message : String(e) };
        }
      }

      if (clients.lidarr) {
        try {
          const lidarrResults = await clients.lidarr.searchArtists(term);
          results.lidarr = { count: lidarrResults.length, results: lidarrResults.slice(0, 5) };
        } catch (e) {
          results.lidarr = { error: e instanceof Error ? e.message : String(e) };
        }
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
      };
    },
    capabilityGroup: "core",
    isWrite: false,
    alwaysOn: true,
  });
}
