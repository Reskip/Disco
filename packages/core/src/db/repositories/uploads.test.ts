import type { UploadMetadata, UploadOwner, UploadRef } from '@disco/core/types';
import { expect } from 'vitest';
import { dbTest } from '../test-helpers';
import { UploadRepository } from './uploads';

dbTest(
  'permanent inspection thumbnails never satisfy original-file deduplication or cross-owner reuse',
  async ({ db }) => {
    const repository = new UploadRepository(db);
    const owner = {
      tenantId: 'default',
      createdBy: 'owner',
      sessionId: 'session',
      agentId: null,
    } as UploadOwner;
    const metadata = {
      ref: 'upl_preview' as UploadRef,
      name: 'small.webp',
      size: 100,
      mimeType: 'image/webp',
      checksum: 'same-content',
      provenance: 'tool-preview',
      createdAt: new Date().toISOString(),
      expiresAt: null,
    } as UploadMetadata;
    await repository.create(owner, metadata);
    expect(
      await repository.findActiveByChecksum(owner.tenantId, owner, metadata.checksum!)
    ).toBeNull();
    expect(
      await repository.findActiveByChecksum(
        owner.tenantId,
        owner,
        metadata.checksum!,
        'tool-preview'
      )
    ).toMatchObject({ ref: 'upl_preview', provenance: 'tool-preview', expiresAt: null });
    expect(
      await repository.findActiveByChecksum(
        owner.tenantId,
        { ...owner, createdBy: 'other' as UploadOwner['createdBy'] },
        metadata.checksum!,
        'tool-preview'
      )
    ).toBeNull();
    await repository.create(owner, {
      ...metadata,
      ref: 'upl_expiring' as UploadRef,
      provenance: 'browser',
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    });
    expect(
      await repository.findActiveByChecksum(owner.tenantId, owner, metadata.checksum!)
    ).toBeNull();
    await repository.create(owner, {
      ...metadata,
      ref: 'upl_original' as UploadRef,
      provenance: 'browser',
    });
    expect(
      await repository.findActiveByChecksum(owner.tenantId, owner, metadata.checksum!)
    ).toMatchObject({ ref: 'upl_original', provenance: 'browser' });
  }
);
