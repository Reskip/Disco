/** Redis-backed realtime dependency state exposed through daemon health. */
export interface RedisRealtimeHealth {
  required: true;
  ready: boolean;
  draining: boolean;
  adapterAttached: boolean;
  pubStatus: string;
  subStatus: string;
}
