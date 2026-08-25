/**
 * The map projection, checked as numbers.
 *
 * The map is drawn from raster tiles, so a wrong projection is a pin that sits
 * on the wrong street without ever throwing. Two things must hold: project and
 * unproject are exact inverses (a tap comes back to the point it started from),
 * and the tile grid actually covers the viewport it is asked to fill.
 */

import { describe, expect, it } from 'vitest';

import {
  clampLat,
  clampZoom,
  DEFAULT_TILE_URL,
  MAX_MERCATOR_LAT,
  offsetLatLng,
  project,
  tileGrid,
  tileUrl,
  TILE_ATTRIBUTION,
  TILE_SIZE,
  unproject,
  wrapLng,
} from '@/lib/mapTiles';

describe('project / unproject', () => {
  it('round-trips a point back to itself', () => {
    // Bengaluru — the kind of point an expense actually carries.
    const lat = 12.9716;
    const lng = 77.5946;
    const z = 15;
    const p = project(lat, lng, z);
    const back = unproject(p.x, p.y, z);
    expect(back.lat).toBeCloseTo(lat, 6);
    expect(back.lng).toBeCloseTo(lng, 6);
  });

  it('puts the origin (0,0) at the centre of the world', () => {
    const z = 10;
    const size = TILE_SIZE * 2 ** z;
    const p = project(0, 0, z);
    expect(p.x).toBeCloseTo(size / 2, 6);
    expect(p.y).toBeCloseTo(size / 2, 6);
  });

  it('round-trips a southern-hemisphere point too', () => {
    const lat = -33.8688;
    const lng = 151.2093;
    const back = unproject(...([project(lat, lng, 12).x, project(lat, lng, 12).y] as const), 12);
    expect(back.lat).toBeCloseTo(lat, 6);
    expect(back.lng).toBeCloseTo(lng, 6);
  });
});

describe('clamping and wrapping', () => {
  it('clamps latitude to the Mercator band', () => {
    expect(clampLat(90)).toBe(MAX_MERCATOR_LAT);
    expect(clampLat(-90)).toBe(-MAX_MERCATOR_LAT);
    expect(clampLat(10)).toBe(10);
  });

  it('wraps longitude into [-180, 180)', () => {
    expect(wrapLng(190)).toBeCloseTo(-170, 6);
    expect(wrapLng(-190)).toBeCloseTo(170, 6);
    expect(wrapLng(45)).toBeCloseTo(45, 6);
  });

  it('rounds and clamps zoom to the supported range', () => {
    expect(clampZoom(15.4)).toBe(15);
    expect(clampZoom(-5)).toBe(2);
    expect(clampZoom(99)).toBe(19);
  });
});

describe('offsetLatLng', () => {
  it('returns the centre for a zero offset', () => {
    const center = { lat: 40.7128, lng: -74.006 };
    const same = offsetLatLng(center, 14, 0, 0);
    expect(same.lat).toBeCloseTo(center.lat, 6);
    expect(same.lng).toBeCloseTo(center.lng, 6);
  });

  it('moves north when dragged up (negative dy) and east for positive dx', () => {
    const center = { lat: 0, lng: 0 };
    const up = offsetLatLng(center, 14, 0, -50);
    const right = offsetLatLng(center, 14, 50, 0);
    expect(up.lat).toBeGreaterThan(0); // up the screen is north
    expect(right.lng).toBeGreaterThan(0); // right is east
  });
});

describe('tileGrid', () => {
  it('covers the whole viewport with tiles', () => {
    const tiles = tileGrid({ lat: 12.9716, lng: 77.5946 }, 15, 300, 200);
    expect(tiles.length).toBeGreaterThan(0);
    // Some tile must cover the top-left corner and some the bottom-right.
    expect(tiles.some((tile) => tile.left <= 0 && tile.top <= 0)).toBe(true);
    expect(tiles.some((tile) => tile.left + TILE_SIZE >= 300 && tile.top + TILE_SIZE >= 200)).toBe(
      true,
    );
  });

  it('keeps tile columns inside [0, 2^zoom)', () => {
    const z = 3;
    const n = 2 ** z;
    const tiles = tileGrid({ lat: 0, lng: 179.9 }, z, 512, 256);
    for (const tile of tiles) {
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.x).toBeLessThan(n);
    }
  });

  it('returns nothing for an empty viewport', () => {
    expect(tileGrid({ lat: 0, lng: 0 }, 12, 0, 0)).toEqual([]);
  });
});

describe('tileUrl', () => {
  it('fills the z/x/y template', () => {
    // A literal template, not DEFAULT_TILE_URL: this test is about the
    // substitution, not about which provider the default happens to be.
    expect(tileUrl('https://tiles.example/{z}/{x}/{y}.png', 3, 5, 15)).toBe(
      'https://tiles.example/15/3/5.png',
    );
  });

  it('defaults to the keyless CARTO basemap when no override is set', () => {
    // A development default; production sets EXPO_PUBLIC_MAP_TILE_URL. With no
    // override in the test env it must resolve to the CARTO template.
    expect(DEFAULT_TILE_URL).toContain('basemaps.cartocdn.com');
    expect(DEFAULT_TILE_URL).not.toContain('tile.openstreetmap.org');
    expect(tileUrl(DEFAULT_TILE_URL, 3, 5, 15)).toBe(
      'https://basemaps.cartocdn.com/light_all/15/3/5.png',
    );
  });

  it('credits OSM data + CARTO tiles by default, and the credit is env-overridable', () => {
    // The attribution follows the tile URL so it can never be wrong for the
    // tiles actually served (EXPO_PUBLIC_MAP_TILE_ATTRIBUTION overrides it).
    expect(TILE_ATTRIBUTION).toContain('OpenStreetMap');
    expect(TILE_ATTRIBUTION).toContain('CARTO');
  });
});
