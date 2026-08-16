/**
 * Split parameters over the wire.
 *
 * Three of the six split kinds carry minor units, and minor units are bigints
 * (ADR-003). JSON has no bigint: `JSON.stringify` throws on one rather than
 * quietly rounding, which is the right failure but it still means an itemized
 * bill or an exact split cannot be sent anywhere without passing through here
 * first.
 *
 * They travel as decimal strings, not numbers. A number would survive every
 * test anybody writes — ₹9,00,000 is nowhere near 2^53 — and then lose a unit
 * on the one bill big enough to matter. There is no reason to leave that open.
 *
 * `parseSplitParams` is deliberately liberal about what it accepts and strict
 * about what it rejects: a string, a bigint, or an integer number all mean the
 * same thing and all come back as a bigint, but a fraction does not. A
 * fractional minor unit means a float got into somebody's money upstream, and
 * the only useful response is to stop.
 */

import type { AdjustmentParams, ExactParams, ItemizedParams, MemberId, SplitParams } from './types';

export class SplitWireError extends Error {
  constructor(
    readonly code: 'NOT_AN_OBJECT' | 'UNKNOWN_KIND' | 'NOT_AN_INTEGER' | 'BAD_SHAPE',
    message: string,
  ) {
    super(message);
    this.name = 'SplitWireError';
  }
}

/** The JSON-safe mirror of `SplitParams`: identical, with minor units as strings. */
export type WireSplitParams = Record<string, unknown>;

export function serialiseSplitParams(params: SplitParams): WireSplitParams {
  switch (params.kind) {
    case 'exact':
      return { kind: 'exact', amounts: mapValues(params.amounts, String) };
    case 'adjustment':
      return { kind: 'adjustment', adjustments: mapValues(params.adjustments, String) };
    case 'itemized':
      return {
        kind: 'itemized',
        items: params.items.map((item) => ({
          ...(item.label === undefined ? {} : { label: item.label }),
          total: item.total.toString(),
        })),
        claims: params.claims,
        ...optionalString('taxes', params.taxes),
        ...optionalString('serviceCharge', params.serviceCharge),
        ...optionalString('tip', params.tip),
        ...optionalString('discounts', params.discounts),
      };
    // equal, percent and shares hold nothing that JSON cannot carry.
    default:
      return { ...params };
  }
}

export function parseSplitParams(raw: unknown): SplitParams {
  if (typeof raw !== 'object' || raw === null) {
    throw new SplitWireError('NOT_AN_OBJECT', 'Split parameters must be an object');
  }
  const params = raw as Record<string, unknown>;

  switch (params.kind) {
    case 'equal':
      return { kind: 'equal' };

    case 'exact':
      return { kind: 'exact', amounts: minorUnitMap(params.amounts, 'amounts') } as ExactParams;

    case 'adjustment':
      return {
        kind: 'adjustment',
        adjustments: minorUnitMap(params.adjustments, 'adjustments'),
      } as AdjustmentParams;

    case 'percent': {
      const basisPoints = params.basisPoints;
      requireRecord(basisPoints, 'basisPoints');
      return {
        kind: 'percent',
        basisPoints: mapValues(basisPoints, (value) => Number(integer(value, 'basisPoints'))),
      };
    }

    case 'shares': {
      const weights = params.weights;
      requireRecord(weights, 'weights');
      return {
        kind: 'shares',
        weights: mapValues(weights, (value) => Number(integer(value, 'weights'))),
      };
    }

    case 'itemized': {
      const items = params.items;
      if (!Array.isArray(items)) {
        throw new SplitWireError('BAD_SHAPE', 'An itemized split needs a list of items');
      }
      requireRecord(params.claims, 'claims');
      return {
        kind: 'itemized',
        items: items.map((item, index) => {
          if (typeof item !== 'object' || item === null) {
            throw new SplitWireError('BAD_SHAPE', `Item ${index} is not an object`);
          }
          const line = item as Record<string, unknown>;
          return {
            ...(typeof line.label === 'string' ? { label: line.label } : {}),
            total: integer(line.total, `items[${index}].total`),
          };
        }),
        claims: params.claims as ItemizedParams['claims'],
        ...optionalBig('taxes', maybeInteger(params.taxes, 'taxes')),
        ...optionalBig('serviceCharge', maybeInteger(params.serviceCharge, 'serviceCharge')),
        ...optionalBig('tip', maybeInteger(params.tip, 'tip')),
        ...optionalBig('discounts', maybeInteger(params.discounts, 'discounts')),
      };
    }

    default:
      throw new SplitWireError('UNKNOWN_KIND', `Unknown split kind: ${String(params.kind)}`);
  }
}

function minorUnitMap(raw: unknown, field: string): Record<MemberId, bigint> {
  requireRecord(raw, field);
  return mapValues(raw, (value) => integer(value, field));
}

/**
 * One number, however it arrived. A float is refused rather than rounded: it
 * cannot have come from a correct client, and rounding it here would put a
 * number in the ledger that nobody chose.
 */
function integer(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new SplitWireError('NOT_AN_INTEGER', `${field}: ${value} is not a whole minor unit`);
    }
    return BigInt(value);
  }
  // Optional sign then digits — the same rule parseAmount holds in
  // sync/protocol.ts, so a payload one boundary accepts the other does not refuse.
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  throw new SplitWireError('NOT_AN_INTEGER', `${field}: ${String(value)} is not a whole number`);
}

function maybeInteger(value: unknown, field: string): bigint | undefined {
  return value === undefined || value === null ? undefined : integer(value, field);
}

function requireRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SplitWireError('BAD_SHAPE', `${field} must be an object`);
  }
}

function mapValues<In, Out>(
  source: Readonly<Record<string, In>>,
  transform: (value: In) => Out,
): Record<string, Out> {
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, transform(value)]));
}

/** Absent stays absent. `{ tip: null }` would read as "no tip", which is not the same as "no tip line". */
function optionalString<K extends string>(
  key: K,
  value: bigint | undefined,
): Record<string, string> {
  return value === undefined ? {} : { [key]: value.toString() };
}

function optionalBig<K extends string>(key: K, value: bigint | undefined): Record<string, bigint> {
  return value === undefined ? {} : { [key]: value };
}
