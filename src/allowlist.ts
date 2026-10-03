/**
 * Tool allowlist (MCP_ARR_TOOLS) — run a restricted instance, e.g. read-only.
 *
 * The *arr APIs have no read-only keys, so the restriction lives here. It prunes
 * the ToolRegistry once, after registration, which is the single source for
 * tools/list and tools/call on every transport, so a client that guesses a
 * hidden name gets "Unknown tool" rather than a dispatch.
 */

import type { ToolRegistry } from "./registry.js";

/** Parse a comma-separated list. Unset/empty/blank means "all tools" (null). */
export function parseToolAllowlist(raw: string | undefined): Set<string> | null {
  if (raw === undefined) return null;
  const names = raw
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  return names.length === 0 ? null : new Set(names);
}

/**
 * Remove every registered tool not in `allow`. Throws if `allow` names a tool
 * that is not registered, so a typo can never silently widen or empty the set.
 * Returns the surviving tool names (sorted). `null` leaves the registry as is.
 */
export function applyToolAllowlist(
  registry: ToolRegistry,
  allow: Set<string> | null,
): string[] {
  const registered = registry.all().map((e) => e.definition.name);
  if (allow === null) return registered.sort();

  const known = new Set(registered);
  const unknown = [...allow].filter((n) => !known.has(n)).sort();
  if (unknown.length > 0) {
    throw new Error(
      `MCP_ARR_TOOLS names unknown tool(s): ${unknown.join(", ")}`,
    );
  }
  for (const name of registered) {
    if (!allow.has(name)) registry.remove(name);
  }
  return registered.filter((n) => allow.has(n)).sort();
}
