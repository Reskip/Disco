import type { DiscoConfig } from '@disco/core/config';
import { requireDeploymentId } from '@disco/core/config';
import { resolveConnectedDeploymentTarget } from './deployment-target.js';

/** Refuse local administration while authenticated to another deployment. */
export async function assertLocalContextUnlocked(config: DiscoConfig): Promise<void> {
  const localDeploymentId = requireDeploymentId(config);
  const target = await resolveConnectedDeploymentTarget();
  if (target && target.deploymentId !== localDeploymentId) {
    throw new Error(
      `Local administration is locked while logged into another deployment.\n\n` +
        `Local deployment: ${localDeploymentId}\n` +
        `Current connection: ${target.deploymentId} at ${target.url}\n\n` +
        'Run `disco logout` or `disco login --local` first.'
    );
  }
}

/** Compatibility-only guard for diagnostics and stopping a pre-identity daemon. */
export async function assertLocalContextUnlockedWhenIdentified(config: DiscoConfig): Promise<void> {
  try {
    requireDeploymentId(config);
  } catch {
    return;
  }
  await assertLocalContextUnlocked(config);
}
