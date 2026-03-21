/**
 * Shared types for the food enrichment pipeline.
 *
 * Covers price data from grocery store scrapers, nutritional data from
 * Open Food Facts, and the combined enriched item structure.
 */

/** Outcome of a single-store price search (coverage / health). */
export type StoreOutcomeStatus = "ok" | "empty" | "error" | "stub_disabled";

export interface StoreSearchOutcome {
  store: string;
  status: StoreOutcomeStatus;
  resultCount: number;
  errorMessage?: string;
}

/** Return shape from multi-store search. */
export interface SearchAllStoresResult {
  results: PriceResult[];
  storeOutcomes: StoreSearchOutcome[];
}

/**
 * Parsed pack / unit metadata derived from scraper strings (unitSize, pricePerUnit).
 * Used for fair comparison and quantity-aware line estimates.
 */
export interface NormalizedPackInfo {
  /** Total net weight of the priced pack (grams). */
  packGrams?: number;
  /** Total net volume of the priced pack (milliliters). */
  packMl?: number;
  /** Number of units in a multi-pack (e.g. 6 cans). */
  unitCount?: number;
  /** EUR per kg when parsed from shelf label or imputed from pack price. */
  imputedPricePerKgEur?: number;
  /** EUR per liter when parsed from shelf label or imputed from pack price. */
  imputedPricePerLiterEur?: number;
}

/**
 * Adapter interface for grocery store price scrapers.
 * Implement this to add a new store; register in scrapers/registry.ts.
 */
export interface GroceryScraperAdapter {
  /** Store display name (e.g. "Continente", "Pingo Doce"). */
  readonly name: string;
  /**
   * When true, the registry records `stub_disabled` and does not call `search`.
   * Use for placeholders until a real scraper exists.
   */
  readonly isStub?: boolean;
  /** Search the store and return price results. */
  search(query: string, maxResults?: number): Promise<PriceResult[]>;
}

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
  /** Filled by the normalization pass when unit strings are parseable. */
  normalizedPack?: NormalizedPackInfo;
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
  /** How `estimatedCostEur` was derived (sticker vs pack scaling vs per-kg). */
  costEstimateBasis?: string;
  /** Number of retail packs implied when pack scaling was used. */
  packsUsed?: number;
  /** Per-store fetch outcome for the price leg (mirrors last search for this term). */
  storeSearchOutcomes?: StoreSearchOutcome[];
  imageUrl?: string;
}
