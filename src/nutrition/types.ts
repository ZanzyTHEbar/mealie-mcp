export type SexForFormula = "male" | "female";

export type ActivityLevel =
  | "sedentary"
  | "light"
  | "moderate"
  | "active"
  | "very_active"
  | "custom";

export type StandardActivityLevel = Exclude<ActivityLevel, "custom">;

export type TdeeFormula = "auto" | "mifflin_st_jeor" | "cunningham";

export type ResolvedTdeeFormula = Exclude<TdeeFormula, "auto">;

export type TdeeGoal = "maintain" | "cut" | "gain" | "custom";

export interface TdeeCalculationInput {
  age_years: number;
  sex_for_formula: SexForFormula;
  height_cm: number;
  weight_kg: number;
  activity_level: ActivityLevel;
  activity_multiplier?: number;
  body_fat_pct?: number;
  formula: TdeeFormula;
  goal: TdeeGoal;
  goal_delta_kcal?: number;
}

export interface ActivityLevelInfo {
  label: string;
  multiplier: number;
  description: string;
}

export interface TdeeCalculationResult {
  formula_used: ResolvedTdeeFormula;
  resting_energy_kcal: number;
  alternative_estimates?: Partial<Record<ResolvedTdeeFormula, number>>;
  activity_multiplier: number;
  tdee_kcal: number;
  selected_goal: TdeeGoal;
  selected_goal_target_kcal: number;
  goal_applied_delta_kcal: number;
  calorie_targets: {
    maintain: number;
    cut_mild: number;
    cut_moderate: number;
    gain_mild: number;
    gain_moderate: number;
    custom?: number;
  };
  input_normalized: {
    age_years: number;
    sex_for_formula: SexForFormula;
    height_cm: number;
    weight_kg: number;
    body_mass_index: number;
    activity_level: ActivityLevel;
    activity_multiplier: number;
    formula_requested: TdeeFormula;
    goal: TdeeGoal;
    body_fat_pct?: number;
    lean_mass_kg?: number;
  };
  assumptions: string[];
  warnings: string[];
  confidence_note: string;
}
