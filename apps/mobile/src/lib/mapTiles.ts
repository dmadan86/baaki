/**
 * The slippy-map arithmetic behind the expense location map (A43 follow-up).
 *
 * The map is drawn from plain raster tiles — no native map module, no API key —
 * so the app never grows a fragile native dependency or a build that breaks
 * autolinking on this Expo pin. That leaves this: the Web Mercator projection
 * that turns a {lat,lng} into which 256px tiles to fetch and where to place
 * them, and the inverse that turns a tap back into a {lat,lng}. It is pure
 * (no React Native, no network) so the projection round-trips can be tested,
 * and so importing it never drags React Native into the vitest graph.
 *
 * The tile source is swappable: {@link tileUrl} takes a URL template, and both
 * the URL ({@link DEFAULT_TILE_URL}) and its credit ({@link TILE_ATTRIBUTION})
 * can be overridden from the environment so a deployment can point at its own
 * provider without a code change.
 *
 * On the defaults, and why neither built-in is a production tile source:
 *   - OpenStreetMap's public server (tile.openstreetmap.org) *does* permit
 *     normal interactive app viewing, but only under strict conditions: a
 *     stable, identifying `User-Agent` (library-default UAs like okhttp are
 *     blocked — that is the "access blocked, not following the tile usage
 *     policy" we hit), fetching just the current viewport, honouring cache
 *     headers, and no bulk/offline pre-fetching. It is community infrastructure,
 *     not a hosting service.
 *   - CARTO's `basemaps.cartocdn.com` is used here as the built-in default
 *     because it tolerates this kind of light interactive traffic keylessly,
 *     but CARTO's terms expect a plan for production/commercial use — an
 *     unkeyed endpoint may start returning a watermarked or refused tile.
 *
 * So both built-ins are development conveniences. A production build MUST point
 * `EXPO_PUBLIC_MAP_TILE_URL` at a keyed or self-hosted provider (and set
 * `EXPO_PUBLIC_MAP_TILE_ATTRIBUTION` to that provider's required credit).
 * {@link TILE_HEADERS} sends a real, identifying User-Agent to whichever
 * provider is configured, satisfying OSM-style policies either way.
 */

/** Every raster tile is 256×256 device-independent pixels. */
export const TILE_SIZE = 256;

/**
 * The built-in tile URL template: CARTO's keyless "positron" (light) basemap, a
 * CDN that tolerates light interactive traffic, built from OpenStreetMap data.
 * A development default only — override with `EXPO_PUBLIC_MAP_TILE_URL` for
 * production (see the file header). Keep {@link TILE_ATTRIBUTION} shown alongside.
 */
export const DEFAULT_TILE_URL =
  process.env.EXPO_PUBLIC_MAP_TILE_URL || 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png';

/**
 * The credit shown over the map. It follows the tile URL: when a deployment
 * overrides `EXPO_PUBLIC_MAP_TILE_URL` it should also set
 * `EXPO_PUBLIC_MAP_TILE_ATTRIBUTION` to that provider's required credit, so the
 * attribution can never be wrong for the tiles actually being served. The
 * default credits OSM (the data) and CARTO (the default tiles).
 */
export const TILE_ATTRIBUTION =
  process.env.EXPO_PUBLIC_MAP_TILE_ATTRIBUTION || '© OpenStreetMap © CARTO';

/**
 * Headers sent with every tile request. A real, identifying User-Agent is
 * required by OpenStreetMap's tile policy and is good citizenship with any
 * provider — the default `okhttp`/blank UA a bare `<Image>` sends is exactly
 * what OSM's server refuses. Referenced by both map surfaces so the two never
 * drift.
 */
export const TILE_HEADERS: Record<string, string> = {
  'User-Agent': 'WavesApp/1.0 (+https://waves.app; expense location map)',
};

/** The latitudes Web Mercator can represent; beyond this the projection blows up. */
export const MAX_MERCATOR_LAT = 85.05112878;

/** A sensible street-level default, and the range the +/- buttons move within. */
export const MIN_ZOOM = 2;
export const MAX_ZOOM = 19;
export const DEFAULT_ZOOM = 15;

/** Keep a latitude inside the Mercator-representable band. */
export function clampLat(lat: number): number {
  return Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
}

/** Keep a longitude in [-180, 180). */
export function wrapLng(lng: number): number {
  let x = ((lng + 180) % 360) - 180;
  if (x < -180) x += 360;
  return x;
}

/** Clamp a zoom to the supported range and round to an integer tile level. */
export function clampZoom(zoom: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom)));
}

/** The world's pixel span at a zoom level (tiles across × tile size). */
function worldSize(zoom: number): number {
  return TILE_SIZE * 2 ** zoom;
}

export interface WorldPoint {
  readonly x: number;
  readonly y: number;
}

export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

/** Project a {lat,lng} to absolute world pixels at a zoom (Web Mercator). */
export function project(lat: number, lng: number, zoom: number): WorldPoint {
  const size = worldSize(zoom);
  const x = ((wrapLng(lng) + 180) / 360) * size;
  const sinLat = Math.sin((clampLat(lat) * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * size;
  return { x, y };
}

/** Invert {@link project}: absolute world pixels back to a {lat,lng}. */
export function unproject(x: number, y: number, zoom: number): LatLng {
  const size = worldSize(zoom);
  const lng = (x / size) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / size;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng: wrapLng(lng) };
}

/**
 * The {lat,lng} a given pixel offset from a centre point resolves to — how a
 * tap on the map (dx, dy pixels from the centre pin) becomes a new place.
 */
export function offsetLatLng(center: LatLng, zoom: number, dxPx: number, dyPx: number): LatLng {
  const c = project(center.lat, center.lng, zoom);
  return unproject(c.x + dxPx, c.y + dyPx, zoom);
}

export interface TilePlacement {
  /** Tile column (already wrapped into [0, 2^zoom) for the URL). */
  readonly x: number;
  /** Tile row. */
  readonly y: number;
  /** Screen-space top-left of this tile within the viewport, in pixels. */
  readonly left: number;
  readonly top: number;
}

/**
 * Which tiles cover a viewport centred on a {lat,lng}, and where each sits.
 *
 * The centre point lands exactly at (width/2, height/2); tiles are laid around
 * it. Columns wrap around the globe; rows past the poles are dropped (there is
 * no tile there), which simply leaves the map background showing.
 */
export function tileGrid(
  center: LatLng,
  zoom: number,
  width: number,
  height: number,
): TilePlacement[] {
  if (width <= 0 || height <= 0) return [];
  const z = clampZoom(zoom);
  const n = 2 ** z;
  const c = project(center.lat, center.lng, z);
  // The viewport's top-left corner in world pixels.
  const originX = c.x - width / 2;
  const originY = c.y - height / 2;

  const firstCol = Math.floor(originX / TILE_SIZE);
  const lastCol = Math.floor((originX + width) / TILE_SIZE);
  const firstRow = Math.floor(originY / TILE_SIZE);
  const lastRow = Math.floor((originY + height) / TILE_SIZE);

  const tiles: TilePlacement[] = [];
  for (let row = firstRow; row <= lastRow; row++) {
    if (row < 0 || row >= n) continue; // above/below the map — nothing to draw
    for (let col = firstCol; col <= lastCol; col++) {
      // Wrap columns so panning across the antimeridian keeps showing tiles.
      const wrappedCol = ((col % n) + n) % n;
      tiles.push({
        x: wrappedCol,
        y: row,
        left: col * TILE_SIZE - originX,
        top: row * TILE_SIZE - originY,
      });
    }
  }
  return tiles;
}

/** Fill a `{z}/{x}/{y}` URL template for one tile. */
export function tileUrl(template: string, x: number, y: number, zoom: number): string {
  return template.replace('{z}', String(zoom)).replace('{x}', String(x)).replace('{y}', String(y));
}
