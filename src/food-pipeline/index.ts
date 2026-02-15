/**
 * Food pipeline barrel export.
 */

export type { PriceResult, NutritionInfo, EnrichedItem } from "./types.js";
export { searchContinente } from "./continente-scraper.js";
export { searchNutrition, getNutritionByBarcode } from "./nutrition-lookup.js";
export { extractSearchTerm, enrichIngredient, enrichIngredients } from "./enricher.js";
