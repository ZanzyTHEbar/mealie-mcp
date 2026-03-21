import type { ActivityLevel, ActivityLevelInfo, StandardActivityLevel } from "./types.js";

export const ACTIVITY_LEVELS: Record<StandardActivityLevel, ActivityLevelInfo> = {
  sedentary: {
    label: "Sedentary",
    multiplier: 1.2,
    description: "Little to no intentional exercise; mostly seated daily routine.",
  },
  light: {
    label: "Lightly active",
    multiplier: 1.375,
    description: "Light exercise or sport 1 to 3 days per week.",
  },
  moderate: {
    label: "Moderately active",
    multiplier: 1.55,
    description: "Moderate exercise or sport 3 to 5 days per week.",
  },
  active: {
    label: "Active",
    multiplier: 1.725,
    description: "Hard exercise or sport 6 to 7 days per week.",
  },
  very_active: {
    label: "Very active",
    multiplier: 1.9,
    description: "Very hard training, physical job, or two-a-day sessions.",
  },
};

export function resolveActivityMultiplier(
  activityLevel: ActivityLevel,
  customMultiplier?: number,
): number {
  if (activityLevel === "custom") {
    if (customMultiplier == null) {
      throw new Error('A custom "activity_multiplier" is required when activity_level is "custom".');
    }
    return customMultiplier;
  }

  return ACTIVITY_LEVELS[activityLevel].multiplier;
}
