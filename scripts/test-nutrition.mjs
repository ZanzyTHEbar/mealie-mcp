#!/usr/bin/env node
/**
 * Deterministic tests for the nutrition/TDEE module.
 * Run after build: npm run build && node scripts/test-nutrition.mjs
 */
import { fileURLToPath, pathToFileURL } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildPath = pathToFileURL(path.join(__dirname, "..", "build", "nutrition", "index.js")).href;

function ok(cond, msg) {
  if (cond) {
    console.log("  ✓", msg);
    return true;
  }
  console.log("  ✗", msg);
  return false;
}

async function main() {
  const nutrition = await import(buildPath);
  const { calculateTdee, parseTdeeCalculationInput } = nutrition;
  let passed = 0;
  let failed = 0;

  function eq(actual, expected, msg) {
    const same = actual === expected;
    if (ok(same, same ? msg : `${msg} (got: ${JSON.stringify(actual)}, expected: ${JSON.stringify(expected)})`)) {
      passed++;
    } else {
      failed++;
    }
  }

  console.log("validation");
  try {
    parseTdeeCalculationInput({
      age_years: 30,
      sex_for_formula: "male",
      height_cm: 180,
      weight_kg: 80,
      activity_level: "custom",
    });
    failed++;
    console.log('  ✗ custom activity level requires activity_multiplier');
  } catch {
    passed++;
    console.log('  ✓ custom activity level requires activity_multiplier');
  }

  try {
    parseTdeeCalculationInput({
      age_years: 30,
      sex_for_formula: "female",
      height_cm: 165,
      weight_kg: 60,
      activity_level: "moderate",
      formula: "cunningham",
    });
    failed++;
    console.log('  ✗ cunningham requires body_fat_pct');
  } catch {
    passed++;
    console.log('  ✓ cunningham requires body_fat_pct');
  }

  console.log("\ncalculateTdee");
  const maleModerate = calculateTdee(
    parseTdeeCalculationInput({
      age_years: 30,
      sex_for_formula: "male",
      height_cm: 180,
      weight_kg: 80,
      activity_level: "moderate",
      formula: "auto",
      goal: "maintain",
    }),
  );
  eq(maleModerate.formula_used, "mifflin_st_jeor", "auto defaults to Mifflin-St Jeor");
  eq(maleModerate.resting_energy_kcal, 1780, "male resting energy matches Mifflin-St Jeor");
  eq(maleModerate.tdee_kcal, 2760, "male moderate TDEE uses 1.55 multiplier");
  eq(maleModerate.selected_goal_target_kcal, 2760, "maintain goal matches TDEE");

  const femaleCut = calculateTdee(
    parseTdeeCalculationInput({
      age_years: 28,
      sex_for_formula: "female",
      height_cm: 165,
      weight_kg: 60,
      activity_level: "light",
      goal: "cut",
    }),
  );
  eq(femaleCut.resting_energy_kcal, 1330, "female resting energy rounds correctly");
  eq(femaleCut.tdee_kcal, 1830, "female light activity TDEE rounds correctly");
  eq(femaleCut.selected_goal_target_kcal, 1330, "default cut target applies a 500 kcal deficit");

  const autoWithBodyFat = calculateTdee(
    parseTdeeCalculationInput({
      age_years: 35,
      sex_for_formula: "male",
      height_cm: 175,
      weight_kg: 80,
      body_fat_pct: 20,
      activity_level: "active",
      formula: "auto",
      goal: "maintain",
    }),
  );
  eq(autoWithBodyFat.formula_used, "mifflin_st_jeor", "auto keeps Mifflin-St Jeor as the primary formula");
  eq(autoWithBodyFat.alternative_estimates?.cunningham, 1910, "auto exposes Cunningham as an alternative resting estimate");

  const cunningham = calculateTdee(
    parseTdeeCalculationInput({
      age_years: 35,
      sex_for_formula: "male",
      height_cm: 175,
      weight_kg: 80,
      body_fat_pct: 20,
      activity_level: "active",
      formula: "cunningham",
      goal: "custom",
      goal_delta_kcal: -300,
    }),
  );
  eq(cunningham.formula_used, "cunningham", "explicit Cunningham request is honored");
  eq(cunningham.input_normalized.lean_mass_kg, 64, "lean mass derived from body fat percentage");
  eq(cunningham.resting_energy_kcal, 1910, "Cunningham resting energy is computed correctly");
  eq(cunningham.tdee_kcal, 3290, "Cunningham TDEE uses active multiplier");
  eq(cunningham.selected_goal_target_kcal, 2990, "custom goal delta is applied");
  eq(cunningham.alternative_estimates?.mifflin_st_jeor, 1725, "alternative Mifflin estimate is returned");
  eq(cunningham.calorie_targets.custom, 2990, "custom target is included in calorie targets");

  console.log("\nTotal:", passed, "passed,", failed, "failed");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
