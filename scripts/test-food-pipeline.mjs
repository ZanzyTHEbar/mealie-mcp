#!/usr/bin/env node
/**
 * Smoke and unit tests for the food-pipeline module.
 * Run after build: npm run build && node scripts/test-food-pipeline.mjs
 */
import { fileURLToPath } from "url";
import path from "path";
import { pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildPath = path.join(__dirname, "..", "build", "food-pipeline", "index.js");

async function main() {
  const fp = await import(pathToFileURL(buildPath).href);
  const {
    extractSearchTerm,
    parsePackFromUnitSize,
    parsePricePerUnitDisplay,
    parseIngredientNeed,
    scaleIngredientNeed,
    formatIngredientNeed,
    enrichPriceResults,
    estimateLineCost,
    selectBestPriceForNeed,
    getScrapers,
    getCachedPriceSearch,
    setCachedPriceSearch,
    clearCache,
    searchAllStores,
  } = fp;
  let passed = 0;
  let failed = 0;

  function ok(cond, msg) {
    if (cond) {
      passed++;
      console.log("  ✓", msg);
    } else {
      failed++;
      console.log("  ✗", msg);
    }
  }

  function eq(actual, expected, msg) {
    const same = actual === expected;
    ok(same, same ? msg : `${msg} (got: ${JSON.stringify(actual)}, expected: ${JSON.stringify(expected)})`);
  }

  console.log("extractSearchTerm");
  eq(extractSearchTerm("600g lamb shoulder, cut into 3cm cubes"), "lamb shoulder", "quantity + prep -> product");
  eq(extractSearchTerm("1 can (400g) chickpeas, drained"), "chickpeas", "can + quantity -> product");
  eq(extractSearchTerm("2 tbsp olive oil"), "olive oil", "tbsp quantity -> product");
  eq(extractSearchTerm("Fresh cilantro and mint"), "Fresh cilantro", "and -> first item");
  eq(extractSearchTerm("quinoa"), "quinoa", "single word");
  eq(extractSearchTerm("  chicken breast  "), "chicken breast", "trim");
  eq(extractSearchTerm("Toppings: cheese"), "cheese", "prefix removed");
  eq(extractSearchTerm("salt (to taste)"), "salt", "trailing parenthetical");

  console.log("\nparsePackFromUnitSize");
  const p500 = parsePackFromUnitSize("500 g");
  ok(p500?.packGrams === 500, "500 g -> packGrams 500");
  const p6x33 = parsePackFromUnitSize("6 x 33 cl");
  ok(p6x33?.packMl === 1980 && p6x33?.unitCount === 6, "6 x 33 cl -> 1980 ml, count 6");
  const p12un = parsePackFromUnitSize("12 un");
  ok(p12un?.unitCount === 12, "12 un -> unitCount 12");
  const pEmbKg = parsePackFromUnitSize("emb. 1 kg");
  ok(pEmbKg?.packGrams === 1000, "emb. 1 kg -> packGrams 1000");
  const pEmbMulti = parsePackFromUnitSize("emb. 4 x 90 gr");
  ok(pEmbMulti?.packGrams === 360 && pEmbMulti?.unitCount === 4, "emb. 4 x 90 gr -> 360 g, count 4");

  console.log("\nparsePricePerUnitDisplay");
  const ppu = parsePricePerUnitDisplay("€ 2,50 / kg");
  ok(ppu.imputedPricePerKgEur === 2.5, "per-kg string");

  console.log("\nparseIngredientNeed");
  const need = parseIngredientNeed("600g flour", undefined);
  ok(need?.grams === 600, "leading grams in note");
  const needQ = parseIngredientNeed("flour", "250 ml");
  ok(needQ?.ml === 250, "quantity field ml");
  const needEach = parseIngredientNeed("2 onions", undefined);
  ok(needEach?.each === 2, "leading count in note -> each");
  const scaledNeed = scaleIngredientNeed({ grams: 600 }, 0.75);
  ok(scaledNeed?.grams === 450, "scaleIngredientNeed scales parsed quantity");
  eq(formatIngredientNeed(scaledNeed), "450 g", "formatIngredientNeed serializes scaled quantity");

  console.log("\nenrichPriceResults + estimateLineCost");
  const rows = enrichPriceResults([
    {
      store: "Continente",
      productName: "Test",
      priceEur: 2,
      unitSize: "500 g",
    },
  ]);
  ok(rows[0].normalizedPack?.packGrams === 500, "normalized pack grams");
  const est = estimateLineCost(rows[0], { grams: 600 });
  ok(est.estimatedCostEur === 4 && est.basis === "pack_scale_grams" && est.packsUsed === 2, "600g need vs 500g pack -> 2 packs");
  const best = selectBestPriceForNeed(
    enrichPriceResults([
      { store: "A", productName: "Large pack", priceEur: 2.5, unitSize: "1 kg" },
      { store: "B", productName: "Small pack", priceEur: 1.5, unitSize: "500 g" },
    ]),
    { grams: 600 }
  );
  ok(
    best?.price.store === "A" && best?.estimate.estimatedCostEur === 2.5,
    "selectBestPriceForNeed chooses lowest line cost, not lowest sticker price"
  );

  console.log("\ngetScrapers stub flags");
  const scrapers = getScrapers();
  const aldi = scrapers.find((s) => s.name === "Aldi");
  const lidl = scrapers.find((s) => s.name === "Lidl");
  ok(aldi?.isStub === true && lidl?.isStub === true, "Aldi/Lidl marked isStub");

  console.log("\nprice cache (negative + outcomes)");
  clearCache();
  const u = `__cache_test_empty_${Date.now()}`;
  setCachedPriceSearch(u, {
    prices: [],
    storeOutcomes: [
      { store: "Continente", status: "empty", resultCount: 0 },
      { store: "Lidl", status: "stub_disabled", resultCount: 0 },
    ],
  }, 3);
  const roundtrip = getCachedPriceSearch(u, 3);
  ok(
    roundtrip &&
    roundtrip.prices.length === 0 &&
    roundtrip.storeOutcomes.length === 2,
    "empty price payload round-trips with storeOutcomes"
  );
  setCachedPriceSearch(`${u}_variant`, {
    prices: [{ store: "Continente", productName: "One", priceEur: 1 }],
    storeOutcomes: [{ store: "Continente", status: "ok", resultCount: 1 }],
  }, 1);
  setCachedPriceSearch(`${u}_variant`, {
    prices: [{ store: "Continente", productName: "Three", priceEur: 3 }],
    storeOutcomes: [{ store: "Continente", status: "ok", resultCount: 1 }],
  }, 3);
  ok(
    getCachedPriceSearch(`${u}_variant`, 1)?.prices[0]?.productName === "One" &&
    getCachedPriceSearch(`${u}_variant`, 3)?.prices[0]?.productName === "Three",
    "price cache key includes max results variant"
  );
  clearCache();

  console.log("\nsearchAllStores shape (no network: empty query)");
  const emptyQ = await searchAllStores("   ");
  ok(
    Array.isArray(emptyQ.results) &&
    Array.isArray(emptyQ.storeOutcomes) &&
    emptyQ.results.length === 0,
    "invalid query returns SearchAllStoresResult"
  );

  console.log("\nTotal:", passed, "passed,", failed, "failed");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
