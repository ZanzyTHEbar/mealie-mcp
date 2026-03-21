#!/usr/bin/env node
/**
 * Deterministic tests for meal-planning helper utilities.
 * Run after build: npm run build && node scripts/test-meal-planning.mjs
 */
import { fileURLToPath, pathToFileURL } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildPath = pathToFileURL(path.join(__dirname, "..", "build", "meal-planning", "index.js")).href;

function ok(cond, msg) {
  if (cond) {
    console.log("  ✓", msg);
    return true;
  }
  console.log("  ✗", msg);
  return false;
}

async function main() {
  const planning = await import(buildPath);
  const {
    addCalendarDays,
    normalizeIngredientLines,
    normalizeMealPlanEntryDate,
    resolveRequestedStartDate,
  } = planning;

  let passed = 0;
  let failed = 0;

  function eq(actual, expected, msg) {
    const same = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok(same, same ? msg : `${msg} (got: ${JSON.stringify(actual)}, expected: ${JSON.stringify(expected)})`)) {
      passed++;
    } else {
      failed++;
    }
  }

  console.log("date helpers");
  eq(addCalendarDays("2026-03-23", 7), "2026-03-30", "adds calendar days without timezone drift");
  eq(normalizeMealPlanEntryDate("2026-03-23T18:45:00.000Z"), "2026-03-23", "normalizes ISO timestamps to calendar dates");
  eq(resolveRequestedStartDate(undefined, new Date("2026-03-21T12:00:00Z")), "2026-03-21", "defaults missing start date to today");

  try {
    resolveRequestedStartDate("2026-02-30");
    failed++;
    console.log("  ✗ rejects impossible calendar dates");
  } catch {
    passed++;
    console.log("  ✓ rejects impossible calendar dates");
  }

  console.log("\ningredient normalization");
  eq(
    normalizeIngredientLines([
      "2 onions",
      { display: "400g chickpeas" },
      { note: "1 lemon" },
      { name: "olive oil" },
      { nope: "ignored" },
      "",
      null,
    ]),
    ["2 onions", "400g chickpeas", "1 lemon", "olive oil"],
    "normalizes mixed ingredient line formats",
  );

  console.log("\nTotal:", passed, "passed,", failed, "failed");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
