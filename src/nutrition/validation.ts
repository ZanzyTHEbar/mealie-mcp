import { z } from "zod";
import type { TdeeCalculationInput } from "./types.js";

export const tdeeCalculationInputSchema = z
  .object({
    age_years: z.coerce.number().int().min(18).max(100),
    sex_for_formula: z.enum(["male", "female"]),
    height_cm: z.coerce.number().min(100).max(250),
    weight_kg: z.coerce.number().min(30).max(400),
    activity_level: z.enum(["sedentary", "light", "moderate", "active", "very_active", "custom"]),
    activity_multiplier: z.coerce.number().min(1.1).max(2.5).optional(),
    body_fat_pct: z.coerce.number().min(2).max(70).optional(),
    formula: z.enum(["auto", "mifflin_st_jeor", "cunningham"]).default("auto"),
    goal: z.enum(["maintain", "cut", "gain", "custom"]).default("maintain"),
    goal_delta_kcal: z.coerce.number().min(-2000).max(2000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.activity_level === "custom" && value.activity_multiplier == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activity_multiplier"],
        message: 'activity_multiplier is required when activity_level is "custom".',
      });
    }

    if (value.formula === "cunningham" && value.body_fat_pct == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body_fat_pct"],
        message: 'body_fat_pct is required when formula is "cunningham".',
      });
    }

    if (value.goal === "custom" && value.goal_delta_kcal == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["goal_delta_kcal"],
        message: 'goal_delta_kcal is required when goal is "custom".',
      });
    }
  });

export function parseTdeeCalculationInput(input: unknown): TdeeCalculationInput {
  return tdeeCalculationInputSchema.parse(input);
}
