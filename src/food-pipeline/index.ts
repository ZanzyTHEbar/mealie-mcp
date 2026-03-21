/**
 * Food pipeline barrel export.
 */

export type {
  PriceResult,
  NutritionInfo,
  EnrichedItem,
  GroceryScraperAdapter,
  StoreSearchOutcome,
  SearchAllStoresResult,
  NormalizedPackInfo,
} from "./types.js";
export { searchContinente } from "./continente-scraper.js";
export { getScrapers, registerScraper, searchAllStores } from "./scrapers/registry.js";
export { searchNutrition, getNutritionByBarcode } from "./nutrition-lookup.js";
export { extractSearchTerm, enrichIngredient, enrichIngredients } from "./enricher.js";
export {
  parsePackFromUnitSize,
  parsePricePerUnitDisplay,
  parseIngredientNeed,
  scaleIngredientNeed,
  formatIngredientNeed,
  normalizePriceResult,
  enrichPriceResults,
  estimateLineCost,
  selectBestPriceForNeed,
} from "./price-normalize.js";
export type { CachedPriceSearchPayload } from "./cache.js";
export {
  getCachedPriceSearch,
  setCachedPriceSearch,
  getCachedNutrition,
  setCachedNutrition,
  getCacheStats,
  clearCache,
  invalidateCacheEntry,
  cleanupExpired,
  isCacheEnabled,
} from "./cache.js";
export {
  getCachedRegistry,
  invalidateRegistryCache,
  getRegistryCacheStats,
} from "./metadata-cache.js";
export {
  createSession,
  getSession,
  updateSession,
  deleteSession,
  getSessionCache,
  cleanupExpiredSessions,
  getSessionStats,
  clearAllSessions,
  type SessionContext,
} from "./session-context.js";
