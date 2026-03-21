export interface CalendarDateParts {
  year: number;
  month: number;
  day: number;
}

function formatCalendarDateParts(parts: CalendarDateParts): string {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function parseCalendarDateString(value: string): CalendarDateParts | null {
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalized = new Date(Date.UTC(year, month - 1, day));

  if (
    normalized.getUTCFullYear() !== year ||
    normalized.getUTCMonth() !== month - 1 ||
    normalized.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

export function normalizeMealPlanEntryDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().slice(0, 10);
  const parsed = parseCalendarDateString(candidate);
  return parsed ? formatCalendarDateParts(parsed) : null;
}

export function getTodayCalendarDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function resolveRequestedStartDate(value: unknown, now = new Date()): string {
  if (value == null || value === "") {
    return getTodayCalendarDate(now);
  }

  if (typeof value !== "string") {
    throw new Error('start_date must be a string in YYYY-MM-DD format.');
  }

  const parsed = parseCalendarDateString(value.trim());
  if (!parsed) {
    throw new Error(`Invalid start_date "${value}". Use a real calendar date in YYYY-MM-DD format.`);
  }

  return formatCalendarDateParts(parsed);
}

export function addCalendarDays(dateString: string, days: number): string {
  const parsed = parseCalendarDateString(dateString);
  if (!parsed) {
    throw new Error(`Invalid calendar date "${dateString}".`);
  }

  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

export function normalizeIngredientLine(ingredient: unknown): string | null {
  if (typeof ingredient === "string") {
    const trimmed = ingredient.trim();
    return trimmed || null;
  }

  if (ingredient && typeof ingredient === "object") {
    const candidate = (ingredient as Record<string, unknown>).display
      ?? (ingredient as Record<string, unknown>).note
      ?? (ingredient as Record<string, unknown>).name;
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      return trimmed || null;
    }
  }

  return null;
}

export function normalizeIngredientLines(rawIngredients: unknown): string[] {
  if (!Array.isArray(rawIngredients)) return [];

  return rawIngredients
    .map((ingredient) => normalizeIngredientLine(ingredient))
    .filter((line): line is string => Boolean(line));
}
