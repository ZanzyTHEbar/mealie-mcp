/**
 * Open Food Facts nutritional data lookup.
 *
 * Uses the Open Food Facts REST API directly (no SDK needed) to search
 * for products and extract nutritional information per 100 g.
 *
 * @see https://wiki.openfoodfacts.org/API
 */

import axios from "axios";
import type { NutritionInfo } from "./types.js";

const OFF_SEARCH_URL = "https://world.openfoodfacts.org/cgi/search.pl";
const OFF_PRODUCT_URL = "https://world.openfoodfacts.org/api/v2/product";
const USER_AGENT = "FoodPipeline/1.0 (mealie-mcp)";

function safeFloat(val: unknown): number | undefined {
  if (val == null) return undefined;
  const n = parseFloat(String(val));
  return isNaN(n) ? undefined : n;
}

function extractNutrition(
  nutriments: Record<string, any>,
  sourceName: string
): NutritionInfo | null {
  const calories = safeFloat(nutriments["energy-kcal_100g"]);
  const protein = safeFloat(nutriments["proteins_100g"]);

  // Skip products with no useful nutritional data
  if (calories == null && protein == null) return null;

  return {
    caloriesKcal: calories,
    proteinG: protein,
    fatG: safeFloat(nutriments["fat_100g"]),
    carbsG: safeFloat(nutriments["carbohydrates_100g"]),
    fiberG: safeFloat(nutriments["fiber_100g"]),
    sugarG: safeFloat(nutriments["sugars_100g"]),
    saltG: safeFloat(nutriments["salt_100g"]),
    source: sourceName,
  };
}

/**
 * Search Open Food Facts by ingredient name and return the first match
 * that has nutritional data.
 */
export async function searchNutrition(
  ingredientName: string
): Promise<NutritionInfo | null> {
  try {
    const resp = await axios.get(OFF_SEARCH_URL, {
      params: {
        search_terms: ingredientName,
        search_simple: 1,
        action: "process",
        json: 1,
        page_size: 5,
        cc: "pt",
        lc: "pt",
      },
      headers: { "User-Agent": USER_AGENT },
      timeout: 10_000,
    });

    const data = resp.data;
    if (!data || typeof data !== "object") return null;
    const products: any[] = Array.isArray(data.products) ? data.products : [];

    for (const product of products) {
      const nutriments = product?.nutriments;
      if (!nutriments || typeof nutriments !== "object") continue;

      const info = extractNutrition(
        nutriments,
        `OpenFoodFacts (${product.product_name ?? "unknown"})`
      );
      if (info) return info;
    }
  } catch (err: any) {
    console.error(
      `[nutrition] Error searching '${ingredientName}':`,
      err?.message ?? err
    );
  }
  return null;
}

/**
 * Look up nutritional info by product barcode (EAN/UPC).
 */
export async function getNutritionByBarcode(
  barcode: string
): Promise<NutritionInfo | null> {
  try {
    const resp = await axios.get(`${OFF_PRODUCT_URL}/${barcode}.json`, {
      headers: { "User-Agent": USER_AGENT },
      timeout: 10_000,
    });

    if (resp.data?.status !== 1) return null;

    const nutriments = resp.data?.product?.nutriments;
    if (!nutriments || typeof nutriments !== "object") return null;

    return extractNutrition(
      nutriments,
      `OpenFoodFacts (barcode: ${barcode})`
    );
  } catch (err: any) {
    console.error(
      `[nutrition] Error fetching barcode '${barcode}':`,
      err?.message ?? err
    );
  }
  return null;
}
