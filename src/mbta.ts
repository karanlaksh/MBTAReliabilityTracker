// Minimal MBTA V3 API client.
//
// The V3 API speaks JSON:API. We only need a sliver of it: a `data` array of
// resources, an `included` array of side-loaded resources, and relationship
// pointers between them. We deliberately do not model attributes strictly —
// MBTA adds attributes over time and an over-tight type would reject payloads
// that are perfectly usable.

const BASE = 'https://api-v3.mbta.com';
const TIMEOUT_MS = 10_000;

export interface Resource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id: string; type: string } | null }>;
}

export interface Document {
  data: Resource[];
  included?: Resource[];
}

export class MbtaError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'MbtaError';
  }
}

export class MbtaClient {
  constructor(private readonly apiKey?: string) {}

  async get(path: string, params: Record<string, string>): Promise<Document> {
    const url = new URL(path, BASE);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = { Accept: 'application/vnd.api+json' };
    // Without a key the API allows 20 req/min; with one, 1000. We use 2/min, so
    // the key is about not sharing an anonymous bucket with the whole internet.
    if (this.apiKey) headers['x-api-key'] = this.apiKey;

    const res = await fetch(url.toString(), {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new MbtaError(`${path} returned ${res.status}`, res.status);
    }
    return (await res.json()) as Document;
  }
}

// --- resource helpers -------------------------------------------------------

export function relId(r: Resource, name: string): string | null {
  return r.relationships?.[name]?.data?.id ?? null;
}

export function attrString(r: Resource, name: string): string | null {
  const v = r.attributes?.[name];
  return typeof v === 'string' ? v : null;
}

export function attrNumber(r: Resource, name: string): number | null {
  const v = r.attributes?.[name];
  return typeof v === 'number' ? v : null;
}

/** Structured attributes (alert `active_period`, `informed_entity`). */
export function attrArray<T = Record<string, unknown>>(r: Resource, name: string): T[] {
  const v = r.attributes?.[name];
  return Array.isArray(v) ? (v as T[]) : [];
}

/** ISO 8601 (with offset, as MBTA sends) -> unix epoch seconds. */
export function epochSec(isoTime: string | null): number | null {
  if (!isoTime) return null;
  const ms = Date.parse(isoTime);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** Index an `included` array by resource id, restricted to one type. */
export function indexIncluded(doc: Document, type: string): Map<string, Resource> {
  const out = new Map<string, Resource>();
  for (const r of doc.included ?? []) {
    if (r.type === type) out.set(r.id, r);
  }
  return out;
}

/**
 * Map a platform-level stop id to its parent station id.
 *
 * Predictions and vehicles reference child platforms ('70010'), while
 * watched_stops is keyed on parent stations ('place-rugg'). Normalising to the
 * parent is also what makes prediction stop_ids and vehicle stop_ids comparable
 * to each other, which the matcher depends on.
 */
export function parentStationMap(...docs: Document[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const doc of docs) {
    for (const stop of doc.included ?? []) {
      if (stop.type !== 'stop') continue;
      out.set(stop.id, relId(stop, 'parent_station') ?? stop.id);
    }
  }
  return out;
}
