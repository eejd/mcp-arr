import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface ToolEntry {
  definition: Tool;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
  capabilityGroup: string;
  isWrite: boolean;
  alwaysOn: boolean;
}

export class ToolRegistry {
  private entries = new Map<string, ToolEntry>();

  register(entry: ToolEntry): void {
    this.entries.set(entry.definition.name, entry);
  }

  get(name: string): ToolEntry | undefined {
    return this.entries.get(name);
  }

  all(): ToolEntry[] {
    return Array.from(this.entries.values());
  }

  byGroup(group: string): ToolEntry[] {
    return Array.from(this.entries.values()).filter(e => e.capabilityGroup === group);
  }

  definitions(): Tool[] {
    return Array.from(this.entries.values()).map(e => e.definition);
  }

  async dispatch(name: string, args: Record<string, unknown>): Promise<unknown> {
    const entry = this.entries.get(name);
    if (!entry) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return entry.handler(args);
  }
}
