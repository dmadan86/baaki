/** The provider registry — the one place that knows the implementations. */

import { googleDrive } from './googleDrive';
import { CLOUD_PROVIDER_IDS, type CloudProvider, type CloudProviderId } from './types';

const REGISTRY: Record<CloudProviderId, CloudProvider> = {
  gdrive: googleDrive,
};

export function providerFor(id: CloudProviderId): CloudProvider {
  return REGISTRY[id];
}

export function allProviders(): readonly CloudProvider[] {
  return CLOUD_PROVIDER_IDS.map((id) => REGISTRY[id]);
}
