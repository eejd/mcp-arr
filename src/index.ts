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
 * - ARR_TOOL_MODE=flat|progressive  (default: flat)
 *   progressive: starts with 6 discovery tools; other tools register on demand
 *               via arr_discover / arr_activate.  Requires stdio transport.
 *               Stateless HTTP always falls back to flat mode.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer, IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
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
import { registerDiscoveryTools } from "./tools/discovery.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const SERVER_VERSION: string = pkg.version;

const TRANSPORT_MODE = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();
const HTTP_HOST = process.env.HOST || "127.0.0.1";
const HTTP_PORT = Number(process.env.PORT || "3000");
const HTTP_PATH = process.env.MCP_PATH || "/mcp";

// ARR_TOOL_MODE: "flat" (default) or "progressive".
// Progressive is only honoured on stdio; HTTP always runs flat.
const ARR_TOOL_MODE_ENV = (process.env.ARR_TOOL_MODE || "flat").toLowerCase();

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

// Build tool registry (always — used by both flat and progressive modes)
const registry = new ToolRegistry();

registerCoreTools(registry, clients, configuredServices, services);
if (clients.sonarr) registerSonarrTools(registry, clients);
if (clients.radarr) registerRadarrTools(registry, clients);
if (clients.lidarr) registerLidarrTools(registry, clients);
if (clients.prowlarr) registerProwlarrTools(registry, clients);
registerTrashTools(registry, clients);
registerConfigTools(registry, clients);

// ─────────────────────────────────────────────────────────────────────────────
// WRITE GUARD — optional safety layer (ARR_WRITE_GUARD=on)
// Must run after all tools are registered and before the server is created.
// Uses top-level await (ES module with "type":"module").
// ─────────────────────────────────────────────────────────────────────────────

const WRITE_GUARD_ENABLED = (process.env.ARR_WRITE_GUARD || 'off').toLowerCase() === 'on';
if (WRITE_GUARD_ENABLED) {
  const { applyWriteGuard } = await import('./safety/write-guard.js');
  applyWriteGuard(registry, clients, {
    auditPath: process.env.ARR_AUDIT_PATH || path.join(process.cwd(), 'arr-audit.jsonl'),
    queueSaturationThreshold: Number(process.env.ARR_QUEUE_THRESHOLD || '50'),
    cooldownMs: Number(process.env.ARR_COOLDOWN_MS || '2000'),
    checkpointBeforeBulk: process.env.ARR_CHECKPOINT !== 'false',
  });
  console.error('[write-guard] ENABLED — health gate, queue gate, cooldown gate, checkpoint-before-bulk');
}

// ─────────────────────────────────────────────────────────────────────────────
// FLAT MODE — low-level Server, unchanged behaviour
// ─────────────────────────────────────────────────────────────────────────────

// Create the flat-mode server instance (also used by HTTP path regardless of
// ARR_TOOL_MODE, since stateless HTTP cannot deliver push notifications).
const flatServer = new Server(
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
flatServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: registry.definitions() };
});

// Handle tool calls
flatServer.setRequestHandler(CallToolRequestSchema, async (request) => {
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

// ─────────────────────────────────────────────────────────────────────────────
// HTTP transport — real per-session McpServer for session-aware clients,
// with a stateless fallback preserved for header-less clients.
//
// This replaces the old single shared `flatServer` + `runSerialized` mutex +
// `sessionIdGenerator: undefined` design, which caused a live outage: a
// container restart dropped the shared server, and because no session id was
// ever issued, session-aware MCP clients (e.g. the Python `mcp` package,
// which expects 2025-11-25 session semantics) had no way to detect the break
// or reconnect — every tool call silently returned empty results until the
// *client* was also restarted. Root cause + fix are tracked in issue #1.
//
// BUT: going fully stateful (as 1.6.3 did) breaks clients that never echo
// `Mcp-Session-Id` back — notably Claude Code (see CHANGELOG 1.6.5, which
// reverted 1.6.3's stateful mode for exactly this reason). Both constraints
// are real, so the two cases are told apart by peeking the JSON-RPC `method`
// on requests with no (or an unrecognised) session id:
//   - `initialize` with no session id → always issue a real Mcp-Session-Id
//     and register a dedicated McpServer for it. Header-less clients simply
//     ignore the header in the response; session-aware clients round-trip it
//     on subsequent calls and get proper isolation + restart resilience.
//   - any OTHER method with no/unrecognised session id → handled with a
//     throwaway stateless McpServer + transport for just that request,
//     identical to the 1.6.5 behaviour. This is what keeps Claude Code (and
//     a session-aware client recovering from a stale session) working.
// Each stateful session owns its own McpServer/transport pair, so concurrent
// sessions no longer serialize through a mutex.
// ─────────────────────────────────────────────────────────────────────────────

interface HttpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

const sessions = new Map<string, HttpSession>();

function createFlatMcpServer(): McpServer {
  const mcpServer = new McpServer(
    {
      name: "mcp-arr",
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // McpServer.registerTool requires Zod schemas; omitting inputSchema disables
  // SDK-level validation — args pass through as-is, matching the low-level
  // Server + registry.dispatch behaviour this replaces (see progressive
  // mode's identical pattern above for the "core" group).
  for (const entry of registry.all()) {
    mcpServer.registerTool(
      entry.definition.name,
      { description: entry.definition.description },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (args: any) => {
        const result = await entry.handler((args ?? {}) as Record<string, unknown>);
        return result as { content: Array<{ type: "text"; text: string }>; isError?: boolean };
      },
    );
  }

  return mcpServer;
}

// Creates a new stateful session: its own McpServer + StreamableHTTPServerTransport,
// registered into `sessions` once the transport issues a real session id.
function createStatefulSession(): HttpSession {
  const server = createFlatMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      sessions.set(sid, { server, transport });
    },
    onsessionclosed: (sid) => {
      sessions.delete(sid);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  return { server, transport };
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startHttpServer() {
  if (ARR_TOOL_MODE_ENV === "progressive") {
    console.error(
      "Warning: ARR_TOOL_MODE=progressive is not supported over stateless HTTP; falling back to flat mode.",
    );
  }

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
        activeSessions: sessions.size,
        configuredServices: configuredServices.map((service) => service.name),
      }));
      return;
    }

    if (requestUrl.pathname !== HTTP_PATH) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    try {
      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (existing) {
          // Known session: route to its own McpServer/transport — no mutex
          // needed, each session is independent.
          await existing.transport.handleRequest(req, res);
          return;
        }
        // Unrecognised session id (e.g. issued by a prior process before a
        // restart) — fall through to the no-session handling below so the
        // client recovers instead of hitting a permanent 404/empty loop.
      }

      if (req.method === "POST") {
        // Peek the JSON-RPC method before choosing stateful vs. stateless
        // handling — `initialize` and any other call look identical at the
        // HTTP layer once the session header is absent.
        const rawBody = await readRawBody(req);
        let parsedBody: unknown;
        try {
          parsedBody = rawBody.length ? JSON.parse(rawBody) : undefined;
        } catch {
          parsedBody = undefined;
        }
        const rpcMethod = (parsedBody as { method?: string } | undefined)?.method;

        if (rpcMethod === "initialize") {
          const session = createStatefulSession();
          await session.transport.handleRequest(req, res, parsedBody);
          return;
        }

        // Non-initialize call with no/unrecognised session id: either a
        // header-less client (Claude Code) or a session-aware client
        // recovering from a stale session. Handle with a throwaway
        // stateless transport — the 1.6.5 behaviour — rather than the SDK's
        // stateful "400 Mcp-Session-Id header is required" rejection.
        const statelessServer = createFlatMcpServer();
        const statelessTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        try {
          await statelessServer.connect(statelessTransport);
          await statelessTransport.handleRequest(req, res, parsedBody);
        } finally {
          await statelessTransport.close();
        }
        return;
      }

      // GET (SSE resume) / DELETE (session close) with no recognised
      // session: no JSON-RPC body to inspect, and neither is part of the
      // header-less-client compatibility case above — attempt a fresh
      // stateful session, which cleanly fails if the client expected an
      // existing one.
      const session = createStatefulSession();
      await session.transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(error instanceof Error ? error.message : String(error));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(HTTP_PORT, HTTP_HOST, () => resolve());
  });

  console.error(`*arr MCP server running over HTTP at http://${HTTP_HOST}:${HTTP_PORT}${HTTP_PATH} (real sessions for session-aware clients; stateless fallback preserved for header-less clients)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PROGRESSIVE MODE — McpServer with registerTool + tools/list_changed
// ─────────────────────────────────────────────────────────────────────────────

async function startProgressiveStdio() {
  // McpServer auto-fires tools/list_changed whenever registerTool is called.
  const mcpServer = new McpServer(
    {
      name: "mcp-arr",
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: { listChanged: true },
      },
    },
  );

  // Set of configured service names for discovery metadata.
  const configuredServiceNames = new Set(configuredServices.map(s => s.name as string));

  // Register the 4 always-on "core" tools via McpServer so they appear at startup.
  // McpServer.registerTool requires Zod schemas; omitting inputSchema disables
  // SDK-level validation — args pass through as-is, same as flat mode.
  for (const entry of registry.byGroup("core")) {
    mcpServer.registerTool(
      entry.definition.name,
      { description: entry.definition.description },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (args: any) => {
        const result = await entry.handler(args as Record<string, unknown>);
        return result as { content: Array<{ type: "text"; text: string }>; isError?: boolean };
      },
    );
  }

  // Register arr_discover and arr_activate (always visible in progressive mode).
  registerDiscoveryTools(mcpServer, registry, configuredServiceNames);

  // Connect via the underlying low-level Server (McpServer.server).
  const transport = new StdioServerTransport();
  await mcpServer.server.connect(transport);

  console.error(
    `*arr MCP server running in PROGRESSIVE mode over stdio` +
    ` - configured services: ${configuredServices.map(s => s.name).join(', ') || 'none (TRaSH-only mode)'}` +
    ` - initial tools: arr_status, search, fetch, arr_search_all, arr_discover, arr_activate`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  if (TRANSPORT_MODE === "http") {
    await startHttpServer();
    return;
  }

  // stdio: honour ARR_TOOL_MODE
  if (ARR_TOOL_MODE_ENV === "progressive") {
    await startProgressiveStdio();
    return;
  }

  // Default: flat mode over stdio
  const transport = new StdioServerTransport();
  await flatServer.connect(transport);
  console.error(`*arr MCP server running over stdio - configured services: ${configuredServices.map(s => s.name).join(', ') || 'none (TRaSH-only mode)'}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
