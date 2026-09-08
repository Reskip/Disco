export interface CachedSkillCatalog<T> {
  expiresAt: number;
  entries: T[];
}

let cachedCatalog: CachedSkillCatalog<unknown> | undefined;

export function readSkillCatalogCache<T>(now: number): CachedSkillCatalog<T> | undefined {
  if (!cachedCatalog || cachedCatalog.expiresAt <= now) return undefined;
  return cachedCatalog as CachedSkillCatalog<T>;
}

export function writeSkillCatalogCache<T>(value: CachedSkillCatalog<T>): void {
  cachedCatalog = value as CachedSkillCatalog<unknown>;
}

export function clearSkillCatalogCache(): void {
  cachedCatalog = undefined;
}
