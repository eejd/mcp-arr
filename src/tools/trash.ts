import { trashClient } from "../trash-client.js";
import type { TrashService } from "../trash-client.js";
import type { SonarrClient, RadarrClient } from "../arr-client.js";
import type { ToolRegistry } from "../registry.js";

type TrashClients = {
  sonarr?: SonarrClient;
  radarr?: RadarrClient;
};

export function registerTrashTools(registry: ToolRegistry, clients: TrashClients): void {
  registry.register({
    definition: {
      name: "trash_list_profiles",
      description: "List available TRaSH Guides quality profiles for Radarr or Sonarr. Shows recommended profiles for different use cases (1080p, 4K, Remux, etc.)",
      inputSchema: {
        type: "object" as const,
        properties: {
          service: {
            type: "string",
            enum: ["radarr", "sonarr"],
            description: "Which service to get profiles for",
          },
        },
        required: ["service"],
      },
    },
    handler: async (args) => {
      const service = (args as { service: TrashService }).service;
      const profiles = await trashClient.listProfiles(service);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            service,
            count: profiles.length,
            profiles: profiles.map(p => ({
              name: p.name,
              description: p.description?.replace(/<br>/g, ' ') || 'No description',
            })),
            usage: "Use trash_get_profile to see full details for a specific profile",
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "trash",
    isWrite: false,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "trash_get_profile",
      description: "Get a specific TRaSH Guides quality profile with all custom format scores, quality settings, and implementation details",
      inputSchema: {
        type: "object" as const,
        properties: {
          service: {
            type: "string",
            enum: ["radarr", "sonarr"],
            description: "Which service",
          },
          profile: {
            type: "string",
            description: "Profile name (e.g., 'remux-web-1080p', 'uhd-bluray-web', 'hd-bluray-web')",
          },
        },
        required: ["service", "profile"],
      },
    },
    handler: async (args) => {
      const { service, profile: profileName } = args as { service: TrashService; profile: string };
      const profile = await trashClient.getProfile(service, profileName);
      if (!profile) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: `Profile '${profileName}' not found for ${service}`,
              hint: "Use trash_list_profiles to see available profiles",
            }, null, 2),
          }],
          isError: true,
        };
      }
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            name: profile.name,
            description: profile.trash_description?.replace(/<br>/g, '\n'),
            trash_id: profile.trash_id,
            upgradeAllowed: profile.upgradeAllowed,
            cutoff: profile.cutoff,
            minFormatScore: profile.minFormatScore,
            cutoffFormatScore: profile.cutoffFormatScore,
            language: profile.language,
            qualities: profile.items.map(i => ({
              name: i.name,
              allowed: i.allowed,
              items: i.items,
            })),
            customFormats: Object.entries(profile.formatItems || {}).map(([name, trashId]) => ({
              name,
              trash_id: trashId,
            })),
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "trash",
    isWrite: false,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "trash_list_custom_formats",
      description: "List available TRaSH Guides custom formats. Can filter by category: hdr, audio, resolution, source, streaming, anime, unwanted, release, language",
      inputSchema: {
        type: "object" as const,
        properties: {
          service: {
            type: "string",
            enum: ["radarr", "sonarr"],
            description: "Which service",
          },
          category: {
            type: "string",
            description: "Optional filter by category",
          },
        },
        required: ["service"],
      },
    },
    handler: async (args) => {
      const { service, category } = args as { service: TrashService; category?: string };
      const formats = await trashClient.listCustomFormats(service, category);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            service,
            category: category || 'all',
            count: formats.length,
            formats: formats.slice(0, 50).map(f => ({
              name: f.name,
              categories: f.categories,
              defaultScore: f.defaultScore,
            })),
            note: formats.length > 50 ? `Showing first 50 of ${formats.length}. Use category filter to narrow results.` : undefined,
            availableCategories: ['hdr', 'audio', 'resolution', 'source', 'streaming', 'anime', 'unwanted', 'release', 'language'],
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "trash",
    isWrite: false,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "trash_get_naming",
      description: "Get TRaSH Guides recommended naming conventions for your media server (Plex, Emby, Jellyfin, or standard)",
      inputSchema: {
        type: "object" as const,
        properties: {
          service: {
            type: "string",
            enum: ["radarr", "sonarr"],
            description: "Which service",
          },
          mediaServer: {
            type: "string",
            enum: ["plex", "emby", "jellyfin", "standard"],
            description: "Which media server you use",
          },
        },
        required: ["service", "mediaServer"],
      },
    },
    handler: async (args) => {
      const { service, mediaServer } = args as { service: TrashService; mediaServer: string };
      const naming = await trashClient.getNaming(service);
      if (!naming) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: `Could not fetch naming conventions for ${service}` }, null, 2),
          }],
          isError: true,
        };
      }

      // Map media server to naming key
      const serverMap: Record<string, { folder: string; file: string }> = {
        plex: { folder: 'plex-imdb', file: 'plex-imdb' },
        emby: { folder: 'emby-imdb', file: 'emby-imdb' },
        jellyfin: { folder: 'jellyfin-imdb', file: 'jellyfin-imdb' },
        standard: { folder: 'default', file: 'standard' },
      };

      const keys = serverMap[mediaServer] || serverMap.standard;

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            service,
            mediaServer,
            recommended: {
              folder: naming.folder[keys.folder] || naming.folder.default,
              file: naming.file[keys.file] || naming.file.standard,
              ...(naming.season && { season: naming.season[keys.folder] || naming.season.default }),
              ...(naming.series && { series: naming.series[keys.folder] || naming.series.default }),
            },
            allFolderOptions: Object.keys(naming.folder),
            allFileOptions: Object.keys(naming.file),
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "trash",
    isWrite: false,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "trash_get_quality_sizes",
      description: "Get TRaSH Guides recommended min/max/preferred sizes for each quality level",
      inputSchema: {
        type: "object" as const,
        properties: {
          service: {
            type: "string",
            enum: ["radarr", "sonarr"],
            description: "Which service",
          },
          type: {
            type: "string",
            description: "Content type: 'movie', 'anime' for Radarr; 'series', 'anime' for Sonarr",
          },
        },
        required: ["service"],
      },
    },
    handler: async (args) => {
      const { service, type } = args as { service: TrashService; type?: string };
      const sizes = await trashClient.getQualitySizes(service, type);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            service,
            type: type || 'all',
            profiles: sizes.map(s => ({
              type: s.type,
              qualities: s.qualities.map(q => ({
                quality: q.quality,
                min: q.min + ' MB/min',
                preferred: q.preferred === 1999 ? 'unlimited' : q.preferred + ' MB/min',
                max: q.max === 2000 ? 'unlimited' : q.max + ' MB/min',
              })),
            })),
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "trash",
    isWrite: false,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "trash_compare_profile",
      description: "Compare your quality profile against TRaSH Guides recommendations. Shows missing custom formats, scoring differences, and quality settings. Requires the corresponding *arr service to be configured.",
      inputSchema: {
        type: "object" as const,
        properties: {
          service: {
            type: "string",
            enum: ["radarr", "sonarr"],
            description: "Which service",
          },
          profileId: {
            type: "number",
            description: "Your quality profile ID to compare",
          },
          trashProfile: {
            type: "string",
            description: "TRaSH profile name to compare against",
          },
        },
        required: ["service", "profileId", "trashProfile"],
      },
    },
    handler: async (args) => {
      const { service, profileId, trashProfile } = args as {
        service: TrashService;
        profileId: number;
        trashProfile: string;
      };

      // Get client
      const client = service === 'radarr' ? clients.radarr : clients.sonarr;
      if (!client) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: `${service} not configured. Cannot compare profiles.` }, null, 2),
          }],
          isError: true,
        };
      }

      // Fetch both profiles
      const [userProfiles, trashProfileData] = await Promise.all([
        client.getQualityProfiles(),
        trashClient.getProfile(service, trashProfile),
      ]);

      const userProfile = userProfiles.find(p => p.id === profileId);
      if (!userProfile) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: `Profile ID ${profileId} not found`,
              availableProfiles: userProfiles.map(p => ({ id: p.id, name: p.name })),
            }, null, 2),
          }],
          isError: true,
        };
      }

      if (!trashProfileData) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: `TRaSH profile '${trashProfile}' not found`,
              hint: "Use trash_list_profiles to see available profiles",
            }, null, 2),
          }],
          isError: true,
        };
      }

      // Compare qualities
      const userQualities = new Set<string>(
        userProfile.items
          .filter(i => i.allowed)
          .map(i => i.quality?.name || i.name)
          .filter((n): n is string => n !== undefined)
      );
      const trashQualities = new Set<string>(
        trashProfileData.items
          .filter(i => i.allowed)
          .map(i => i.name)
      );

      const qualityComparison = {
        matching: [...userQualities].filter(q => trashQualities.has(q)),
        missingFromYours: [...trashQualities].filter(q => !userQualities.has(q)),
        extraInYours: [...userQualities].filter(q => !trashQualities.has(q)),
      };

      // Compare custom formats
      const userCFNames = new Set(
        (userProfile.formatItems || [])
          .filter(f => f.score !== 0)
          .map(f => f.name)
      );
      const trashCFNames = new Set(Object.keys(trashProfileData.formatItems || {}));

      const cfComparison = {
        matching: [...userCFNames].filter(cf => trashCFNames.has(cf)),
        missingFromYours: [...trashCFNames].filter(cf => !userCFNames.has(cf)),
        extraInYours: [...userCFNames].filter(cf => !trashCFNames.has(cf)),
      };

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            yourProfile: {
              name: userProfile.name,
              id: userProfile.id,
              upgradeAllowed: userProfile.upgradeAllowed,
              cutoff: userProfile.cutoff,
            },
            trashProfile: {
              name: trashProfileData.name,
              upgradeAllowed: trashProfileData.upgradeAllowed,
              cutoff: trashProfileData.cutoff,
            },
            qualityComparison,
            customFormatComparison: cfComparison,
            recommendations: [
              ...(qualityComparison.missingFromYours.length > 0
                ? [`Enable these qualities: ${qualityComparison.missingFromYours.join(', ')}`]
                : []),
              ...(cfComparison.missingFromYours.length > 0
                ? [`Add these custom formats: ${cfComparison.missingFromYours.slice(0, 5).join(', ')}${cfComparison.missingFromYours.length > 5 ? ` and ${cfComparison.missingFromYours.length - 5} more` : ''}`]
                : []),
              ...(userProfile.upgradeAllowed !== trashProfileData.upgradeAllowed
                ? [`Set upgradeAllowed to ${trashProfileData.upgradeAllowed}`]
                : []),
            ],
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "trash",
    isWrite: false,
    alwaysOn: false,
  });

  registry.register({
    definition: {
      name: "trash_compare_naming",
      description: "Compare your naming configuration against TRaSH Guides recommendations. Requires the corresponding *arr service to be configured.",
      inputSchema: {
        type: "object" as const,
        properties: {
          service: {
            type: "string",
            enum: ["radarr", "sonarr"],
            description: "Which service",
          },
          mediaServer: {
            type: "string",
            enum: ["plex", "emby", "jellyfin", "standard"],
            description: "Which media server you use",
          },
        },
        required: ["service", "mediaServer"],
      },
    },
    handler: async (args) => {
      const { service, mediaServer } = args as { service: TrashService; mediaServer: string };

      // Get client
      const client = service === 'radarr' ? clients.radarr : clients.sonarr;
      if (!client) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: `${service} not configured. Cannot compare naming.` }, null, 2),
          }],
          isError: true,
        };
      }

      // Fetch both
      const [userNaming, trashNaming] = await Promise.all([
        client.getNamingConfig(),
        trashClient.getNaming(service),
      ]);

      if (!trashNaming) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: `Could not fetch TRaSH naming for ${service}` }, null, 2),
          }],
          isError: true,
        };
      }

      // Map media server to naming key
      const serverMap: Record<string, { folder: string; file: string }> = {
        plex: { folder: 'plex-imdb', file: 'plex-imdb' },
        emby: { folder: 'emby-imdb', file: 'emby-imdb' },
        jellyfin: { folder: 'jellyfin-imdb', file: 'jellyfin-imdb' },
        standard: { folder: 'default', file: 'standard' },
      };

      const keys = serverMap[mediaServer] || serverMap.standard;
      const recommendedFolder = trashNaming.folder[keys.folder] || trashNaming.folder.default;
      const recommendedFile = trashNaming.file[keys.file] || trashNaming.file.standard;

      // Extract user's current naming (field names vary by service)
      const namingRecord = userNaming as unknown as Record<string, unknown>;
      const userFolder = namingRecord.movieFolderFormat ||
        namingRecord.seriesFolderFormat ||
        namingRecord.standardMovieFormat;
      const userFile = namingRecord.standardMovieFormat ||
        namingRecord.standardEpisodeFormat;

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            mediaServer,
            yourNaming: {
              folder: userFolder,
              file: userFile,
            },
            trashRecommended: {
              folder: recommendedFolder,
              file: recommendedFile,
            },
            folderMatch: userFolder === recommendedFolder,
            fileMatch: userFile === recommendedFile,
            recommendations: [
              ...(userFolder !== recommendedFolder ? [`Update folder format to: ${recommendedFolder}`] : []),
              ...(userFile !== recommendedFile ? [`Update file format to: ${recommendedFile}`] : []),
            ],
          }, null, 2),
        }],
      };
    },
    capabilityGroup: "trash",
    isWrite: false,
    alwaysOn: false,
  });
}
