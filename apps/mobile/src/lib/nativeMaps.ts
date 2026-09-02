/**
 * A non-throwing gate to the native Google Maps surface.
 *
 * `react-native-maps` is a native module: importing its JS on a binary built
 * before the module was added throws at load, and nothing in React catches it —
 * the app dies at launch (the same trap `expo-speech-recognition` sits behind in
 * `VoiceMicPanel`). So the surface is reached only through this guarded
 * `require`. When the native module is present `nativeMaps` carries the
 * component and its region helper; when it is not — an older build an OTA update
 * reached — it is `null`, and the caller falls back to the raster-tile map.
 */

import type {
  GoogleMapSurface as GoogleMapSurfaceType,
  regionForCenter,
} from '@/components/GoogleMapSurface';

interface NativeMaps {
  GoogleMapSurface: typeof GoogleMapSurfaceType;
  regionForCenter: typeof regionForCenter;
}

function load(): NativeMaps | null {
  try {
    // Reaching this file pulls in `react-native-maps`; a build without the native
    // module throws here and we degrade to tiles rather than crashing. The cast is
    // through `unknown` because the require's shape is only known at runtime.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@/components/GoogleMapSurface') as unknown as NativeMaps;
    return typeof mod.GoogleMapSurface === 'function' ? mod : null;
  } catch {
    return null;
  }
}

export const nativeMaps: NativeMaps | null = load();
