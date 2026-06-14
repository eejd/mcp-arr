import type { SonarrClient, RadarrClient, LidarrClient } from "../arr-client.js";
import type { ToolRegistry } from "../registry.js";

type ConfigClients = {
  sonarr?: SonarrClient;
  radarr?: RadarrClient;
  lidarr?: LidarrClient;
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function registerConfigTools(registry: ToolRegistry, clients: ConfigClients): void {
  const services: Array<{ name: 'sonarr' | 'radarr' | 'lidarr'; displayName: string }> = [];
  if (clients.sonarr) services.push({ name: 'sonarr', displayName: 'Sonarr (TV)' });
  if (clients.radarr) services.push({ name: 'radarr', displayName: 'Radarr (Movies)' });
  if (clients.lidarr) services.push({ name: 'lidarr', displayName: 'Lidarr (Music)' });

  for (const { name: serviceName, displayName } of services) {
    // get_quality_profiles
    registry.register({
      definition: {
        name: `${serviceName}_get_quality_profiles`,
        description: `Get detailed quality profiles from ${displayName}. Shows allowed qualities, upgrade settings, and custom format scores.`,
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: [],
        },
      },
      handler: async (_args) => {
        const client = clients[serviceName];
        if (!client) throw new Error(`${serviceName} not configured`);
        const profiles = await client.getQualityProfiles();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              count: profiles.length,
              profiles: profiles.map(p => ({
                id: p.id,
                name: p.name,
                upgradeAllowed: p.upgradeAllowed,
                cutoff: p.cutoff,
                allowedQualities: p.items
                  .filter(i => i.allowed)
                  .map(i => i.quality?.name || i.name || (i.items?.map(q => q.quality.name).join(', ')))
                  .filter(Boolean),
                customFormats: p.formatItems?.filter(f => f.score !== 0).map(f => ({
                  name: f.name,
                  score: f.score,
                })) || [],
                minFormatScore: p.minFormatScore,
                cutoffFormatScore: p.cutoffFormatScore,
              })),
            }, null, 2),
          }],
        };
      },
      capabilityGroup: `${serviceName}.config`,
      isWrite: false,
      alwaysOn: false,
    });

    // get_health
    registry.register({
      definition: {
        name: `${serviceName}_get_health`,
        description: `Get health check warnings and issues from ${displayName}. Shows any problems detected by the application.`,
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: [],
        },
      },
      handler: async (_args) => {
        const client = clients[serviceName];
        if (!client) throw new Error(`${serviceName} not configured`);
        const health = await client.getHealth();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              issueCount: health.length,
              issues: health.map(h => ({
                source: h.source,
                type: h.type,
                message: h.message,
                wikiUrl: h.wikiUrl,
              })),
              status: health.length === 0 ? 'healthy' : 'issues detected',
            }, null, 2),
          }],
        };
      },
      capabilityGroup: `${serviceName}.config`,
      isWrite: false,
      alwaysOn: false,
    });

    // get_root_folders
    registry.register({
      definition: {
        name: `${serviceName}_get_root_folders`,
        description: `Get root folders and storage info from ${displayName}. Shows paths, free space, and unmapped folders.`,
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: [],
        },
      },
      handler: async (_args) => {
        const client = clients[serviceName];
        if (!client) throw new Error(`${serviceName} not configured`);
        const folders = await client.getRootFoldersDetailed();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              count: folders.length,
              folders: folders.map(f => ({
                id: f.id,
                path: f.path,
                accessible: f.accessible,
                freeSpace: formatBytes(f.freeSpace),
                freeSpaceBytes: f.freeSpace,
                unmappedFolders: f.unmappedFolders?.length || 0,
              })),
            }, null, 2),
          }],
        };
      },
      capabilityGroup: `${serviceName}.config`,
      isWrite: false,
      alwaysOn: false,
    });

    // get_download_clients
    registry.register({
      definition: {
        name: `${serviceName}_get_download_clients`,
        description: `Get download client configurations from ${displayName}. Shows configured clients and their settings.`,
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: [],
        },
      },
      handler: async (_args) => {
        const client = clients[serviceName];
        if (!client) throw new Error(`${serviceName} not configured`);
        const downloadClients = await client.getDownloadClients();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              count: downloadClients.length,
              clients: downloadClients.map(c => ({
                id: c.id,
                name: c.name,
                implementation: c.implementationName,
                protocol: c.protocol,
                enabled: c.enable,
                priority: c.priority,
                removeCompletedDownloads: c.removeCompletedDownloads,
                removeFailedDownloads: c.removeFailedDownloads,
                tags: c.tags,
              })),
            }, null, 2),
          }],
        };
      },
      capabilityGroup: `${serviceName}.config`,
      isWrite: false,
      alwaysOn: false,
    });

    // get_naming
    registry.register({
      definition: {
        name: `${serviceName}_get_naming`,
        description: `Get file naming configuration from ${displayName}. Shows naming patterns for files and folders.`,
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: [],
        },
      },
      handler: async (_args) => {
        const client = clients[serviceName];
        if (!client) throw new Error(`${serviceName} not configured`);
        const naming = await client.getNamingConfig();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(naming, null, 2),
          }],
        };
      },
      capabilityGroup: `${serviceName}.config`,
      isWrite: false,
      alwaysOn: false,
    });

    // get_tags
    registry.register({
      definition: {
        name: `${serviceName}_get_tags`,
        description: `Get all tags defined in ${displayName}. Tags can be used to organize and filter content.`,
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: [],
        },
      },
      handler: async (_args) => {
        const client = clients[serviceName];
        if (!client) throw new Error(`${serviceName} not configured`);
        const tags = await client.getTags();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              count: tags.length,
              tags: tags.map(t => ({ id: t.id, label: t.label })),
            }, null, 2),
          }],
        };
      },
      capabilityGroup: `${serviceName}.config`,
      isWrite: false,
      alwaysOn: false,
    });

    // review_setup
    registry.register({
      definition: {
        name: `${serviceName}_review_setup`,
        description: `Get comprehensive configuration review for ${displayName}. Returns all settings for analysis: quality profiles, download clients, naming, storage, indexers, health warnings, and more. Use this to analyze the setup and suggest improvements.`,
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: [],
        },
      },
      handler: async (_args) => {
        const client = clients[serviceName];
        if (!client) throw new Error(`${serviceName} not configured`);

        // Gather all configuration data
        const [status, health, qualityProfiles, qualityDefinitions, downloadClients, naming, mediaManagement, rootFolders, tags, indexers] = await Promise.all([
          client.getStatus(),
          client.getHealth(),
          client.getQualityProfiles(),
          client.getQualityDefinitions(),
          client.getDownloadClients(),
          client.getNamingConfig(),
          client.getMediaManagement(),
          client.getRootFoldersDetailed(),
          client.getTags(),
          client.getIndexers(),
        ]);

        // For Lidarr, also get metadata profiles
        let metadataProfiles = null;
        if (serviceName === 'lidarr' && clients.lidarr) {
          metadataProfiles = await clients.lidarr.getMetadataProfiles();
        }

        const review = {
          service: serviceName,
          version: status.version,
          appName: status.appName,
          platform: {
            os: status.osName,
            isDocker: status.isDocker,
          },
          health: {
            issueCount: health.length,
            issues: health,
          },
          storage: {
            rootFolders: rootFolders.map(f => ({
              path: f.path,
              accessible: f.accessible,
              freeSpace: formatBytes(f.freeSpace),
              freeSpaceBytes: f.freeSpace,
              unmappedFolderCount: f.unmappedFolders?.length || 0,
            })),
          },
          qualityProfiles: qualityProfiles.map(p => ({
            id: p.id,
            name: p.name,
            upgradeAllowed: p.upgradeAllowed,
            cutoff: p.cutoff,
            allowedQualities: p.items
              .filter(i => i.allowed)
              .map(i => i.quality?.name || i.name || (i.items?.map(q => q.quality.name).join(', ')))
              .filter(Boolean),
            customFormatsWithScores: p.formatItems?.filter(f => f.score !== 0).length || 0,
            minFormatScore: p.minFormatScore,
          })),
          qualityDefinitions: qualityDefinitions.map(d => ({
            quality: d.quality.name,
            minSize: d.minSize + ' MB/min',
            maxSize: d.maxSize === 0 ? 'unlimited' : d.maxSize + ' MB/min',
            preferredSize: d.preferredSize + ' MB/min',
          })),
          downloadClients: downloadClients.map(c => ({
            name: c.name,
            type: c.implementationName,
            protocol: c.protocol,
            enabled: c.enable,
            priority: c.priority,
          })),
          indexers: indexers.map(i => ({
            name: i.name,
            protocol: i.protocol,
            enableRss: i.enableRss,
            enableAutomaticSearch: i.enableAutomaticSearch,
            enableInteractiveSearch: i.enableInteractiveSearch,
            priority: i.priority,
          })),
          naming: naming,
          mediaManagement: {
            recycleBin: mediaManagement.recycleBin || 'not set',
            recycleBinCleanupDays: mediaManagement.recycleBinCleanupDays,
            downloadPropersAndRepacks: mediaManagement.downloadPropersAndRepacks,
            deleteEmptyFolders: mediaManagement.deleteEmptyFolders,
            copyUsingHardlinks: mediaManagement.copyUsingHardlinks,
            importExtraFiles: mediaManagement.importExtraFiles,
            extraFileExtensions: mediaManagement.extraFileExtensions,
          },
          tags: tags.map(t => t.label),
          ...(metadataProfiles && { metadataProfiles }),
        };

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(review, null, 2),
          }],
        };
      },
      capabilityGroup: `${serviceName}.config`,
      isWrite: false,
      alwaysOn: false,
    });
  }
}
