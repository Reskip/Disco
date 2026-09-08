/**
 * Generic event handler type for FeathersJS custom events.
 * Used to cast typed handlers when registering for custom (non-CRUD) events
 * where the DiscoService overload expects `(...args: any[]) => void`.
 */
// biome-ignore lint/suspicious/noExplicitAny: Bridge type for FeathersJS event handler compatibility
export type FeathersEventHandler = (...args: any[]) => void;

export * from './useDiscoClient';
export * from './useAuth';
export * from './useAuthConfig';
export * from './useIdentityGuardedAsync';
export * from './useInitialLoaderPhase';
export * from './useLocalStorage';
export * from './useMcpMemberPolicy';
export * from './useMessages';
export * from './usePermissions';
export * from './useServerVersion';
export * from './useSessionActions';
export * from './useSharedReactiveSession';
export * from './useStableCallback';
