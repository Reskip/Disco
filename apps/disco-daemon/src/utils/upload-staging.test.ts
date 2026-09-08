import type { DiscoConfig } from '@disco/core/config';
import type { UploadStagingStore } from '@disco/core/types';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { S3UploadStagingStore } from './s3-upload-staging-store.js';
import { getUploadLimits } from './upload.js';
import {
  configureUploadStagingStore,
  configureUploadStagingStoreFromConfig,
  getUploadStagingStore,
  resetUploadStagingStoreForTests,
  resolveLocalUploadDirectory,
} from './upload-staging.js';

afterEach(resetUploadStagingStoreForTests);

describe('upload staging application composition', () => {
  it('injects and reuses one application-level adapter instance', () => {
    const adapter = { stage: async () => ({}) } as UploadStagingStore;
    let constructions = 0;
    configureUploadStagingStore(() => {
      constructions++;
      return adapter;
    });
    expect(getUploadStagingStore()).toBe(adapter);
    expect(getUploadStagingStore()).toBe(adapter);
    expect(constructions).toBe(1);
  });

  it('configures the shared ingress policy from uploads.max_file_size_mb', () => {
    configureUploadStagingStoreFromConfig({
      uploads: { location: '/tmp/disco-upload-test', max_file_size_mb: 7 },
    } as DiscoConfig);
    expect(getUploadLimits()).toMatchObject({
      maxFileBytes: 7 * 1024 * 1024,
      maxTotalBytes: 14 * 1024 * 1024,
    });
  });

  it('maps zero to no practical application-layer size limit', () => {
    configureUploadStagingStoreFromConfig({
      uploads: { location: '/tmp/disco-upload-test', max_file_size_mb: 0 },
    } as DiscoConfig);
    expect(getUploadLimits()).toMatchObject({
      maxFileBytes: Number.MAX_SAFE_INTEGER,
      maxTotalBytes: Number.MAX_SAFE_INTEGER,
    });
  });

  it('constructs the built-in S3 adapter for an s3:// location', () => {
    configureUploadStagingStoreFromConfig({
      uploads: { location: 's3://disco-uploads/customer-data' },
    } as DiscoConfig);
    expect(getUploadStagingStore()).toBeInstanceOf(S3UploadStagingStore);
  });

  it('treats local configuration as a base and appends the managed layout', () => {
    expect(resolveLocalUploadDirectory('/data/disco', 'default', false)).toBe(
      join('/data/disco', 'uploads')
    );
    expect(resolveLocalUploadDirectory('/data/disco', 'tenant-a', true)).toBe(
      join('/data/disco', 'tenants', 'tenant-a', 'uploads')
    );
  });
});
