/**
 * Read-only runtime capability catalog.
 *
 * The catalog is supplied by the MCP server's live registry. Keeping this
 * service deliberately tiny prevents the Settings UI from becoming another
 * registration source or drifting away from Agent discovery and execution.
 */

import type { RuntimeCapabilityCatalog } from '@disco/core';

export class RuntimeCapabilitiesService {
  constructor(private readonly resolveCatalog: () => RuntimeCapabilityCatalog) {}

  async find(): Promise<RuntimeCapabilityCatalog> {
    return this.resolveCatalog();
  }
}

export function createRuntimeCapabilitiesService(
  resolveCatalog: () => RuntimeCapabilityCatalog
): RuntimeCapabilitiesService {
  return new RuntimeCapabilitiesService(resolveCatalog);
}
