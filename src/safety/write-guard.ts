/**
 * Write Guard — Phase 2 safety layer for mcp-arr
 *
 * When ARR_WRITE_GUARD=on, every tool marked isWrite=true && alwaysOn=false
 * is wrapped with a guard pipeline:
 *
 *   Gate 1 — Reachability + health (fail-closed, circuit-breaker after 3 failures)
 *   Gate 2 — Queue saturation (bulk writes only)
 *   Gate 3 — Per-service cooldown
 *   Gate 4 — Checkpoint backup before bulk (non-fatal)
 *
 * Audit log: one JSON line per call (blocked or allowed) appended to auditPath.
 * Log failures are swallowed — they must never crash the server.
 */

import type { ToolRegistry } from '../registry.js';
import type { Clients } from '../tools/core.js';
// ArrClient is not imported as a separate type here because all service clients
// (SonarrClient, RadarrClient, LidarrClient, ProwlarrClient) extend ArrClient
// and carry the same method signatures. We cast to `any` to call those methods
// without creating a circular import or a type-only reference that gets erased.
import fs from 'node:fs';

export interface WriteGuardOptions {
  auditPath: string;
  /** Block bulk writes when queue length >= this. Default 50. */
  queueSaturationThreshold: number;
  /** Minimum ms between writes to the same service. Default 2000. */
  cooldownMs: number;
  /** Run a Backup command before bulk write tools. Default true. */
  checkpointBeforeBulk: boolean;
}

// Tool names that trigger queue-saturation + checkpoint gates
const BULK_WRITE_SUFFIXES = ['_search_missing', '_search_movies'];
const BULK_WRITE_EXACT = new Set(['arr_search_all']);

function isBulkWriteTool(name: string): boolean {
  if (BULK_WRITE_EXACT.has(name)) return true;
  return BULK_WRITE_SUFFIXES.some(s => name.endsWith(s));
}

// ─── Module-level guard state ─────────────────────────────────────────────────

const lastWriteTime = new Map<string, number>();
const consecutiveFailures = new Map<string, number>();

// 60-second cache of last block reason per service (used when circuit is open)
const circuitOpenSince = new Map<string, number>();
const circuitLastReason = new Map<string, string>();
const CIRCUIT_CACHE_MS = 60_000;
const CIRCUIT_OPEN_THRESHOLD = 3;

// ─── Audit logging ────────────────────────────────────────────────────────────

type AuditAction = 'allowed' | 'blocked';

interface AuditEntry {
  ts: string;
  tool: string;
  service: string;
  action: AuditAction;
  durationMs?: number;
  gate?: string;
  reason?: string;
}

function appendAudit(auditPath: string, entry: AuditEntry): void {
  try {
    fs.appendFileSync(auditPath, JSON.stringify(entry) + '\n');
  } catch {
    // Audit failure must not crash the server
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function applyWriteGuard(
  registry: ToolRegistry,
  clients: Clients,
  options: WriteGuardOptions,
): void {
  const {
    auditPath,
    queueSaturationThreshold,
    cooldownMs,
    checkpointBeforeBulk,
  } = options;

  for (const entry of registry.all()) {
    if (!entry.isWrite || entry.alwaysOn) continue;

    const originalHandler = entry.handler;
    const toolName = entry.definition.name;

    // Derive service name from capabilityGroup: "radarr.movies" → "radarr"
    const service = entry.capabilityGroup.split('.')[0];

    // Cast to any: ArrClient base class methods are accessible on all service
    // clients, but we cannot import ArrClient as a type here without risking a
    // circular dependency. The cast is safe because only registered clients
    // (Sonarr/Radarr/Lidarr/Prowlarr) appear in the Clients map.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (clients as Record<string, any>)[service];

    if (!client) {
      // No client configured for this service — leave the handler unwrapped
      continue;
    }

    const isBulkWrite = isBulkWriteTool(toolName);

    entry.handler = async (args: Record<string, unknown>): Promise<unknown> => {
      const callStart = Date.now();

      // ── Gate 1: Reachability + health (fail-closed, circuit-breaker) ─────────
      const failures = consecutiveFailures.get(service) ?? 0;
      if (failures >= CIRCUIT_OPEN_THRESHOLD) {
        const openSince = circuitOpenSince.get(service) ?? 0;
        if (Date.now() - openSince < CIRCUIT_CACHE_MS) {
          // Circuit is open and cache is still fresh — block immediately
          const reason = circuitLastReason.get(service) ?? `${service} unreachable`;
          appendAudit(auditPath, {
            ts: new Date().toISOString(),
            tool: toolName,
            service,
            action: 'blocked',
            gate: 'circuit',
            reason,
          });
          return {
            content: [{ type: 'text', text: `[WRITE_GUARD] ${reason} (circuit open, cached)` }],
            isError: true,
          };
        }
        // Cache expired — reset and probe again
        consecutiveFailures.set(service, 0);
      }

      try {
        await client.getStatus();
      } catch {
        const reason = `${service} unreachable. Write blocked fail-closed.`;
        const newFailures = (consecutiveFailures.get(service) ?? 0) + 1;
        consecutiveFailures.set(service, newFailures);
        if (newFailures >= CIRCUIT_OPEN_THRESHOLD) {
          circuitOpenSince.set(service, Date.now());
          circuitLastReason.set(service, reason);
        }
        appendAudit(auditPath, {
          ts: new Date().toISOString(),
          tool: toolName,
          service,
          action: 'blocked',
          gate: 'reachability',
          reason,
        });
        return {
          content: [{ type: 'text', text: `[WRITE_GUARD] ${reason}` }],
          isError: true,
        };
      }

      try {
        const healthItems: Array<{ type: string; message: string }> = await client.getHealth();
        const errors = healthItems.filter((h: { type: string }) => h.type === 'error');
        if (errors.length > 0) {
          const messages = errors.map((e: { message: string }) => e.message).join(', ');
          const reason = `${service} health errors: ${messages}. Write blocked fail-closed.`;
          const newFailures = (consecutiveFailures.get(service) ?? 0) + 1;
          consecutiveFailures.set(service, newFailures);
          if (newFailures >= CIRCUIT_OPEN_THRESHOLD) {
            circuitOpenSince.set(service, Date.now());
            circuitLastReason.set(service, reason);
          }
          appendAudit(auditPath, {
            ts: new Date().toISOString(),
            tool: toolName,
            service,
            action: 'blocked',
            gate: 'health',
            reason,
          });
          return {
            content: [{ type: 'text', text: `[WRITE_GUARD] ${reason}` }],
            isError: true,
          };
        }
      } catch {
        const reason = `${service} health check failed. Write blocked fail-closed.`;
        const newFailures = (consecutiveFailures.get(service) ?? 0) + 1;
        consecutiveFailures.set(service, newFailures);
        if (newFailures >= CIRCUIT_OPEN_THRESHOLD) {
          circuitOpenSince.set(service, Date.now());
          circuitLastReason.set(service, reason);
        }
        appendAudit(auditPath, {
          ts: new Date().toISOString(),
          tool: toolName,
          service,
          action: 'blocked',
          gate: 'health',
          reason,
        });
        return {
          content: [{ type: 'text', text: `[WRITE_GUARD] ${reason}` }],
          isError: true,
        };
      }

      // Gate 1 passed — reset consecutive failure counter
      consecutiveFailures.set(service, 0);

      // ── Gate 2: Queue saturation (bulk writes only) ───────────────────────────
      if (isBulkWrite) {
        try {
          const queue = await client.getQueue(1, 1);
          const total: number = queue.totalRecords ?? 0;
          if (total >= queueSaturationThreshold) {
            const reason = `queue has ${total} items (threshold: ${queueSaturationThreshold}). Bulk write blocked to avoid overload.`;
            appendAudit(auditPath, {
              ts: new Date().toISOString(),
              tool: toolName,
              service,
              action: 'blocked',
              gate: 'queue',
              reason,
            });
            return {
              content: [{ type: 'text', text: `[WRITE_GUARD] ${service} ${reason}` }],
              isError: true,
            };
          }
        } catch {
          // Queue check failure is non-fatal — log and continue
          console.error(`[write-guard] Queue check warning for ${service}: could not retrieve queue`);
        }
      }

      // ── Gate 3: Per-service cooldown ──────────────────────────────────────────
      const last = lastWriteTime.get(service);
      if (last !== undefined) {
        const elapsed = Date.now() - last;
        if (elapsed < cooldownMs) {
          const reason = `last write to ${service} was ${elapsed}ms ago (cooldown: ${cooldownMs}ms). Wait and retry.`;
          appendAudit(auditPath, {
            ts: new Date().toISOString(),
            tool: toolName,
            service,
            action: 'blocked',
            gate: 'cooldown',
            reason,
          });
          return {
            content: [{ type: 'text', text: `[WRITE_GUARD] Cooldown: ${reason}` }],
            isError: true,
          };
        }
      }

      // ── Gate 4: Checkpoint before bulk (non-fatal) ────────────────────────────
      if (checkpointBeforeBulk && isBulkWrite) {
        try {
          await client.runBackupCommand();
        } catch (e) {
          console.error('[write-guard] Checkpoint warning:', e);
          // Do NOT block — checkpoint is best-effort
        }
      }

      // ── All gates passed — record write time and execute ──────────────────────
      lastWriteTime.set(service, Date.now());
      const result = await originalHandler(args);

      appendAudit(auditPath, {
        ts: new Date().toISOString(),
        tool: toolName,
        service,
        action: 'allowed',
        durationMs: Date.now() - callStart,
      });

      return result;
    };
  }
}
