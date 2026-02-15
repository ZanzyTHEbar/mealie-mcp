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
  const { extractSearchTerm } = fp;
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

  console.log("\nTotal:", passed, "passed,", failed, "failed");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
