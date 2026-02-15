#!/usr/bin/env node
/**
 * Live tests for the food-pipeline: real HTTP calls to Continente.pt and Open Food Facts.
 * Run after build: npm run build && node scripts/test-food-pipeline-live.mjs
 *
 * Set SKIP_CONTINENTE=1 or SKIP_NUTRITION=1 to skip flaky or rate-limited endpoints.
 */
import { fileURLToPath } from "url";
import path from "path";
import { pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildPath = pathToFileURL(path.join(__dirname, "..", "build", "food-pipeline", "index.js")).href;

const SKIP_CONTINENTE = process.env.SKIP_CONTINENTE === "1";
const SKIP_NUTRITION = process.env.SKIP_NUTRITION === "1";

function ok(cond, msg) {
  if (cond) {
    console.log("  ✓", msg);
    return true;
  }
  console.log("  ✗", msg);
  return false;
}

function assertArray(arr, msg) {
  const valid = Array.isArray(arr);
  return ok(valid, valid ? msg : `${msg} (got ${typeof arr})`);
}

function assertPriceResult(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (typeof obj.store !== "string") return false;
  if (typeof obj.productName !== "string") return false;
  return true;
}

function assertNutritionInfo(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (typeof obj.source !== "string") return false;
  return true;
}

function assertEnrichedItem(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (typeof obj.originalName !== "string" || typeof obj.searchTerm !== "string") return false;
  if (!Array.isArray(obj.prices)) return false;
  return true;
}

async function main() {
  const fp = await import(buildPath);
  const { searchContinente, searchNutrition, getNutritionByBarcode, enrichIngredient } = fp;
  let passed = 0;
  let failed = 0;

  // --- Continente.pt live ---
  if (!SKIP_CONTINENTE) {
    console.log("\n[Live] Continente.pt searchContinente('leite', 2)");
    try {
      const results = await searchContinente("leite", 2);
      const isArray = Array.isArray(results);
      if (ok(isArray, "returns array")) passed++;
      else failed++;

      if (results.length > 0) {
        const first = results[0];
        const validFirst = assertPriceResult(first);
        if (ok(validFirst, "first item has store + productName")) passed++;
        else failed++;
        if (first.priceEur != null) {
          if (ok(typeof first.priceEur === "number", "priceEur is number")) passed++;
          else failed++;
        }
      } else {
        console.log("  (0 results – site may have changed or rate-limited)");
      }
    } catch (err) {
      failed++;
      console.log("  ✗", err?.message ?? err);
    }
  } else {
    console.log("\n[Live] Continente skipped (SKIP_CONTINENTE=1)");
  }

  // --- Open Food Facts search ---
  if (!SKIP_NUTRITION) {
    console.log("\n[Live] Open Food Facts searchNutrition('milk')");
    try {
      const info = await searchNutrition("milk");
      const hasValid = info === null || assertNutritionInfo(info);
      if (ok(hasValid, "returns null or NutritionInfo with source")) passed++;
      else failed++;
      if (info && hasValid) {
        if (ok(typeof info.source === "string", "source is string")) passed++;
        else failed++;
      }
    } catch (err) {
      failed++;
      console.log("  ✗", err?.message ?? err);
    }

    console.log("\n[Live] Open Food Facts getNutritionByBarcode('3017620422003')");
    try {
      const info = await getNutritionByBarcode("3017620422003");
      const valid = info === null || assertNutritionInfo(info);
      if (ok(valid, "returns null or NutritionInfo")) passed++;
      else failed++;
    } catch (err) {
      failed++;
      console.log("  ✗", err?.message ?? err);
    }
  } else {
    console.log("\n[Live] Open Food Facts skipped (SKIP_NUTRITION=1)");
  }

  // --- Full enrich one ingredient (hits both Continente + OFF) ---
  if (!SKIP_CONTINENTE || !SKIP_NUTRITION) {
    console.log("\n[Live] enrichIngredient('olive oil', undefined, { maxPriceResults: 1 })");
    try {
      const enriched = await enrichIngredient("olive oil", undefined, {
        maxPriceResults: 1,
        skipPrice: SKIP_CONTINENTE,
        skipNutrition: SKIP_NUTRITION,
      });
      const validItem = assertEnrichedItem(enriched);
      if (ok(validItem, "returns EnrichedItem (originalName, searchTerm, prices)")) passed++;
      else failed++;
      if (validItem && ok(enriched.searchTerm === "olive oil", "searchTerm === 'olive oil'")) passed++;
      else if (validItem && enriched.searchTerm) failed++;
    } catch (err) {
      failed++;
      console.log("  ✗", err?.message ?? err);
    }
  }

  console.log("\n---");
  console.log("Live tests:", passed, "passed,", failed, "failed");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
