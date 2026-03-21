/**
 * Shopping list enrichment logic.
 *
 * Caching: Price and nutrition results use TTL (ENRICHMENT_CACHE_TTL_HOURS).
 * Empty price searches are cached. Price cache keys include ENRICHMENT_CACHE_SCHEMA_VERSION.
 */

import { searchAllStores } from "./scrapers/registry.js";
import { searchNutrition } from "./nutrition-lookup.js";
import type { EnrichedItem } from "./types.js";
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
  formatIngredientNeed,
  isLiquidVolumeConversionEnabled,
  parseIngredientNeed,
  scaleIngredientNeed,
  selectBestPriceForNeed,
} from "./price-normalize.js";
import { extractSearchTerm } from "./query-normalize.js";
import {
  enrichmentLinesFromRecipeIngredients,
  type EnrichmentLineInput,
} from "./mealie-enrichment-input.js";

export type { EnrichmentLineInput } from "./mealie-enrichment-input.js";

/**
 * Scale structured recipe ingredient lines for target servings (preserves Mealie quantity/unit when parseable).
 */
export function scaleEnrichmentLinesForServings(
  recipeIngredient: unknown,
  scaleFactor: number
): EnrichmentLineInput[] {
  const lines = enrichmentLinesFromRecipeIngredients(recipeIngredient);
  if (
    scaleFactor === 1 ||
    !Number.isFinite(scaleFactor) ||
    scaleFactor <= 0
  ) {
    return lines;
  }
  const liq = isLiquidVolumeConversionEnabled();
  return lines.map((input) => {
    const need = parseIngredientNeed(input.note, input.quantity, {
      mealiePlainEach: input.mealiePlainQuantityIsEach === true,
      liquidVolumeConversions: liq,
    });
    const scaled = scaleIngredientNeed(need, scaleFactor);
    return {
      note: input.note,
      quantity: scaled ? formatIngredientNeed(scaled) : input.quantity,
      mealiePlainQuantityIsEach: scaled ? false : input.mealiePlainQuantityIsEach,
    };
  });
}

/**
 * Enrich a single line (prefer this for Mealie-structured quantity/unit).
 */
export async function enrichIngredientLine(
  line: EnrichmentLineInput,
  options?: {
    skipPrice?: boolean;
    skipNutrition?: boolean;
    maxPriceResults?: number;
    skipCache?: boolean;
  }
): Promise<EnrichedItem> {
  const { note, quantity, mealiePlainQuantityIsEach } = line;
  const searchTerm = extractSearchTerm(note);
  const maxResults = options?.maxPriceResults ?? 3;
  const useCache = isCacheEnabled() && !options?.skipCache;

  const item: EnrichedItem = {
    originalName: note,
    searchTerm,
    quantity,
    prices: [],
  };

  if (!options?.skipPrice) {
    const cachedPrice = useCache ? getCachedPriceSearch(searchTerm, maxResults) : undefined;

    if (cachedPrice !== undefined) {
      item.prices = cachedPrice.prices;
      item.storeSearchOutcomes = cachedPrice.storeOutcomes;
      if (item.prices.length > 0) {
        item.prices = enrichPriceResults(item.prices);
      }
    } else {
      const { results, storeOutcomes } = await searchAllStores(searchTerm, maxResults);
      item.prices = results;
      item.storeSearchOutcomes = storeOutcomes;
      if (useCache) {
        setCachedPriceSearch(
          searchTerm,
          {
            prices: results,
            storeOutcomes,
          },
          maxResults
        );
      }
    }

    const need = parseIngredientNeed(note, quantity, {
      mealiePlainEach: mealiePlainQuantityIsEach === true,
      liquidVolumeConversions: isLiquidVolumeConversionEnabled(),
    });
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
 * Back-compat: enrich from raw strings (no Mealie plain-each semantics).
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
  return enrichIngredientLine(
    { note, quantity, mealiePlainQuantityIsEach: false },
    options
  );
}

/**
 * Enrich multiple lines (shopping list / recipe ingredients).
 */
export async function enrichIngredients(
  items: EnrichmentLineInput[],
  options?: {
    skipPrice?: boolean;
    skipNutrition?: boolean;
    maxPriceResults?: number;
  }
): Promise<EnrichedItem[]> {
  const results: EnrichedItem[] = [];
  for (const line of items) {
    results.push(await enrichIngredientLine(line, options));
  }
  return results;
}
