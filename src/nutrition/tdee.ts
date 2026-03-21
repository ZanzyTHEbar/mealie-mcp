import { resolveActivityMultiplier } from "./activity.js";
import type {
  ResolvedTdeeFormula,
  TdeeCalculationInput,
  TdeeCalculationResult,
  TdeeGoal,
} from "./types.js";

const CUT_MILD_DELTA = -250;
const CUT_MODERATE_DELTA = -500;
const GAIN_MILD_DELTA = 200;
const GAIN_MODERATE_DELTA = 350;

function roundCalories(value: number): number {
  return Math.round(value / 5) * 5;
}

function calculateBodyMassIndex(weightKg: number, heightCm: number): number {
  const heightM = heightCm / 100;
  return weightKg / (heightM * heightM);
}

function calculateLeanMassKg(weightKg: number, bodyFatPct: number): number {
  return weightKg * (1 - bodyFatPct / 100);
}

function calculateMifflinStJeor(
  weightKg: number,
  heightCm: number,
  ageYears: number,
  sexForFormula: TdeeCalculationInput["sex_for_formula"],
): number {
  const sexOffset = sexForFormula === "male" ? 5 : -161;
  return 10 * weightKg + 6.25 * heightCm - 5 * ageYears + sexOffset;
}

function calculateCunningham(leanMassKg: number): number {
  return 500 + 22 * leanMassKg;
}

function getGoalAppliedDelta(goal: TdeeGoal, customDelta?: number): number {
  switch (goal) {
    case "maintain":
      return 0;
    case "cut":
      return CUT_MODERATE_DELTA;
    case "gain":
      return GAIN_MILD_DELTA;
    case "custom":
      return customDelta ?? 0;
  }
}

function buildWarnings(
  input: TdeeCalculationInput,
  bodyMassIndex: number,
  usedFormula: ResolvedTdeeFormula,
): string[] {
  const warnings = [
    "TDEE is an estimate; actual daily energy expenditure can differ meaningfully from formula-based predictions.",
  ];

  if (input.age_years >= 65) {
    warnings.push("Predictive equations may be less accurate in older adults than in younger adult populations.");
  }

  if (bodyMassIndex < 18.5 || bodyMassIndex >= 35) {
    warnings.push("Equation accuracy can decline at body-composition extremes; monitor real-world weight trends and adjust.");
  }

  if (input.activity_level === "custom") {
    warnings.push("A custom activity multiplier was supplied; result quality depends heavily on that estimate.");
  }

  if (input.body_fat_pct != null && (input.body_fat_pct < 8 || input.body_fat_pct > 45)) {
    warnings.push("Body-fat-based estimates become more uncertain when body-fat percentage is at an extreme.");
  }

  if (usedFormula === "cunningham") {
    warnings.push("Cunningham depends on body-fat accuracy; poor body-fat estimates will materially affect the result.");
  }

  return warnings;
}

export function calculateTdee(input: TdeeCalculationInput): TdeeCalculationResult {
  const activityMultiplier = resolveActivityMultiplier(input.activity_level, input.activity_multiplier);
  const bodyMassIndex = calculateBodyMassIndex(input.weight_kg, input.height_cm);
  const leanMassKg = input.body_fat_pct != null
    ? calculateLeanMassKg(input.weight_kg, input.body_fat_pct)
    : undefined;

  const mifflinRaw = calculateMifflinStJeor(
    input.weight_kg,
    input.height_cm,
    input.age_years,
    input.sex_for_formula,
  );
  const cunninghamRaw = leanMassKg != null ? calculateCunningham(leanMassKg) : undefined;

  const formulaUsed: ResolvedTdeeFormula = input.formula === "cunningham"
    ? "cunningham"
    : "mifflin_st_jeor";

  const restingRaw = formulaUsed === "cunningham" ? (cunninghamRaw as number) : mifflinRaw;
  const restingEnergyKcal = roundCalories(restingRaw);
  const tdeeKcal = roundCalories(restingRaw * activityMultiplier);

  const calorieTargets: TdeeCalculationResult["calorie_targets"] = {
    maintain: tdeeKcal,
    cut_mild: roundCalories(tdeeKcal + CUT_MILD_DELTA),
    cut_moderate: roundCalories(tdeeKcal + CUT_MODERATE_DELTA),
    gain_mild: roundCalories(tdeeKcal + GAIN_MILD_DELTA),
    gain_moderate: roundCalories(tdeeKcal + GAIN_MODERATE_DELTA),
  };

  if (input.goal === "custom" && input.goal_delta_kcal != null) {
    calorieTargets.custom = roundCalories(tdeeKcal + input.goal_delta_kcal);
  }

  const goalAppliedDeltaKcal = getGoalAppliedDelta(input.goal, input.goal_delta_kcal);
  const selectedGoalTargetKcal = roundCalories(tdeeKcal + goalAppliedDeltaKcal);

  const alternativeEstimates: Partial<Record<ResolvedTdeeFormula, number>> = {};
  if (formulaUsed !== "mifflin_st_jeor") {
    alternativeEstimates.mifflin_st_jeor = roundCalories(mifflinRaw);
  }
  if (formulaUsed !== "cunningham" && cunninghamRaw != null) {
    alternativeEstimates.cunningham = roundCalories(cunninghamRaw);
  }

  const assumptions = [
    "Mifflin-St Jeor is used as the default adult resting energy equation unless Cunningham is explicitly requested.",
    "Activity multipliers approximate average daily expenditure from weekly lifestyle and training patterns.",
    "alternative_estimates report resting-energy references only; they are not activity-adjusted TDEE values.",
    "tdee_kcal is calculated from the unrounded resting-energy estimate and then rounded to the nearest 5 kcal.",
    'selected_goal uses fixed presets for "cut" (-500 kcal) and "gain" (+200 kcal), while calorie_targets shows additional reference presets.',
    "Calorie targets should be calibrated against 2 to 4 weeks of body-weight and performance trends.",
  ];

  return {
    formula_used: formulaUsed,
    resting_energy_kcal: restingEnergyKcal,
    alternative_estimates: Object.keys(alternativeEstimates).length > 0 ? alternativeEstimates : undefined,
    activity_multiplier: activityMultiplier,
    tdee_kcal: tdeeKcal,
    selected_goal: input.goal,
    selected_goal_target_kcal: selectedGoalTargetKcal,
    goal_applied_delta_kcal: goalAppliedDeltaKcal,
    calorie_targets: calorieTargets,
    input_normalized: {
      age_years: input.age_years,
      sex_for_formula: input.sex_for_formula,
      height_cm: input.height_cm,
      weight_kg: input.weight_kg,
      body_mass_index: Math.round(bodyMassIndex * 10) / 10,
      activity_level: input.activity_level,
      activity_multiplier: activityMultiplier,
      formula_requested: input.formula,
      goal: input.goal,
      body_fat_pct: input.body_fat_pct,
      lean_mass_kg: leanMassKg != null ? Math.round(leanMassKg * 10) / 10 : undefined,
    },
    assumptions,
    warnings: buildWarnings(input, bodyMassIndex, formulaUsed),
    confidence_note:
      "Use this as a starting estimate, then adjust based on multi-week body-weight trend, recovery, hunger, and training performance.",
  };
}
