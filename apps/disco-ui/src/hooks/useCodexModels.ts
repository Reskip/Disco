import {
  type CodexModelCatalog,
  type DiscoClient,
  fallbackCodexModelCatalog,
} from '@disco-live/client';
import { useEffect, useState } from 'react';

const REFRESH_MS = 5 * 60_000;
interface CatalogState {
  catalog: CodexModelCatalog;
  loading: boolean;
}
const EMPTY: CatalogState = { catalog: fallbackCodexModelCatalog(), loading: false };
interface CatalogStore {
  state: CatalogState;
  listeners: Set<(state: CatalogState) => void>;
  refresh: (force?: boolean) => void;
}
const stores = new WeakMap<DiscoClient, CatalogStore>();

function storeFor(client: DiscoClient): CatalogStore {
  const existing = stores.get(client);
  if (existing) return existing;
  let pending = false;
  let updated = 0;
  let generation = 0;
  const publish = () => {
    for (const notify of store.listeners) notify(store.state);
  };
  const store: CatalogStore = {
    state: EMPTY,
    listeners: new Set(),
    refresh(force = false) {
      if (pending || (!force && Date.now() - updated < REFRESH_MS)) return;
      pending = true;
      const currentGeneration = generation;
      store.state = { ...store.state, loading: true };
      publish();
      void Promise.resolve()
        .then(() => client.service('codex-models').find())
        .then((catalog) => {
          if (generation !== currentGeneration) return;
          if (!Array.isArray(catalog?.models) || !catalog.models.length)
            throw new Error('Empty catalog');
          store.state = {
            loading: false,
            catalog:
              catalog.source === 'static' && store.state.catalog.source !== 'static'
                ? { ...store.state.catalog, source: 'cached' }
                : catalog,
          };
        })
        .catch(() => {
          if (generation !== currentGeneration) return;
          store.state = {
            loading: false,
            catalog: {
              ...store.state.catalog,
              source: store.state.catalog.source === 'static' ? 'static' : 'cached',
            },
          };
        })
        .finally(() => {
          if (generation !== currentGeneration) return;
          updated = Date.now();
          pending = false;
          publish();
        });
    },
  };
  // A reused Feathers client must never show the preceding user's catalog.
  const reset = () => {
    generation++;
    pending = false;
    updated = 0;
    store.state = EMPTY;
    publish();
  };
  client.on?.('logout', reset);
  client.on?.('authenticated', () => {
    reset();
    if (store.listeners.size) store.refresh();
  });
  stores.set(client, store);
  return store;
}

/** Mount, return-to-tab and periodic refresh; all mounted selectors share one request. */
export function useCodexModels(client?: DiscoClient | null, enabled = true) {
  const store = enabled && client ? storeFor(client) : undefined;
  const [, setState] = useState(store?.state ?? EMPTY);
  useEffect(() => {
    setState(store?.state ?? EMPTY);
    if (!store) return;
    store.listeners.add(setState);
    store.refresh();
    const refresh = () => {
      if (!document.hidden) store.refresh();
    };
    const timer = window.setInterval(refresh, REFRESH_MS);
    window.addEventListener('focus', refresh);
    return () => {
      store.listeners.delete(setState);
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [store]);
  return { ...(store?.state ?? EMPTY), refresh: () => store?.refresh(true) };
}
