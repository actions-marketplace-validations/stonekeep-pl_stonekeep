import { StonekeepError, errorMessage } from '@stonekeep/core';
import { z } from 'zod';
import type { PluginContext, SaasConnector, SaasPlugin } from './types.js';

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `    - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}

/** Plugin registry: maps a `type` in `saas:` config entries to a connector implementation. */
export class ConnectorRegistry {
  private readonly plugins = new Map<string, SaasPlugin>();

  register(plugin: SaasPlugin): this {
    if (this.plugins.has(plugin.type))
      throw new Error(`SaaS plugin "${plugin.type}" is already registered`);
    this.plugins.set(plugin.type, plugin);
    return this;
  }

  get(type: string): SaasPlugin | undefined {
    return this.plugins.get(type);
  }

  list(): { type: string; description: string }[] {
    return [...this.plugins.values()].map((p) => ({ type: p.type, description: p.description }));
  }

  /**
   * Validate every `saas:` entry with its plugin's schema and instantiate it.
   * Fails (without network calls) on unknown types, bad config, missing or
   * malformed credentials, and duplicate names.
   */
  async createAll(entries: readonly unknown[], ctx: PluginContext): Promise<SaasConnector[]> {
    const problems: string[] = [];
    const parsed: { plugin: SaasPlugin; config: unknown; index: number }[] = [];
    entries.forEach((entry, index) => {
      const type =
        typeof entry === 'object' && entry !== null && 'type' in entry ? String(entry.type) : '';
      const plugin = this.plugins.get(type);
      if (!plugin) {
        problems.push(
          `saas[${index}]: unknown connector type "${type}" (available: ${[...this.plugins.keys()].join(', ')})`,
        );
        return;
      }
      const result = plugin.configSchema.safeParse(entry);
      if (!result.success) {
        problems.push(`saas[${index}] (${type}):\n${formatIssues(result.error)}`);
        return;
      }
      parsed.push({ plugin, config: result.data, index });
    });
    if (problems.length > 0)
      throw new StonekeepError(
        'CONFIG',
        `Invalid SaaS connector config:\n  ${problems.join('\n  ')}`,
      );

    const connectors: SaasConnector[] = [];
    for (const { plugin, config, index } of parsed) {
      try {
        connectors.push(await plugin.create(config, ctx));
      } catch (error) {
        problems.push(`saas[${index}] (${plugin.type}): ${errorMessage(error)}`);
      }
    }
    const names = connectors.map((c) => c.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    if (dupes.length > 0)
      problems.push(
        `duplicate connector name(s): ${[...new Set(dupes)].join(', ')} (set "name" to disambiguate)`,
      );
    if (problems.length > 0)
      throw new StonekeepError(
        'CONFIG',
        `Invalid SaaS connector config:\n  ${problems.join('\n  ')}`,
      );
    return connectors;
  }
}
