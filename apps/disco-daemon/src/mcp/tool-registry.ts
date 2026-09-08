/**
 * Tool Registry — Captures tool metadata for search-based discovery.
 *
 * When tool search is enabled, agents see only a few essential tools in
 * `tools/list` and discover the rest via `disco_search_tools`. All tools
 * remain registered and callable; only the listing is filtered.
 *
 * Every registered method carries its governance contract alongside the MCP
 * schema. The registry is the source consumed by discovery, details, prompt
 * validation, catalog fingerprinting, and startup consistency checks.
 */

import {
  buildRuntimeCapabilityCatalog,
  CODEX_NATIVE_RUNTIME_CAPABILITIES,
  DISCO_MCP_METHOD_NAMES,
  DISCO_UI_ONLY_RUNTIME_CAPABILITIES,
  REQUIRED_DISCO_MANAGED_METHOD_NAMES,
  type RuntimeCapabilityAudience,
  type RuntimeCapabilityDefinition,
  type RuntimeCapabilityLifecycle,
  type RuntimeCapabilityOutputKind,
  type RuntimeCapabilityOwnership,
  type RuntimeCapabilityProvider,
} from '@disco/core';
import type { Tool, ToolAnnotations } from '@modelcontextprotocol/server';

export type ToolProvider = Extract<RuntimeCapabilityProvider, 'disco-mcp'>;
export type ToolAudience = Extract<RuntimeCapabilityAudience, 'standalone' | 'agent' | 'admin'>;
export type ToolOwnership = RuntimeCapabilityOwnership;
export type ToolOutputKind = Exclude<RuntimeCapabilityOutputKind, 'command' | 'state'>;
export type ToolLifecycle = RuntimeCapabilityLifecycle;

export interface ToolDomainGovernance {
  domain: string;
  description: string;
  provider: ToolProvider;
  audiences: ToolAudience[];
  ownership: ToolOwnership;
  outputKinds: ToolOutputKind[];
  lifecycle: ToolLifecycle;
  dependencies: string[];
}

export type ToolGovernance = Omit<ToolDomainGovernance, 'domain' | 'description'>;
export type ToolGovernanceOverride = Partial<ToolGovernance>;

export interface ToolEntry {
  name: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  annotations?: ToolAnnotations;
  domain: string;
  governance: ToolGovernance;
}

/** Lightweight tool info returned for "list" detail level. */
export interface ToolSummary {
  name: string;
  description: string;
  domain: string;
  provider: ToolProvider;
  audiences: ToolAudience[];
  ownership: ToolOwnership;
  outputKinds: ToolOutputKind[];
}

export interface DomainInfo {
  domain: string;
  description: string;
  count: number;
  provider: ToolProvider;
  audiences: ToolAudience[];
  ownership: ToolOwnership;
  outputKinds: ToolOutputKind[];
  lifecycle: ToolLifecycle;
  dependencies: string[];
}

export interface SearchOptions {
  maxResults?: number;
  domain?: string;
  readOnly?: boolean;
  destructive?: boolean;
  audiences?: readonly ToolAudience[];
}

/** Tools always visible in `tools/list` even when search mode is enabled. */
const ALWAYS_VISIBLE = new Set<string>([
  DISCO_MCP_METHOD_NAMES.search,
  DISCO_MCP_METHOD_NAMES.details,
  DISCO_MCP_METHOD_NAMES.execute,
]);

export class ToolRegistry {
  private tools: Map<string, ToolEntry> = new Map();
  private domains = new Map<string, ToolDomainGovernance>();
  private currentDomain: ToolDomainGovernance = {
    domain: 'general',
    description: 'Unclassified Disco operations',
    provider: 'disco-mcp',
    audiences: ['standalone', 'agent'],
    ownership: 'context-dependent',
    outputKinds: ['text'],
    lifecycle: 'runtime',
    dependencies: [],
  };
  private currentMethodOverrides: Readonly<Record<string, ToolGovernanceOverride>> = {};

  /** Set the domain for subsequent register() calls. */
  setCurrentDomain(
    domain: ToolDomainGovernance | string,
    methodOverrides: Readonly<Record<string, ToolGovernanceOverride>> = {}
  ): void {
    const governance: ToolDomainGovernance =
      typeof domain === 'string'
        ? {
            domain,
            description: `${domain} operations`,
            provider: 'disco-mcp',
            audiences: ['standalone', 'agent'],
            ownership: 'context-dependent',
            outputKinds: ['text'],
            lifecycle: 'runtime',
            dependencies: [],
          }
        : domain;
    const existing = this.domains.get(governance.domain);
    if (existing && JSON.stringify(existing) !== JSON.stringify(governance)) {
      throw new Error(`Conflicting governance metadata for MCP domain ${governance.domain}`);
    }
    this.domains.set(governance.domain, governance);
    this.currentDomain = governance;
    this.currentMethodOverrides = methodOverrides;
  }

  register(entry: Omit<ToolEntry, 'domain' | 'governance'>): void {
    if (this.tools.has(entry.name)) {
      throw new Error(`Duplicate Disco MCP method registration: ${entry.name}`);
    }
    const { domain, description: _description, ...governance } = this.currentDomain;
    const override = this.currentMethodOverrides[entry.name] ?? {};
    this.tools.set(entry.name, {
      ...entry,
      domain,
      governance: { ...governance, ...override },
    });
  }

  get size(): number {
    return this.tools.size;
  }

  get(name: string, audiences?: readonly ToolAudience[]): ToolEntry | undefined {
    const entry = this.tools.get(name);
    return entry && this.isVisibleTo(entry, audiences) ? entry : undefined;
  }

  isAvailable(name: string, audiences: readonly ToolAudience[]): boolean {
    return Boolean(this.get(name, audiences));
  }

  count(audiences?: readonly ToolAudience[]): number {
    return Array.from(this.tools.values()).filter(entry => this.isVisibleTo(entry, audiences)).length;
  }

  /** Stable content fingerprint used to invalidate cached capability snapshots. */
  get fingerprint(): string {
    return buildRuntimeCapabilityCatalog(this.toRuntimeCapabilities()).fingerprint;
  }

  /** Normalized callable Disco methods for the cross-provider runtime catalog. */
  toRuntimeCapabilities(): RuntimeCapabilityDefinition[] {
    return Array.from(this.tools.values()).map(entry => ({
      id: `disco-mcp:${entry.name}`,
      name: entry.name,
      provider: 'disco-mcp',
      kind: 'method',
      exposure: 'agent-callable',
      description: entry.description,
      audiences: [...entry.governance.audiences],
      ownership: entry.governance.ownership,
      outputKinds: [...entry.governance.outputKinds],
      lifecycle: entry.governance.lifecycle,
      dependencies: [...entry.governance.dependencies],
      inputSchema: entry.inputSchema as unknown as Record<string, unknown>,
    }));
  }

  /**
   * Complete host-side inventory: Codex protocol events, Disco MCP methods and
   * UI-only features. Session-specific client dynamic tools are appended by
   * the executor when a thread is created.
   */
  get runtimeCatalog() {
    return buildRuntimeCapabilityCatalog(
      CODEX_NATIVE_RUNTIME_CAPABILITIES,
      this.toRuntimeCapabilities(),
      DISCO_UI_ONLY_RUNTIME_CAPABILITIES
    );
  }

  /** Fail fast when a method would enter discovery without a complete contract. */
  assertValid(): void {
    const issues: string[] = [];
    for (const entry of this.tools.values()) {
      if (!/^disco_[a-z0-9_]+$/u.test(entry.name)) {
        issues.push(`${entry.name}: name must use the disco_ prefix and snake_case`);
      }
      if (!entry.description.trim()) issues.push(`${entry.name}: description is required`);
      if (entry.inputSchema?.type !== 'object') {
        issues.push(`${entry.name}: input schema must be an object schema`);
      }
      if (entry.governance.audiences.length === 0) {
        issues.push(`${entry.name}: at least one audience is required`);
      }
      if (entry.governance.outputKinds.length === 0) {
        issues.push(`${entry.name}: at least one output kind is required`);
      }
    }
    for (const name of REQUIRED_DISCO_MANAGED_METHOD_NAMES) {
      if (!this.tools.has(name)) issues.push(`${name}: required managed method is not registered`);
    }
    if (issues.length > 0) {
      throw new Error(`Invalid Disco MCP capability catalog:\n- ${issues.join('\n- ')}`);
    }
  }

  /** Names that must have request-local handlers for the selected audience. */
  listDispatchableNames(audiences: readonly ToolAudience[]): string[] {
    return [...this.tools.values()]
      .filter(entry => !ALWAYS_VISIBLE.has(entry.name) && this.isVisibleTo(entry, audiences))
      .map(entry => entry.name)
      .sort((left, right) => left.localeCompare(right, 'en'));
  }

  /** Return only the always-visible tools (for filtered tools/list). */
  getAlwaysVisible(): ToolEntry[] {
    const result: ToolEntry[] = [];
    for (const [name, entry] of this.tools) {
      if (ALWAYS_VISIBLE.has(name)) result.push(entry);
    }
    return result;
  }

  /** Return domain listing with descriptions and tool counts. */
  listDomains(audiences?: readonly ToolAudience[]): DomainInfo[] {
    const grouped = new Map<string, ToolEntry[]>();
    for (const entry of this.tools.values()) {
      if (ALWAYS_VISIBLE.has(entry.name)) continue;
      if (!this.isVisibleTo(entry, audiences)) continue;
      grouped.set(entry.domain, [...(grouped.get(entry.domain) ?? []), entry]);
    }
    const domains: DomainInfo[] = [];
    for (const [domain, entries] of grouped) {
      const domainGovernance = this.domains.get(domain);
      if (!domainGovernance) throw new Error(`Missing governance metadata for MCP domain ${domain}`);
      const audienceSet = new Set(entries.flatMap(entry => entry.governance.audiences));
      const outputSet = new Set(entries.flatMap(entry => entry.governance.outputKinds));
      const dependencySet = new Set(entries.flatMap(entry => entry.governance.dependencies));
      const ownershipSet = new Set(entries.map(entry => entry.governance.ownership));
      const lifecycleSet = new Set(entries.map(entry => entry.governance.lifecycle));
      domains.push({
        domain,
        description: domainGovernance.description,
        count: entries.length,
        provider: 'disco-mcp',
        audiences: [...audienceSet].sort(),
        ownership:
          ownershipSet.size === 1 ? [...ownershipSet][0]! : 'context-dependent',
        outputKinds: [...outputSet].sort(),
        lifecycle: lifecycleSet.size === 1 ? [...lifecycleSet][0]! : 'managed',
        dependencies: [...dependencySet].sort(),
      });
    }
    return domains;
  }

  private isVisibleTo(entry: ToolEntry, audiences?: readonly ToolAudience[]): boolean {
    if (!audiences || audiences.length === 0) return true;
    return entry.governance.audiences.some(audience => audiences.includes(audience));
  }

  /** Apply domain and annotation filters, returning matching entries. */
  private applyFilters(options?: SearchOptions): ToolEntry[] {
    let entries = Array.from(this.tools.values());

    if (options?.audiences?.length) {
      entries = entries.filter(entry => this.isVisibleTo(entry, options.audiences));
    }

    if (options?.domain) {
      entries = entries.filter(e => e.domain === options.domain);
    }
    if (options?.readOnly !== undefined) {
      entries = entries.filter(e => e.annotations?.readOnlyHint === options.readOnly);
    }
    if (options?.destructive !== undefined) {
      entries = entries.filter(e => e.annotations?.destructiveHint === options.destructive);
    }

    return entries;
  }

  /** Search tools by keyword with optional domain/annotation filters. */
  search(query: string | undefined, options?: SearchOptions): ToolEntry[] {
    const maxResults = options?.maxResults ?? 10;
    const filtered = this.applyFilters(options);

    // No query — return filtered results (or all if no filters)
    if (!query || query.trim().length === 0) {
      return filtered.slice(0, maxResults);
    }

    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter(t => t.length > 0);

    const scored: Array<{ entry: ToolEntry; score: number }> = [];

    for (const entry of filtered) {
      const haystack = [
        entry.name,
        entry.description,
        entry.domain,
        entry.governance.provider,
        entry.governance.audiences.join(' '),
        entry.governance.ownership,
        entry.governance.outputKinds.join(' '),
      ]
        .join(' ')
        .toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) score++;
      }
      if (score > 0) scored.push({ entry, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults).map(s => s.entry);
  }

  /** Convert entries to summary format (list detail level). */
  static toSummaries(entries: ToolEntry[]): ToolSummary[] {
    return entries.map(e => ({
      name: e.name,
      description: e.description,
      domain: e.domain,
      provider: e.governance.provider,
      audiences: e.governance.audiences,
      ownership: e.governance.ownership,
      outputKinds: e.governance.outputKinds,
    }));
  }
}
