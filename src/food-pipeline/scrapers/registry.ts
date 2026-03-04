/**
 * Registry of grocery store scrapers (adapters).
 * Add new scrapers here so the enricher uses them automatically.
 */
import type { GroceryScraperAdapter, PriceResult } from "../types.js";
import { continenteAdapter } from "./continente.js";
import { pingoDoceAdapter } from "./pingo-doce.js";
import { aldiAdapter } from "./aldi.js";
import { lidlAdapter } from "./lidl.js";

const SCRAPERS: GroceryScraperAdapter[] = [
  continenteAdapter,
  pingoDoceAdapter,
  aldiAdapter,
  lidlAdapter,
];

/**
 * Returns all registered scrapers. Users can add custom adapters by
 * pushing to the returned array or by registering before first use.
 */
export function getScrapers(): GroceryScraperAdapter[] {
  return SCRAPERS;
}

/**
 * Register an additional scraper (e.g. from user code).
 */
export function registerScraper(adapter: GroceryScraperAdapter): void {
  if (!SCRAPERS.some((s) => s.name === adapter.name)) {
    SCRAPERS.push(adapter);
  }
}

/**
 * Search all registered stores and merge results (per-store limit applied).
 * Results are ordered by store, then by price ascending when available.
 *
 * @param query - Search term (must be non-empty string, max 200 chars)
 * @param maxPerStore - Maximum results per store (1-50, default 3)
 * @returns Array of PriceResult sorted by price ascending
 */
export async function searchAllStores(
  query: string,
  maxPerStore = 3
): Promise<PriceResult[]> {
  // Input validation
  if (typeof query !== 'string' || !query.trim()) {
    console.warn('[registry] Empty or invalid query provided to searchAllStores');
    return [];
  }
  const sanitizedQuery = query.trim();
  if (sanitizedQuery.length > 200) {
    console.warn('[registry] Query exceeds 200 characters, truncating');
    query = sanitizedQuery.slice(0, 200);
  } else {
    query = sanitizedQuery;
  }

  // Validate maxPerStore bounds
  let perStore = Math.min(Math.max(maxPerStore, 1), 50);

  const results = await Promise.all(
    getScrapers().map(async (s) => {
      try {
        return await s.search(query, perStore);
      } catch (err) {
        console.error(`[registry] Scraper "${s.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
        return []; // Return empty on individual scraper failure
      }
    })
  );
  const merged = results.flat();
  const withPrice = merged.filter((p): p is PriceResult & { priceEur: number } => p.priceEur != null);
  const withoutPrice = merged.filter((p) => p.priceEur == null);
  withPrice.sort((a, b) => a.priceEur - b.priceEur);
  return [...withPrice, ...withoutPrice];
}
