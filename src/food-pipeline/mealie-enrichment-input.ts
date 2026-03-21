/**
 * Map Mealie API payloads (shopping list rows, recipe ingredients) into enrichment line inputs.
 */

export interface EnrichmentLineInput {
  note: string;
  quantity?: string;
  /**
   * When true, a numeric-only `quantity` string from Mealie means "N items" (each),
   * not an arbitrary scalar. Enables plain-number parsing only for structured API data.
   */
  mealiePlainQuantityIsEach?: boolean;
}

function trimStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t || undefined;
}

/**
 * Shopping list listItem → enrichment input (display + quantity/unit when present).
 */
export function enrichmentLineFromShoppingListItem(item: Record<string, unknown>): EnrichmentLineInput {
  const note =
    trimStr(item.display) ??
    trimStr(item.note) ??
    trimStr((item.food as Record<string, unknown> | undefined)?.name as string) ??
    "unknown";

  const qVal = item.quantity;
  const unit = item.unit as Record<string, unknown> | undefined;
  let quantity: string | undefined;
  let mealiePlainQuantityIsEach = false;

  if (qVal != null && unit && typeof unit === "object") {
    const u = trimStr(unit.abbreviation) ?? trimStr(unit.name) ?? "";
    quantity = `${String(qVal).trim()}${u ? ` ${u}` : ""}`.trim();
  } else if (qVal != null) {
    quantity = String(qVal).trim();
    mealiePlainQuantityIsEach = true;
  }

  return { note, quantity, mealiePlainQuantityIsEach };
}

/**
 * Recipe ingredient (string or Mealie ingredient object) → enrichment input.
 */
export function enrichmentLineFromRecipeIngredient(ing: unknown): EnrichmentLineInput {
  if (typeof ing === "string") {
    const t = ing.trim();
    return { note: t || "unknown" };
  }

  if (!ing || typeof ing !== "object") {
    return { note: "unknown" };
  }

  const obj = ing as Record<string, unknown>;
  const note =
    trimStr(obj.display) ??
    trimStr(obj.note) ??
    trimStr(obj.title) ??
    (() => {
      const food = obj.food as Record<string, unknown> | undefined;
      const foodName = trimStr(food?.name);
      return foodName;
    })() ??
    "unknown";

  const qVal = obj.quantity;
  const unit = obj.unit as Record<string, unknown> | undefined;
  let quantity: string | undefined;
  let mealiePlainQuantityIsEach = false;

  if (qVal != null && unit && typeof unit === "object") {
    const u = trimStr(unit.abbreviation) ?? trimStr(unit.name) ?? "";
    quantity = `${String(qVal).trim()}${u ? ` ${u}` : ""}`.trim();
  } else if (qVal != null) {
    quantity = String(qVal).trim();
    mealiePlainQuantityIsEach = true;
  }

  return { note, quantity, mealiePlainQuantityIsEach };
}

/**
 * Map a full recipeIngredient array to line inputs (preserves order).
 */
export function enrichmentLinesFromRecipeIngredients(raw: unknown): EnrichmentLineInput[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((ing) => enrichmentLineFromRecipeIngredient(ing));
}
