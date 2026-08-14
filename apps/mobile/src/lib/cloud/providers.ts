/** The provider registry — the one place that knows all three implementations. */

import { googleDrive } from './googleDrive';
import { dropbox } from './dropbox';
import { oneDrive } from './onedrive';
import { CLOUD_PROVIDER_IDS, type CloudProvider, type CloudProviderId } from './types';

const REGISTRY: Record<CloudProviderId, CloudProvider> = {
  gdrive: googleDrive,
  dropbox,
  onedrive: oneDrive,
};

export function providerFor(id: CloudProviderId): CloudProvider {
  return REGISTRY[id];
}

export function allProviders(): readonly CloudProvider[] {
  return CLOUD_PROVIDER_IDS.map((id) => REGISTRY[id]);
}
