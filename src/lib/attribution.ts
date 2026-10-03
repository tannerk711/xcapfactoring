// Ad-click attribution for the lead webhook (2026-10-02). Captured on EVERY
// page load (Base.astro) into localStorage, so a visitor who lands on the
// homepage from an ad and then clicks through to /audit still carries the
// click. Every key is optional: organic leads send empty strings so the Zap
// always sees the same flat shape and Tanner maps each field once.
//
// Shared by the browser island (parse, store, collect) and the API route +
// webhook (normalize, flatten). No zod here: this file ships to the client.

export const AD_PARAM_KEYS = [
  // Google auto-tagging click ids (gclid; gbraid/wbraid on iOS app traffic)
  'gclid',
  'gbraid',
  'wbraid',
  // The campaign's tracking suffix (ads/campaigns/contract-audit-search):
  // utm_source=google&utm_medium=cpc&utm_campaign=...&utm_content={adgroup}-ad1&utm_term={keyword}
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  // ValueTrack extras, if a future suffix adds them
  'campaignid',
  'adgroupid',
  'keyword',
  'matchtype',
  'device',
  'network',
] as const;

export type AdParamKey = (typeof AD_PARAM_KEYS)[number];
export type AdParams = Record<AdParamKey, string>;

export interface AttributionRecord {
  params: AdParams; // '' when absent
  landingPage: string; // the page that carried the click (or the first page seen, organic)
  referrer: string;
  firstSeenAt: string; // ISO timestamp of the capture
}

const STORAGE_KEY = 'xcap_attribution_v1';
const TTL_MS = 90 * 24 * 60 * 60 * 1000; // gclid validity window
const MAX_PARAM_LEN = 200;
const MAX_URL_LEN = 500;

export function emptyParams(): AdParams {
  const out = {} as AdParams;
  for (const k of AD_PARAM_KEYS) out[k] = '';
  return out;
}

/** Pull the allowlisted params out of a query string. Unknown keys are ignored. */
export function parseAdParams(search: string): AdParams {
  const out = emptyParams();
  let sp: URLSearchParams;
  try {
    sp = new URLSearchParams(search);
  } catch {
    return out;
  }
  for (const k of AD_PARAM_KEYS) {
    const v = sp.get(k);
    if (v) out[k] = v.trim().slice(0, MAX_PARAM_LEN);
  }
  return out;
}

export const hasAdClick = (p: AdParams): boolean => !!(p.gclid || p.gbraid || p.wbraid);
export const hasAnyParam = (p: AdParams): boolean => AD_PARAM_KEYS.some((k) => !!p[k]);

/** One stable string for the CRM's lead-source field. */
export function deriveLeadSource(p: AdParams): string {
  if (hasAdClick(p)) return 'google_ads';
  if (p.utm_source) {
    const src = p.utm_source.toLowerCase();
    const med = (p.utm_medium || '').toLowerCase();
    if (src === 'google' && (med === 'cpc' || med === 'ppc' || med === 'paid')) return 'google_ads';
    return med ? `${src}/${med}` : src;
  }
  return 'organic';
}

/**
 * Server-side normalizer: whatever the browser sent becomes a complete record
 * with only allowlisted keys, every value a bounded string.
 */
export function normalizeAttribution(input: unknown): AttributionRecord {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const rawParams = (src.params && typeof src.params === 'object' ? src.params : {}) as Record<string, unknown>;
  const params = emptyParams();
  for (const k of AD_PARAM_KEYS) {
    const v = rawParams[k];
    if (typeof v === 'string' && v.trim()) params[k] = v.trim().slice(0, MAX_PARAM_LEN);
  }
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  return {
    params,
    landingPage: str(src.landingPage, MAX_URL_LEN),
    referrer: str(src.referrer, MAX_URL_LEN),
    firstSeenAt: str(src.firstSeenAt, 64),
  };
}

/** The flat keys that ride on the lead webhook. Always every key, '' when absent. */
export function toLeadWebhookFields(attr: AttributionRecord | undefined): Record<string, string> {
  const a = attr ?? normalizeAttribution(undefined);
  const p = a.params;
  return {
    lead_source: deriveLeadSource(p),
    gclid: p.gclid,
    gbraid: p.gbraid,
    wbraid: p.wbraid,
    utm_source: p.utm_source,
    utm_medium: p.utm_medium,
    utm_campaign: p.utm_campaign,
    utm_term: p.utm_term,
    utm_content: p.utm_content,
    campaign_id: p.campaignid,
    adgroup_id: p.adgroupid,
    keyword: p.keyword,
    matchtype: p.matchtype,
    device: p.device,
    network: p.network,
    landing_page: a.landingPage,
    referrer: a.referrer,
    first_seen_at: a.firstSeenAt,
  };
}

// ---------------------------------------------------------------------------
// Browser side. The environment is injectable so the logic tests without a DOM.

export interface BrowserEnv {
  search: string;
  href: string;
  referrer: string;
  now: () => Date;
  storage: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null;
}

function defaultEnv(): BrowserEnv | null {
  if (typeof window === 'undefined') return null;
  let storage: BrowserEnv['storage'] = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null; // private mode / blocked storage: capture still works for the current page
  }
  return {
    search: window.location.search,
    href: window.location.href,
    referrer: typeof document !== 'undefined' ? document.referrer : '',
    now: () => new Date(),
    storage,
  };
}

interface Stored extends AttributionRecord {
  storedAt: number;
}

export function readStoredAttribution(env: BrowserEnv | null = defaultEnv()): AttributionRecord | null {
  if (!env?.storage) return null;
  try {
    const raw = env.storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (typeof parsed.storedAt !== 'number' || env.now().getTime() - parsed.storedAt > TTL_MS) return null;
    return normalizeAttribution(parsed);
  } catch {
    return null;
  }
}

/**
 * Run on every page load. A URL carrying ad params always wins (the newest
 * click is the one Google will attribute); otherwise the first page seen is
 * kept so organic leads still carry a landing page and referrer.
 */
export function captureAttribution(env: BrowserEnv | null = defaultEnv()): AttributionRecord | null {
  if (!env) return null;
  const fresh = parseAdParams(env.search);
  const existing = readStoredAttribution(env);
  if (existing && !hasAnyParam(fresh)) return existing;
  const record: AttributionRecord = {
    params: fresh,
    landingPage: env.href.slice(0, MAX_URL_LEN),
    referrer: env.referrer.slice(0, MAX_URL_LEN),
    firstSeenAt: env.now().toISOString(),
  };
  if (env.storage) {
    try {
      const stored: Stored = { ...record, storedAt: env.now().getTime() };
      env.storage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // storage full or blocked: the record still returns for this page
    }
  }
  return record;
}

/** At submit: the stored record, or the current URL when storage was unavailable. */
export function collectAttribution(env: BrowserEnv | null = defaultEnv()): AttributionRecord {
  if (!env) return normalizeAttribution(undefined);
  const stored = readStoredAttribution(env);
  const current = parseAdParams(env.search);
  if (stored && (hasAnyParam(stored.params) || !hasAnyParam(current))) return stored;
  return {
    params: current,
    landingPage: env.href.slice(0, MAX_URL_LEN),
    referrer: env.referrer.slice(0, MAX_URL_LEN),
    firstSeenAt: env.now().toISOString(),
  };
}
