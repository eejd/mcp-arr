import type { ProwlarrClient } from "../arr-client.js";
import type { ToolRegistry } from "../registry.js";

export function registerProwlarrTools(registry: ToolRegistry, clients: { prowlarr?: ProwlarrClient }): void {
  if (!clients.prowlarr) return;

  registry.register({
    definition: {
      name: "prowlarr_get_indexers",
      description: "Get all configured indexers in Prowlarr",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    handler: async (_args) => {
      if (!clients.prowlarr) throw new Error("Prowlarr not configured");
      const indexers = await clients.prowlarr.getIndexers();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            count: indexers.length,
            indexers: indexers.map(i => ({
              id: i.id,
              name: i.name,
              protocol: i.protocol,
              enableRss: i.enableRss,
              enableAutomaticSearch: i.enableAutomaticSearch,
              enableInteractiveSearch: i.enableInteractiveSearch,
              priority: i.priority,
            })),
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "prowlarr.library",
    isWrite: false,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "prowlarr_search",
      description: "Search across all Prowlarr indexers",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Search query",
          },
        },
        required: ["query"],
      },
    },
    handler: async (args) => {
      if (!clients.prowlarr) throw new Error("Prowlarr not configured");
      const query = (args as { query: string }).query;
      const results = await clients.prowlarr.search(query);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
      };
    },
    capabilityGroup: "prowlarr.writes",
    isWrite: true,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "prowlarr_test_indexers",
      description: "Test all indexers and return their health status",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    handler: async (_args) => {
      if (!clients.prowlarr) throw new Error("Prowlarr not configured");
      const results = await clients.prowlarr.testAllIndexers();
      const indexers = await clients.prowlarr.getIndexers();
      const indexerMap = new Map(indexers.map(i => [i.id, i.name]));
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            count: results.length,
            indexers: results.map(r => ({
              id: r.id,
              name: indexerMap.get(r.id) || 'Unknown',
              isValid: r.isValid,
              errors: r.validationFailures.map(f => f.errorMessage),
            })),
            healthy: results.filter(r => r.isValid).length,
            failed: results.filter(r => !r.isValid).length,
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "prowlarr.library",
    isWrite: false,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "prowlarr_get_stats",
      description: "Get indexer statistics (queries, grabs, failures)",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    handler: async (_args) => {
      if (!clients.prowlarr) throw new Error("Prowlarr not configured");
      const stats = await clients.prowlarr.getIndexerStats();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            count: stats.indexers.length,
            indexers: stats.indexers.map(s => ({
              name: s.indexerName,
              queries: s.numberOfQueries,
              grabs: s.numberOfGrabs,
              failedQueries: s.numberOfFailedQueries,
              failedGrabs: s.numberOfFailedGrabs,
              avgResponseTime: s.averageResponseTime + 'ms',
            })),
            totals: {
              queries: stats.indexers.reduce((sum, s) => sum + s.numberOfQueries, 0),
              grabs: stats.indexers.reduce((sum, s) => sum + s.numberOfGrabs, 0),
              failedQueries: stats.indexers.reduce((sum, s) => sum + s.numberOfFailedQueries, 0),
              failedGrabs: stats.indexers.reduce((sum, s) => sum + s.numberOfFailedGrabs, 0),
            },
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "prowlarr.library",
    isWrite: false,
    alwaysOn: false,
  });
}
