/**
 * Shopping list enrichment logic.
 *
 * Combines Continente price scraping and Open Food Facts nutrition lookup
 * into a single enrichment step per ingredient. Also includes the search-
 * term extraction heuristic that cleans raw shopping-list note text into
 * a clean product query.
 */

import { searchContinente } from "./continente-scraper.js";
import { searchNutrition } from "./nutrition-lookup.js";
import type { EnrichedItem, PriceResult } from "./types.js";

/**
 * Extract a clean search term from a raw shopping-list note.
 *
 * Examples:
 *   "600g lamb shoulder, cut into 3cm cubes" -> "lamb shoulder"
 *   "1 can (400g) chickpeas, drained"        -> "chickpeas"
 *   "2 tbsp olive oil"                       -> "olive oil"
 *   "Fresh cilantro and mint"                -> "cilantro"
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
 */
export async function enrichIngredient(
  note: string,
  quantity?: string,
  options?: { skipPrice?: boolean; skipNutrition?: boolean; maxPriceResults?: number }
): Promise<EnrichedItem> {
  const searchTerm = extractSearchTerm(note);
  const maxResults = options?.maxPriceResults ?? 3;

  const item: EnrichedItem = {
    originalName: note,
    searchTerm,
    quantity,
    prices: [],
  };

  // 1. Price lookup
  if (!options?.skipPrice) {
    item.prices = await searchContinente(searchTerm, maxResults);

    const priced = item.prices.filter((p): p is PriceResult & { priceEur: number } => p.priceEur != null);
    if (priced.length > 0) {
      item.cheapestPrice = priced.reduce((a, b) => (a.priceEur < b.priceEur ? a : b));
      item.estimatedCostEur = item.cheapestPrice.priceEur;
      item.imageUrl = item.cheapestPrice.imageUrl;
    }
  }

  // 2. Nutrition lookup
  if (!options?.skipNutrition) {
    item.nutrition = (await searchNutrition(searchTerm)) ?? undefined;
  }

  return item;
}

/**
 * Enrich multiple ingredient strings.
 */
export async function enrichIngredients(
  items: Array<{ note: string; quantity?: string }>,
  options?: { skipPrice?: boolean; skipNutrition?: boolean; maxPriceResults?: number }
): Promise<EnrichedItem[]> {
  const results: EnrichedItem[] = [];
  for (const { note, quantity } of items) {
    results.push(await enrichIngredient(note, quantity, options));
  }
  return results;
}
