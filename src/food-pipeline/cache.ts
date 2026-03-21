/**
 * In-memory TTL cache for enrichment results.
 *
 * Caches price lookups and nutrition data to avoid repeated
 * scraping/API calls for the same search terms.
 * Empty price searches are cached (negative cache) like nutrition misses.
 * Default TTL: 24 hours
 */

import { createHash } from "node:crypto";
import type { NutritionInfo, PriceResult, StoreSearchOutcome } from "./types.js";

/** Price leg cache value: product rows plus per-store coverage metadata. */
export interface CachedPriceSearchPayload {
  prices: PriceResult[];
  storeOutcomes: StoreSearchOutcome[];
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface CacheStats {
  priceHits: number;
  priceMisses: number;
  nutritionHits: number;
  nutritionMisses: number;
  size: number;
}

// Default TTL: 24 hours in milliseconds
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

// In-memory cache storage
const priceCache = new Map<string, CacheEntry<CachedPriceSearchPayload>>();
const nutritionCache = new Map<string, CacheEntry<NutritionInfo | null>>();

// Cache statistics for monitoring
let stats: CacheStats = {
  priceHits: 0,
  priceMisses: 0,
  nutritionHits: 0,
  nutritionMisses: 0,
  size: 0,
};

/**
 * Get the configured TTL from environment or use default.
 */
function getTTL(): number {
  const envTtl = process.env.ENRICHMENT_CACHE_TTL_HOURS;
  if (envTtl) {
    const hours = parseInt(envTtl, 10);
    if (!isNaN(hours) && hours > 0) {
      return hours * 60 * 60 * 1000;
    }
  }
  return DEFAULT_TTL_MS;
}

const KEY_INLINE_MAX = 220;
const PRICE_SCOPE = "price";
const NUTRITION_SCOPE = "nutrition";

/** Bump via env after breaking price-parser or cache payload shape changes. */
function getActivePriceSchemaVersion(): string {
  const v = process.env.ENRICHMENT_CACHE_SCHEMA_VERSION?.trim();
  return v && v.length > 0 ? v : "0";
}

function priceCacheSchemaVariantsForInvalidation(): string[] {
  const s = new Set<string>();
  for (let i = 0; i <= 64; i++) {
    s.add(String(i));
  }
  const e = process.env.ENRICHMENT_CACHE_SCHEMA_VERSION?.trim();
  if (e) {
    s.add(e);
  }
  return [...s];
}

/**
 * Generate a cache key from a search term.
 * Long terms use a stable hash to avoid collisions from truncation.
 */
function generateKey(searchTerm: string, scope: string, variant?: string): string {
  const normalized = searchTerm.toLowerCase().trim().replace(/\s+/g, " ");
  const base = variant ? `${scope}|${variant}|${normalized}` : `${scope}|${normalized}`;
  if (base.length <= KEY_INLINE_MAX) {
    return base;
  }
  return `h:${createHash("sha256").update(base).digest("hex")}`;
}

function generatePriceKeyWithSchema(
  searchTerm: string,
  maxResults: number,
  schemaVersion: string
): string {
  const bounded = Math.min(Math.max(maxResults, 1), 50);
  return generateKey(searchTerm, PRICE_SCOPE, `v=${schemaVersion}|max=${bounded}`);
}

function generatePriceKey(searchTerm: string, maxResults: number): string {
  return generatePriceKeyWithSchema(searchTerm, maxResults, getActivePriceSchemaVersion());
}

function generateNutritionKey(searchTerm: string): string {
  return generateKey(searchTerm, NUTRITION_SCOPE);
}

/**
 * Check if a cache entry is still valid (not expired).
 */
function isValid<T>(entry: CacheEntry<T> | undefined): boolean {
  if (!entry) return false;
  return Date.now() < entry.expiresAt;
}

/**
 * Get cached price search (including empty results / negative cache).
 * @returns Payload or undefined if not found/expired.
 */
export function getCachedPriceSearch(
  searchTerm: string,
  maxResults = 3
): CachedPriceSearchPayload | undefined {
  const key = generatePriceKey(searchTerm, maxResults);
  const entry = priceCache.get(key);

  if (entry && isValid(entry)) {
    stats.priceHits++;
    console.log(`[cache] Price cache HIT for "${searchTerm}"`);
    return entry.value;
  }

  if (entry) {
    priceCache.delete(key);
  }
  stats.priceMisses++;
  return undefined;
}

/**
 * Store price search results and per-store outcomes (empty arrays allowed).
 */
export function setCachedPriceSearch(
  searchTerm: string,
  payload: CachedPriceSearchPayload,
  maxResults = 3
): void {
  const key = generatePriceKey(searchTerm, maxResults);
  const ttl = getTTL();

  priceCache.set(key, {
    value: payload,
    expiresAt: Date.now() + ttl,
  });

  console.log(
    `[cache] Cached ${payload.prices.length} price row(s) + ${payload.storeOutcomes.length} store outcome(s) for "${searchTerm}" (TTL: ${ttl / 1000 / 60 / 60}h)`
  );
  updateStats();
}

/**
 * Get cached nutrition info for a search term.
 * @returns Cached nutrition or undefined if not found/expired.
 */
export function getCachedNutrition(searchTerm: string): NutritionInfo | null | undefined {
  const key = generateNutritionKey(searchTerm);
  const entry = nutritionCache.get(key);

  if (entry && isValid(entry)) {
    stats.nutritionHits++;
    console.log(`[cache] Nutrition cache HIT for "${searchTerm}"`);
    return entry.value;
  }

  // Remove expired entry
  if (entry) {
    nutritionCache.delete(key);
  }
  stats.nutritionMisses++;
  return undefined;
}

/**
 * Store nutrition info in cache.
 * Stores null values to cache "not found" results and avoid repeated lookups.
 */
export function setCachedNutrition(searchTerm: string, nutrition: NutritionInfo | null): void {
  const key = generateNutritionKey(searchTerm);
  const ttl = getTTL();

  nutritionCache.set(key, {
    value: nutrition,
    expiresAt: Date.now() + ttl,
  });

  console.log(`[cache] Cached nutrition for "${searchTerm}" (TTL: ${ttl / 1000 / 60 / 60}h)`);
  updateStats();
}

/**
 * Invalidate all cached entries.
 */
export function clearCache(): void {
  priceCache.clear();
  nutritionCache.clear();
  stats = { priceHits: 0, priceMisses: 0, nutritionHits: 0, nutritionMisses: 0, size: 0 };
  console.log("[cache] Cache cleared");
}

/**
 * Get current cache statistics.
 */
export function getCacheStats(): CacheStats & {
  priceHitRate: number;
  nutritionHitRate: number;
  totalRequests: number;
} {
  const totalPrice = stats.priceHits + stats.priceMisses;
  const totalNutrition = stats.nutritionHits + stats.nutritionMisses;

  return {
    ...stats,
    size: priceCache.size + nutritionCache.size,
    priceHitRate: totalPrice > 0 ? Math.round((stats.priceHits / totalPrice) * 100) : 0,
    nutritionHitRate: totalNutrition > 0 ? Math.round((stats.nutritionHits / totalNutrition) * 100) : 0,
    totalRequests: totalPrice + totalNutrition,
  };
}

/**
 * Manually invalidate a specific search term.
 */
export function invalidateCacheEntry(searchTerm: string): void {
  for (const schema of priceCacheSchemaVariantsForInvalidation()) {
    for (let maxResults = 1; maxResults <= 50; maxResults++) {
      priceCache.delete(generatePriceKeyWithSchema(searchTerm, maxResults, schema));
    }
  }
  nutritionCache.delete(generateNutritionKey(searchTerm));
  console.log(`[cache] Invalidated cache for "${searchTerm}"`);
}

/**
 * Remove expired entries (cleanup).
 * Can be called periodically if needed.
 */
export function cleanupExpired(): number {
  const now = Date.now();
  let removed = 0;

  for (const [key, entry] of priceCache.entries()) {
    if (now >= entry.expiresAt) {
      priceCache.delete(key);
      removed++;
    }
  }

  for (const [key, entry] of nutritionCache.entries()) {
    if (now >= entry.expiresAt) {
      nutritionCache.delete(key);
      removed++;
    }
  }

  if (removed > 0) {
    console.log(`[cache] Cleaned up ${removed} expired entries`);
    updateStats();
  }

  return removed;
}

function updateStats(): void {
  stats.size = priceCache.size + nutritionCache.size;
}

/**
 * Check if caching is enabled via environment variable.
 * Default: true (enabled)
 */
export function isCacheEnabled(): boolean {
  const envValue = process.env.ENRICHMENT_CACHE_ENABLED?.toLowerCase();
  return envValue !== "false" && envValue !== "0" && envValue !== "no";
}
