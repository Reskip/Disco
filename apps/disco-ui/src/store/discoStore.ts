import type { TenantAgenticToolName, TenantAgenticToolSettings } from '@disco-live/client';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { type DataMaps, EMPTY_MAPS, MAP_KEYS, pickMaps } from './discoMaps';

type LoadingStage = 'idle' | 'fetching' | 'indexing';
export type GatedHydrationFlag = 'mcpServersHydrated';

interface DiscoMeta {
  loading: boolean;
  loadingStage: LoadingStage;
  error: string | null;
  itemCounts: Record<string, number>;
  mcpServersHydrated: boolean;
  agenticToolSettingsByName: Map<TenantAgenticToolName, TenantAgenticToolSettings>;
  agenticToolSettingsHydrated: boolean;
}

interface DiscoActions {
  reset: () => void;
  resetMaps: () => void;
  setLoading: (value: boolean) => void;
  setLoadingStage: (value: LoadingStage) => void;
  setError: (value: string | null) => void;
  setItemCounts: (
    value: Record<string, number> | ((previous: Record<string, number>) => Record<string, number>)
  ) => void;
  markHydrated: (flag: GatedHydrationFlag) => void;
  setAgenticToolSettings: (settings: TenantAgenticToolSettings[]) => void;
  upsertAgenticToolSetting: (setting: TenantAgenticToolSettings) => void;
  setMap: <K extends keyof DataMaps>(
    key: K,
    value: DataMaps[K] | ((previous: DataMaps[K]) => DataMaps[K])
  ) => void;
  replaceMaps: (partial: Partial<DataMaps>) => void;
  applyMaps: (updater: (previous: DataMaps) => DataMaps) => void;
}

export type DiscoState = DataMaps & DiscoMeta & DiscoActions;

const INITIAL_META: DiscoMeta = {
  loading: true,
  loadingStage: 'idle',
  error: null,
  itemCounts: {},
  mcpServersHydrated: false,
  agenticToolSettingsByName: new Map(),
  agenticToolSettingsHydrated: false,
};

export const discoStore = createStore<DiscoState>()((set, get) => ({
  ...EMPTY_MAPS,
  ...INITIAL_META,
  reset: () => set({ ...EMPTY_MAPS, ...INITIAL_META }),
  resetMaps: () =>
    set({
      ...EMPTY_MAPS,
      agenticToolSettingsByName: new Map(),
      agenticToolSettingsHydrated: false,
    }),
  setLoading: (loading) => {
    if (loading !== get().loading) set({ loading });
  },
  setLoadingStage: (loadingStage) => {
    if (loadingStage !== get().loadingStage) set({ loadingStage });
  },
  setError: (error) => {
    if (error !== get().error) set({ error });
  },
  setItemCounts: (value) => {
    const next = typeof value === 'function' ? value(get().itemCounts) : value;
    if (!Object.is(next, get().itemCounts)) set({ itemCounts: next });
  },
  markHydrated: (flag) => {
    if (!get()[flag]) set({ [flag]: true } as Partial<DiscoState>);
  },
  setAgenticToolSettings: (settings) =>
    set({
      agenticToolSettingsByName: new Map(settings.map((setting) => [setting.tool, setting])),
      agenticToolSettingsHydrated: true,
    }),
  upsertAgenticToolSetting: (setting) => {
    const next = new Map(get().agenticToolSettingsByName);
    next.set(setting.tool, setting);
    set({ agenticToolSettingsByName: next });
  },
  setMap: (key, value) => {
    const previous = get()[key];
    const next =
      typeof value === 'function'
        ? (value as (current: DataMaps[typeof key]) => DataMaps[typeof key])(previous)
        : value;
    if (!Object.is(next, previous)) set({ [key]: next } as Partial<DiscoState>);
  },
  replaceMaps: (partial) => {
    const current = get();
    const changed: Partial<DataMaps> = {};
    for (const key of Object.keys(partial) as (keyof DataMaps)[]) {
      const next = partial[key];
      if (next !== undefined && !Object.is(next, current[key])) changed[key] = next as never;
    }
    if (Object.keys(changed).length > 0) set(changed as Partial<DiscoState>);
  },
  applyMaps: (updater) => {
    const previous = pickMaps(get());
    const next = updater(previous);
    const changed: Partial<DataMaps> = {};
    for (const key of MAP_KEYS) {
      if (!Object.is(next[key], previous[key])) changed[key] = next[key] as never;
    }
    if (Object.keys(changed).length > 0) set(changed as Partial<DiscoState>);
  },
}));

export function useDiscoStore<T>(selector: (state: DiscoState) => T): T {
  return useStore(discoStore, selector);
}

export { shallow } from 'zustand/shallow';
export { useStoreWithEqualityFn } from 'zustand/traditional';
