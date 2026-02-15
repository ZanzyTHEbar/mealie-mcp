/**
 * Shared types for the food enrichment pipeline.
 *
 * Covers price data from grocery store scrapers, nutritional data from
 * Open Food Facts, and the combined enriched item structure.
 */

/** A single price result from a grocery store scraper. */
export interface PriceResult {
  store: string;
  productName: string;
  brand?: string;
  priceEur?: number;
  pricePerUnit?: string;
  unitSize?: string;
  discountPct?: string;
  originalPrice?: string;
  promotion?: string;
  imageUrl?: string;
  productUrl?: string;
  category?: string;
}

/** Nutritional information per 100 g. */
export interface NutritionInfo {
  caloriesKcal?: number;
  proteinG?: number;
  fatG?: number;
  carbsG?: number;
  fiberG?: number;
  sugarG?: number;
  saltG?: number;
  source: string;
}

/** A shopping-list item enriched with price and nutrition data. */
export interface EnrichedItem {
  originalName: string;
  searchTerm: string;
  quantity?: string;
  prices: PriceResult[];
  cheapestPrice?: PriceResult;
  nutrition?: NutritionInfo;
  estimatedCostEur?: number;
  imageUrl?: string;
}
