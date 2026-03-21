/**
 * Shopping list enrichment logic.
 *
 * Combines all registered grocery scrapers (Continente, Pingo Doce, Aldi, Lidl, etc.)
 * and Open Food Facts nutrition lookup into a single enrichment step per ingredient.
 * Also includes the search-term extraction heuristic.
 *
 * Caching: Price and nutrition results are cached with 24h TTL (configurable via
 * ENRICHMENT_CACHE_TTL_HOURS environment variable). Set ENRICHMENT_CACHE_ENABLED=false
 * to disable caching. Empty price results are cached (negative cache).
 */

import { searchAllStores } from "./scrapers/registry.js";
import { searchNutrition } from "./nutrition-lookup.js";
import type { EnrichedItem, PriceResult } from "./types.js";
import {
  getCachedPriceSearch,
  setCachedPriceSearch,
  getCachedNutrition,
  setCachedNutrition,
  isCacheEnabled,
} from "./cache.js";
import {
  enrichPriceResults,
  estimateLineCost,
  parseIngredientNeed,
  selectBestPriceForNeed,
} from "./price-normalize.js";

/**
 * Extract a clean search term from a raw shopping-list note.
 *
 * Examples:
 *   "600g lamb shoulder, cut into 3cm cubes" -> "lamb shoulder"
 *   "1 can (400g) chickpeas, drained"        -> "chickpeas"
 *   "2 tbsp olive oil"                       -> "olive oil"
 *   "Fresh cilantro and mint"                -> "Fresh cilantro"
 */
export function extractSearchTerm(note: string): string {
  let text = note.trim();

  // Remove leading quantity patterns: "600g", "1 can (400g)", "2 tbsp", "1/2 tsp"
  text = text.replace(
    /^[\d/]+\s*(?:g|kg|ml|l|tbsp|tsp|cup|cups|can|cans|bunch|bunches|large|medium|small|cloves?|slices?|stalks?|sheets?)?\s*(?:\([^)]*\))?\s*/i,
    ""
  );

  // Remove preparation instructions after comma
  text = text.split(",")[0].trim();

  // Remove "for serving", "for garnish", etc.
  text = text.replace(/\bfor\s+\w+$/i, "").trim();

  // Remove "Toppings:", "For tadka:", etc.
  text = text.replace(/^(?:Toppings|For\s+\w+):\s*/i, "").trim();

  // Take first item if "and" separated
  if (text.toLowerCase().includes(" and ")) {
    text = text.split(/ and /i)[0].trim();
  }

  // Remove trailing parentheticals
  text = text.replace(/\s*\([^)]*\)\s*$/, "").trim();

  return text || note.trim();
}

/**
 * Enrich a single ingredient string with price and nutrition data.
 *
 * Results are automatically cached with TTL to avoid repeated API calls.
 */
export async function enrichIngredient(
  note: string,
  quantity?: string,
  options?: {
    skipPrice?: boolean;
    skipNutrition?: boolean;
    maxPriceResults?: number;
    skipCache?: boolean;
  }
): Promise<EnrichedItem> {
  const searchTerm = extractSearchTerm(note);
  const maxResults = options?.maxPriceResults ?? 3;
  const useCache = isCacheEnabled() && !options?.skipCache;

  const item: EnrichedItem = {
    originalName: note,
    searchTerm,
    quantity,
    prices: [],
  };

  // 1. Price lookup (with caching, including negative cache)
  if (!options?.skipPrice) {
    const cachedPrice = useCache ? getCachedPriceSearch(searchTerm, maxResults) : undefined;

    if (cachedPrice !== undefined) {
      item.prices = cachedPrice.prices;
      item.storeSearchOutcomes = cachedPrice.storeOutcomes;
      if (item.prices.length > 0) {
        item.prices = enrichPriceResults(item.prices);
      }
    } else {
      const { results, storeOutcomes } = await searchAllStores(
        searchTerm,
        maxResults
      );
      item.prices = results;
      item.storeSearchOutcomes = storeOutcomes;
      if (useCache) {
        setCachedPriceSearch(searchTerm, {
          prices: results,
          storeOutcomes,
        }, maxResults);
      }
    }

    const need = parseIngredientNeed(note, quantity);
    const selection = selectBestPriceForNeed(item.prices, need);
    if (selection) {
      item.cheapestPrice = selection.price;
      const est = selection.estimate ?? estimateLineCost(item.cheapestPrice, need);
      item.estimatedCostEur = est.estimatedCostEur;
      item.costEstimateBasis = est.basis;
      if (est.packsUsed != null) {
        item.packsUsed = est.packsUsed;
      }
      item.imageUrl = item.cheapestPrice.imageUrl;
    }
  }

  // 2. Nutrition lookup (with caching)
  if (!options?.skipNutrition) {
    if (useCache) {
      const cached = getCachedNutrition(searchTerm);
      if (cached !== undefined) {
        item.nutrition = cached ?? undefined;
      }
    }

    if (item.nutrition === undefined) {
      const nutrition = await searchNutrition(searchTerm);
      if (useCache) {
        setCachedNutrition(searchTerm, nutrition);
      }
      item.nutrition = nutrition ?? undefined;
    }
  }

  return item;
}

/**
 * Enrich multiple ingredient strings.
 */
export async function enrichIngredients(
  items: Array<{ note: string; quantity?: string }>,
  options?: {
    skipPrice?: boolean;
    skipNutrition?: boolean;
    maxPriceResults?: number;
  }
): Promise<EnrichedItem[]> {
  const results: EnrichedItem[] = [];
  for (const { note, quantity } of items) {
    results.push(await enrichIngredient(note, quantity, options));
  }
  return results;
}
