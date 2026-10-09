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
    buildSearchQueries,
    extractSearchTerm,
    normalizeSearchText,
    scoreSearchMatch,
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
    mergeEnrichmentLines,
    searchAllStores,
    scaleEnrichmentLinesForServings,
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
  eq(extractSearchTerm("Fresh cilantro and mint"), "cilantro", "descriptor + and -> first core item");
  eq(extractSearchTerm("quinoa"), "quinoa", "single word");
  eq(extractSearchTerm("  chicken breast  "), "chicken breast", "trim");
  eq(extractSearchTerm("Toppings: cheese"), "cheese", "prefix removed");
  eq(extractSearchTerm("salt (to taste)"), "salt", "trailing parenthetical");
  eq(extractSearchTerm("extra virgin olive oil"), "olive oil", "leading descriptors removed");
  eq(extractSearchTerm("emb. 4 x 90 gr iogurte natural"), "iogurte natural", "packaging prefix removed");
  eq(extractSearchTerm("cebola roxa picada"), "cebola roxa", "trailing prep removed for Portuguese note");

  console.log("\nquery normalization + scoring");
  eq(normalizeSearchText("Azeite Virgem Extra"), "azeite virgem extra", "normalizeSearchText strips casing/diacritics");
  eq(JSON.stringify(buildSearchQueries("cebola roxa picada")), JSON.stringify(["cebola roxa", "cebola"]), "buildSearchQueries adds simpler qualifier-free fallback");
  ok(
    scoreSearchMatch("azeite", "Azeite Virgem Extra Oliveira") >
    scoreSearchMatch("azeite", "Arroz Agulha Longo"),
    "scoreSearchMatch prefers relevant product names"
  );

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
  ok(parseIngredientNeed("2", undefined) == null, "plain number in note is not each (ambiguous)");
  const needPlainQty = parseIngredientNeed("flour", "3", { mealiePlainEach: true });
  ok(needPlainQty?.each === 3, "plain Mealie quantity + mealiePlainEach -> each");
  const needUn = parseIngredientNeed("3 un cebola", undefined);
  ok(needUn?.each === 3, "3 un -> explicit count unit");
  const needPcs = parseIngredientNeed("2 pcs garlic", undefined);
  ok(needPcs?.each === 2, "2 pcs -> each");
  const needOilMl = parseIngredientNeed("2 tbsp olive oil", undefined, {
    liquidVolumeConversions: true,
  });
  ok(needOilMl?.ml === 30, "tbsp on liquid note -> ml when liquidVolumeConversions");
  const scaledNeed = scaleIngredientNeed({ grams: 600 }, 0.75);
  ok(scaledNeed?.grams === 450, "scaleIngredientNeed scales parsed quantity");
  eq(formatIngredientNeed(scaledNeed), "450 g", "formatIngredientNeed serializes scaled quantity");
  const scaledEggLines = scaleEnrichmentLinesForServings([
    {
      food: { name: "eggs" },
      quantity: 2,
    },
  ], 0.5);
  eq(scaledEggLines[0]?.quantity, "1", "scaled plain-count recipe ingredient serializes to bare number");
  ok(
    scaledEggLines[0]?.mealiePlainQuantityIsEach === true &&
    parseIngredientNeed(
      scaledEggLines[0].note,
      scaledEggLines[0].quantity,
      { mealiePlainEach: scaledEggLines[0].mealiePlainQuantityIsEach }
    )?.each === 1,
    "scaled plain-count recipe ingredient keeps mealiePlainEach semantics"
  );

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
  const ambRow = enrichPriceResults([
    { store: "X", productName: "6-pack", priceEur: 2, unitSize: "6 un" },
  ])[0];
  const ambEst = estimateLineCost(ambRow, { each: 2 });
  ok(
    ambEst.basis === "sticker_each_vs_multipack_ambiguous" && ambEst.estimatedCostEur === 2,
    "each need vs multipack unitCount without pack mass -> sticker + ambiguous basis"
  );

  console.log("\ngetScrapers stub flags");
  const scrapers = getScrapers();
  const aldi = scrapers.find((s) => s.name === "Aldi");
  const lidl = scrapers.find((s) => s.name === "Lidl");
  ok(aldi?.isStub === true && lidl?.isStub === true, "Aldi/Lidl marked isStub");

  console.log("\nmergeEnrichmentLines");
  const mergedFlour = mergeEnrichmentLines(
    { note: "flour", quantity: "500 g", mealiePlainQuantityIsEach: false },
    { note: "flour", quantity: "200 g", mealiePlainQuantityIsEach: false }
  );
  ok(
    mergedFlour?.quantity === "700 g" && mergedFlour.mealiePlainQuantityIsEach === false,
    "mergeEnrichmentLines sums structured gram quantities for duplicate notes"
  );
  const mergedEggs = mergeEnrichmentLines(
    { note: "eggs", quantity: "2", mealiePlainQuantityIsEach: true },
    { note: "eggs", quantity: "3", mealiePlainQuantityIsEach: true }
  );
  ok(
    mergedEggs?.quantity === "5" && mergedEggs.mealiePlainQuantityIsEach === true,
    "mergeEnrichmentLines preserves plain-each hint for duplicate count quantities"
  );
  ok(
    mergeEnrichmentLines(
      { note: "flour", quantity: "500 g", mealiePlainQuantityIsEach: false },
      { note: "flour", quantity: "2", mealiePlainQuantityIsEach: true }
    ) == null,
    "mergeEnrichmentLines refuses incompatible duplicate quantities"
  );

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
  const prevSchema = process.env.ENRICHMENT_CACHE_SCHEMA_VERSION;
  process.env.ENRICHMENT_CACHE_SCHEMA_VERSION = "schema_test_a";
  clearCache();
  const sk = `__cache_schema_${Date.now()}`;
  setCachedPriceSearch(
    sk,
    { prices: [], storeOutcomes: [{ store: "Continente", status: "empty", resultCount: 0 }] },
    3
  );
  ok(getCachedPriceSearch(sk, 3) != null, "hit under schema A");
  process.env.ENRICHMENT_CACHE_SCHEMA_VERSION = "schema_test_b";
  ok(getCachedPriceSearch(sk, 3) == null, "miss after ENRICHMENT_CACHE_SCHEMA_VERSION bump");
  if (prevSchema === undefined) {
    delete process.env.ENRICHMENT_CACHE_SCHEMA_VERSION;
  } else {
    process.env.ENRICHMENT_CACHE_SCHEMA_VERSION = prevSchema;
  }
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
