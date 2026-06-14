#!/usr/bin/env node
/**
 * MCP Server for *arr Media Management Suite
 *
 * Provides tools for managing Sonarr (TV), Radarr (Movies), Lidarr (Music),
 * and Prowlarr (Indexers) through Claude Code.
 *
 * Environment variables:
 * - SONARR_URL, SONARR_API_KEY
 * - RADARR_URL, RADARR_API_KEY
 * - LIDARR_URL, LIDARR_API_KEY
 * - PROWLARR_URL, PROWLARR_API_KEY
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "node:http";
import { createRequire } from "module";
import {
  SonarrClient,
  RadarrClient,
  LidarrClient,
  ProwlarrClient,
  ArrService,
} from "./arr-client.js";
import { ToolRegistry } from "./registry.js";
import { registerCoreTools } from "./tools/core.js";
import { registerSonarrTools } from "./tools/sonarr.js";
import { registerRadarrTools } from "./tools/radarr.js";
import { registerLidarrTools } from "./tools/lidarr.js";
import { registerProwlarrTools } from "./tools/prowlarr.js";
import { registerTrashTools } from "./tools/trash.js";
import { registerConfigTools } from "./tools/config.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const SERVER_VERSION: string = pkg.version;

const TRANSPORT_MODE = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();
const HTTP_HOST = process.env.HOST || "127.0.0.1";
const HTTP_PORT = Number(process.env.PORT || "3000");
const HTTP_PATH = process.env.MCP_PATH || "/mcp";

// Configuration from environment
interface ServiceConfig {
  name: ArrService;
  displayName: string;
  url?: string;
  apiKey?: string;
}

const services: ServiceConfig[] = [
  { name: 'sonarr', displayName: 'Sonarr (TV)', url: process.env.SONARR_URL, apiKey: process.env.SONARR_API_KEY },
  { name: 'radarr', displayName: 'Radarr (Movies)', url: process.env.RADARR_URL, apiKey: process.env.RADARR_API_KEY },
  { name: 'lidarr', displayName: 'Lidarr (Music)', url: process.env.LIDARR_URL, apiKey: process.env.LIDARR_API_KEY },
  { name: 'prowlarr', displayName: 'Prowlarr (Indexers)', url: process.env.PROWLARR_URL, apiKey: process.env.PROWLARR_API_KEY },
];

// Check which services are configured
const configuredServices = services.filter(s => s.url && s.apiKey);

// Initialize clients for configured services
const clients: {
  sonarr?: SonarrClient;
  radarr?: RadarrClient;
  lidarr?: LidarrClient;
  prowlarr?: ProwlarrClient;
} = {};

for (const service of configuredServices) {
  const config = { url: service.url!, apiKey: service.apiKey! };
  switch (service.name) {
    case 'sonarr':
      clients.sonarr = new SonarrClient(config);
      break;
    case 'radarr':
      clients.radarr = new RadarrClient(config);
      break;
    case 'lidarr':
      clients.lidarr = new LidarrClient(config);
      break;
    case 'prowlarr':
      clients.prowlarr = new ProwlarrClient(config);
      break;
  }
}

// Build tool registry
const registry = new ToolRegistry();

registerCoreTools(registry, clients, configuredServices, services);
if (clients.sonarr) registerSonarrTools(registry, clients);
if (clients.radarr) registerRadarrTools(registry, clients);
if (clients.lidarr) registerLidarrTools(registry, clients);
if (clients.prowlarr) registerProwlarrTools(registry, clients);
registerTrashTools(registry, clients);
registerConfigTools(registry, clients);

// Create server instance
const server = new Server(
  {
    name: "mcp-arr",
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: registry.definitions() };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await registry.dispatch(name, (args ?? {}) as Record<string, unknown>);
    return result as { content: Array<{ type: string; text: string }>; isError?: boolean };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

// Serializes HTTP request handling so the shared MCP `server` is only ever
// connected to one transport at a time (see startHttpServer for why).
let httpQueue: Promise<unknown> = Promise.resolve();
function runSerialized<T>(task: () => Promise<T>): Promise<T> {
  const result = httpQueue.then(task, task);
  httpQueue = result.catch(() => undefined);
  return result;
}

async function startHttpServer() {
  const httpServer = createServer(async (req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end("Missing URL");
      return;
    }

    const requestUrl = new URL(req.url, `http://${req.headers.host || `${HTTP_HOST}:${HTTP_PORT}`}`);

    if (requestUrl.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        version: SERVER_VERSION,
        transport: "http",
        configuredServices: configuredServices.map((service) => service.name),
      }));
      return;
    }

    if (requestUrl.pathname !== HTTP_PATH) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    // Stateless HTTP: a fresh transport per request, with no session id issued
    // (sessionIdGenerator: undefined). This lets MCP clients that do not echo the
    // Mcp-Session-Id header back — e.g. Claude Code — work, while a fresh transport
    // per request sidesteps the SDK 1.27.x "stateless transport cannot be reused"
    // guard. Handling is serialized because the shared `server` can only be
    // connected to one transport at a time.
    await runSerialized(async () => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (error) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(error instanceof Error ? error.message : String(error));
        }
      } finally {
        await transport.close();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(HTTP_PORT, HTTP_HOST, () => resolve());
  });

  console.error(`*arr MCP server running over HTTP at http://${HTTP_HOST}:${HTTP_PORT}${HTTP_PATH}`);
}

// Start the server
async function main() {
  if (TRANSPORT_MODE === "http") {
    await startHttpServer();
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`*arr MCP server running over stdio - configured services: ${configuredServices.map(s => s.name).join(', ') || 'none (TRaSH-only mode)'}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
