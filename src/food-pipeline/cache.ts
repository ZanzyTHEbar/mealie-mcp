/**
 * In-memory TTL cache for enrichment results.
 *
 * Caches price lookups and nutrition data to avoid repeated
 * scraping/API calls for the same search terms.
 * Default TTL: 24 hours
 */

import type { EnrichedItem, PriceResult, NutritionInfo } from "./types.js";

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
const priceCache = new Map<string, CacheEntry<PriceResult[]>>();
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

/**
 * Generate a cache key from a search term.
 * Normalizes the term for consistent caching.
 */
function generateKey(searchTerm: string): string {
  return searchTerm
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 100); // Limit key length
}

/**
 * Check if a cache entry is still valid (not expired).
 */
function isValid<T>(entry: CacheEntry<T> | undefined): boolean {
  if (!entry) return false;
  return Date.now() < entry.expiresAt;
}

/**
 * Get cached price results for a search term.
 * @returns Cached results or undefined if not found/expired.
 */
export function getCachedPrices(searchTerm: string): PriceResult[] | undefined {
  const key = generateKey(searchTerm);
  const entry = priceCache.get(key);

  if (entry && isValid(entry)) {
    stats.priceHits++;
    console.log(`[cache] Price cache HIT for "${searchTerm}"`);
    return entry.value;
  }

  // Remove expired entry
  if (entry) {
    priceCache.delete(key);
  }
  stats.priceMisses++;
  return undefined;
}

/**
 * Store price results in cache.
 */
export function setCachedPrices(searchTerm: string, prices: PriceResult[]): void {
  const key = generateKey(searchTerm);
  const ttl = getTTL();

  priceCache.set(key, {
    value: prices,
    expiresAt: Date.now() + ttl,
  });

  console.log(`[cache] Cached ${prices.length} price results for "${searchTerm}" (TTL: ${ttl / 1000 / 60 / 60}h)`);
  updateStats();
}

/**
 * Get cached nutrition info for a search term.
 * @returns Cached nutrition or undefined if not found/expired.
 */
export function getCachedNutrition(searchTerm: string): NutritionInfo | null | undefined {
  const key = generateKey(searchTerm);
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
  const key = generateKey(searchTerm);
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
  const key = generateKey(searchTerm);
  priceCache.delete(key);
  nutritionCache.delete(key);
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
