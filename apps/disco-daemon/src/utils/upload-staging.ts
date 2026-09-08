import { join } from 'node:path';
import { type DiscoConfig, expandHomePath, getManagedStorageSegments } from '@disco/core/config';
import type { UploadStagingStore } from '@disco/core/types';
import { LocalUploadStagingStore } from '../host/local/upload-staging-store.js';
import { MetadataUploadStagingStore } from './metadata-upload-staging-store.js';
import { parseS3UploadLocation, S3UploadStagingStore } from './s3-upload-staging-store.js';
import { configureUploadLimits, getUploadDirectory } from './upload.js';
import { DEFAULT_UPLOAD_MAX_BYTES } from './upload-staging-defaults.js';

export type UploadStagingStoreFactory = () => UploadStagingStore;
export type S3UploadStagingStoreFactory = (location: URL, config: DiscoConfig) => UploadStagingStore;

/** Resolve Disco's managed upload namespace below a local storage base. */
export function resolveLocalUploadDirectory(
  baseLocation: string,
  tenantId: string,
  tenantSeparated: boolean
): string {
  return join(baseLocation, ...getManagedStorageSegments('uploads', { tenantId, tenantSeparated }));
}

let factory: UploadStagingStoreFactory = () =>
  new LocalUploadStagingStore((tenantId) => getUploadDirectory(tenantId));
let instance: UploadStagingStore | undefined;

/** Application composition seam used by local self-hosted and Cloud adapters. */
export function configureUploadStagingStore(next: UploadStagingStoreFactory): void {
  factory = next;
  instance = undefined;
}

/**
 * Select the process-wide adapter from operator configuration. S3 construction
 * is injected by the Cloud composition root so core/daemon code never owns
 * provider credentials or a concrete object-store SDK.
 */
export function configureUploadStagingStoreFromConfig(
  config: DiscoConfig,
  s3Factory?: S3UploadStagingStoreFactory,
  db?: ConstructorParameters<typeof MetadataUploadStagingStore>[0]
): void {
  const location = config.uploads?.location ?? '~/.disco';
  const configuredMaxMb = config.uploads?.max_file_size_mb ?? 0;
  const maxBytes =
    configuredMaxMb === 0 ? DEFAULT_UPLOAD_MAX_BYTES : configuredMaxMb * 1024 * 1024;
  configureUploadLimits(maxBytes);
  // Attachments are durable by default. Operators can still opt into a finite
  // retention window by setting a positive max_age_days value.
  const ttlMs = (config.uploads?.max_age_days ?? 0) * 24 * 60 * 60 * 1000;
  if (/^s3:/i.test(location)) {
    configureUploadStagingStore(() => {
      const url = new URL(location);
      const adapter = s3Factory
        ? s3Factory(url, config)
        : new S3UploadStagingStore(parseS3UploadLocation(url), { maxBytes, ttlMs });
      return db ? new MetadataUploadStagingStore(db, adapter) : adapter;
    });
    return;
  }
  const expanded = expandHomePath(location);
  const tenantSeparated =
    config.multi_tenancy?.filesystem_isolation_enabled === true ||
    config.multi_tenancy?.mode === 'required_from_auth';
  configureUploadStagingStore(() => {
    const adapter = new LocalUploadStagingStore(
      (tenantId) => resolveLocalUploadDirectory(expanded, tenantId, tenantSeparated),
      { maxBytes, ttlMs }
    );
    return db ? new MetadataUploadStagingStore(db, adapter) : adapter;
  });
}

export function getUploadStagingStore(): UploadStagingStore {
  instance ??= factory();
  return instance;
}

export function resetUploadStagingStoreForTests(): void {
  configureUploadLimits(DEFAULT_UPLOAD_MAX_BYTES);
  factory = () => new LocalUploadStagingStore((tenantId) => getUploadDirectory(tenantId));
  instance = undefined;
}
