/**
 * Generic event handler type for FeathersJS custom events.
 * Used to cast typed handlers when registering for custom (non-CRUD) events
 * where the AgorService overload expects `(...args: any[]) => void`.
 */
// biome-ignore lint/suspicious/noExplicitAny: Bridge type for FeathersJS event handler compatibility
export type FeathersEventHandler = (...args: any[]) => void;

export * from './useAgorClient';
export * from './useAgorData';
export * from './useAuth';
export * from './useAuthConfig';
export * from './useBoardActions';
export * from './useInitialLoaderPhase';
export * from './useLocalStorage';
export * from './useMessages';
export * from './usePermissions';
export * from './useRecentBoards';
export * from './useServerVersion';
export * from './useServicesConfig';
export * from './useSessionActions';
export * from './useSettingsRoute';
export * from './useSharedReactiveSession';
export * from './useUrlState';
