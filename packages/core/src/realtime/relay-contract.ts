import type { TenantID } from '../types/tenant';

/**
 * Wire revision for the internal cross-replica Feathers publication relay.
 *
 * A revision change requires the documented all-at-once HA cohort replacement:
 * mixed revisions intentionally listen on different Socket.IO server events.
 */
export const REALTIME_RELAY_VERSION = 3 as const;
export const REALTIME_RELAY_EVENT = `disco:feathers-publication:v${REALTIME_RELAY_VERSION}` as const;
export const MAX_REALTIME_RELAY_BYTES = 512 * 1024;

/** Bounded JSON envelope sent over the existing HA realtime relay. */
export interface RealtimeRelayEnvelope {
  version: typeof REALTIME_RELAY_VERSION;
  tenantId: TenantID;
  path: string;
  event: string;
  method?: string;
  id?: string | number;
  data: unknown;
}

function isBoundedJson(value: unknown): boolean {
  try {
    const encoded = JSON.stringify(value);
    return (
      encoded !== undefined &&
      new TextEncoder().encode(encoded).byteLength <= MAX_REALTIME_RELAY_BYTES
    );
  } catch {
    return false;
  }
}

/** Runtime codec for data received from the trusted-but-untyped Redis plane. */
export function isRealtimeRelayEnvelope(value: unknown): value is RealtimeRelayEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  return (
    envelope.version === REALTIME_RELAY_VERSION &&
    typeof envelope.tenantId === 'string' &&
    envelope.tenantId.length > 0 &&
    envelope.tenantId.length <= 128 &&
    typeof envelope.path === 'string' &&
    envelope.path.length > 0 &&
    envelope.path.length <= 128 &&
    typeof envelope.event === 'string' &&
    envelope.event.length > 0 &&
    envelope.event.length <= 128 &&
    (envelope.method === undefined ||
      (typeof envelope.method === 'string' && envelope.method.length <= 128)) &&
    (envelope.id === undefined ||
      (typeof envelope.id === 'string' && envelope.id.length <= 256) ||
      (typeof envelope.id === 'number' && Number.isFinite(envelope.id))) &&
    envelope.branchRemovalVisibility === undefined &&
    'data' in envelope &&
    isBoundedJson(envelope)
  );
}
