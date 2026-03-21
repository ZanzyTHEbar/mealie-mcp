/**
 * Registry of grocery store scrapers (adapters).
 * Add new scrapers here so the enricher uses them automatically.
 */
import type {
  GroceryScraperAdapter,
  PriceResult,
  SearchAllStoresResult,
  StoreSearchOutcome,
} from "../types.js";
import { enrichPriceResults } from "../price-normalize.js";
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
 * Results are sorted by price ascending when `priceEur` is present, then
 * normalized with `normalizedPack` where unit strings allow.
 *
 * @param query - Search term (must be non-empty string, max 200 chars)
 * @param maxPerStore - Maximum results per store (1-50, default 3)
 */
export async function searchAllStores(
  query: string,
  maxPerStore = 3
): Promise<SearchAllStoresResult> {
  if (typeof query !== "string" || !query.trim()) {
    console.warn("[registry] Empty or invalid query provided to searchAllStores");
    return { results: [], storeOutcomes: [] };
  }
  const sanitizedQuery = query.trim();
  if (sanitizedQuery.length > 200) {
    console.warn("[registry] Query exceeds 200 characters, truncating");
    query = sanitizedQuery.slice(0, 200);
  } else {
    query = sanitizedQuery;
  }

  const perStore = Math.min(Math.max(maxPerStore, 1), 50);

  const pairs = await Promise.all(
    getScrapers().map(
      async (
        s
      ): Promise<{ rows: PriceResult[]; outcome: StoreSearchOutcome }> => {
        if (s.isStub === true) {
          return {
            rows: [],
            outcome: {
              store: s.name,
              status: "stub_disabled",
              resultCount: 0,
            },
          };
        }
        try {
          const r = await s.search(query, perStore);
          return {
            rows: r,
            outcome: {
              store: s.name,
              status: r.length > 0 ? "ok" : "empty",
              resultCount: r.length,
            },
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[registry] Scraper "${s.name}" failed: ${msg}`);
          return {
            rows: [],
            outcome: {
              store: s.name,
              status: "error",
              resultCount: 0,
              errorMessage: msg,
            },
          };
        }
      }
    )
  );

  const merged = pairs.flatMap((p) => p.rows);
  const storeOutcomes = pairs.map((p) => p.outcome);
  const withPrice = merged.filter(
    (p): p is PriceResult & { priceEur: number } => p.priceEur != null
  );
  const withoutPrice = merged.filter((p) => p.priceEur == null);
  withPrice.sort((a, b) => a.priceEur - b.priceEur);
  const sorted = [...withPrice, ...withoutPrice];
  const results = enrichPriceResults(sorted);
  return { results, storeOutcomes };
}
