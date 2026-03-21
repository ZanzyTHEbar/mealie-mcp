/**
 * Parse grocery shelf strings into comparable units and support quantity-aware cost estimates.
 */

import type { NormalizedPackInfo, PriceResult } from "./types.js";

/** Amount needed for a recipe line when parseable from note / Mealie quantity. */
export interface IngredientNeed {
  grams?: number;
  ml?: number;
  each?: number;
}

const LEADING_AMOUNT_UNIT =
  /^[\s]*([\d.,/]+)\s*(g|gr|kg|ml|mL|l|L|cl|Cl)\b/i;
const LEADING_COUNT =
  /^[\s]*([\d.,/]+)\s+(?!g\b|kg\b|ml\b|mL\b|l\b|L\b|cl\b|tbsp\b|tsp\b|cup\b|cups\b|can\b|cans\b|bunch\b|bunches\b|large\b|medium\b|small\b|cloves?\b|slices?\b|stalks?\b|sheets?\b)([\p{L}][\p{L}\- ]*)/iu;

function parseFloatLoose(raw: string): number | undefined {
  const s = raw.replace(",", ".").trim();
  const frac = /^(\d+)\s*\/\s*(\d+)$/.exec(s);
  if (frac) {
    const a = Number(frac[1]);
    const b = Number(frac[2]);
    if (b !== 0 && Number.isFinite(a)) return a / b;
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}

function toGramsOrMl(value: number, unit: string): { grams?: number; ml?: number } {
  const u = unit.toLowerCase() === "gr" ? "g" : unit.toLowerCase();
  if (u === "g") return { grams: value };
  if (u === "kg") return { grams: value * 1000 };
  if (u === "ml") return { ml: value };
  if (u === "l") return { ml: value * 1000 };
  if (u === "cl") return { ml: value * 10 };
  return {};
}

/**
 * Parse a leading amount+unit from the start of a string (recipe line or quantity field).
 */
export function parseLeadingAmountUnit(text: string): { value: number; unit: string } | null {
  const m = text.trim().match(LEADING_AMOUNT_UNIT);
  if (!m) return null;
  const value = parseFloatLoose(m[1]);
  if (value == null || value <= 0) return null;
  return { value, unit: m[2] };
}

/**
 * Derive grams/ml/each from Mealie quantity and/or the raw ingredient note.
 */
export function parseIngredientNeed(note: string, quantity?: string): IngredientNeed | null {
  const tryOne = (s: string): IngredientNeed | null => {
    const lu = parseLeadingAmountUnit(s);
    if (lu) {
      const c = toGramsOrMl(lu.value, lu.unit);
      if (c.grams != null || c.ml != null) {
        return { grams: c.grams, ml: c.ml };
      }
    }
    const plain = s.trim().match(/^([\d.,/]+)\s*$/);
    if (plain) {
      const n = parseFloatLoose(plain[1]);
      if (n != null && n > 0) {
        return { each: n };
      }
    }
    const counted = s.trim().match(LEADING_COUNT);
    if (counted) {
      const n = parseFloatLoose(counted[1]);
      if (n != null && n > 0) {
        return { each: n };
      }
    }
    return null;
  };

  if (quantity?.trim()) {
    const q = tryOne(quantity);
    if (q) return q;
  }
  return tryOne(note);
}

/**
 * Parse Continente-style unitSize: "500 g", "1 kg", "6 x 33 cl", "6×200g".
 */
export function parsePackFromUnitSize(unitSize?: string): Pick<
  NormalizedPackInfo,
  "packGrams" | "packMl" | "unitCount"
> | null {
  if (!unitSize) return null;
  const s = unitSize
    .replace(/^emb\.?\s*/i, "")
    .replace(/\bembalagem\b/gi, "")
    .replace(/\bgr\b/gi, "g")
    .replace(/\blt\b/gi, "l")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;

  const multi = /^(\d+)\s*[x×]\s*([\d.,]+)\s*(cl|ml|mL|g|kg|l|L)\s*$/i.exec(s);
  if (multi) {
    const count = parseInt(multi[1], 10);
    const subVal = parseFloatLoose(multi[2]);
    const u = multi[3].toLowerCase();
    if (!Number.isFinite(count) || count <= 0 || subVal == null || subVal <= 0) return null;
    if (u === "cl") return { packMl: count * subVal * 10, unitCount: count };
    if (u === "ml") return { packMl: count * subVal, unitCount: count };
    if (u === "l") return { packMl: count * subVal * 1000, unitCount: count };
    if (u === "g") return { packGrams: count * subVal, unitCount: count };
    if (u === "kg") return { packGrams: count * subVal * 1000, unitCount: count };
    return null;
  }

  const single = /^([\d.,]+)\s*(kg|g|ml|mL|l|L|cl)\s*$/i.exec(s);
  if (single) {
    const val = parseFloatLoose(single[1]);
    const u = single[2].toLowerCase();
    if (val == null || val <= 0) return null;
    if (u === "g") return { packGrams: val };
    if (u === "kg") return { packGrams: val * 1000 };
    if (u === "ml") return { packMl: val };
    if (u === "l") return { packMl: val * 1000 };
    if (u === "cl") return { packMl: val * 10 };
  }

  const countOnly = /^([\d.,]+)\s*(un|uni|unid|unids|unidade|unidades)\.?\s*$/i.exec(s);
  if (countOnly) {
    const count = parseFloatLoose(countOnly[1]);
    if (count != null && count > 0) {
      return { unitCount: count };
    }
  }

  const packCount = /(?:pack|embalagem)\s*(?:de\s*)?([\d.,]+)\b/i.exec(s);
  if (packCount) {
    const count = parseFloatLoose(packCount[1]);
    if (count != null && count > 0) {
      return { unitCount: count };
    }
  }

  return null;
}

/**
 * Parse human-readable price-per-unit lines (e.g. "€2,50 / kg", "2.45€/L").
 */
export function parsePricePerUnitDisplay(s?: string): Pick<
  NormalizedPackInfo,
  "imputedPricePerKgEur" | "imputedPricePerLiterEur"
> {
  const out: Pick<NormalizedPackInfo, "imputedPricePerKgEur" | "imputedPricePerLiterEur"> = {};
  if (!s) return out;
  const compact = s.replace(/\s+/g, " ").trim().toLowerCase();

  const euroNum = compact.match(/€\s*([\d.,]+)|([\d.,]+)\s*€/);
  const plainNum = compact.match(/([\d.,]+)/);
  const raw = euroNum ? (euroNum[1] ?? euroNum[2]) : plainNum?.[1];
  const num = raw ? parseFloatLoose(raw) : undefined;
  if (num == null || num <= 0) return out;

  if (compact.includes("/kg") || /\bkg\b/.test(compact)) {
    out.imputedPricePerKgEur = num;
  } else if (compact.includes("/l") || compact.includes("litro")) {
    out.imputedPricePerLiterEur = num;
  }

  return out;
}

function mergeNormalizedPack(
  fromSize: ReturnType<typeof parsePackFromUnitSize>,
  fromPpu: ReturnType<typeof parsePricePerUnitDisplay>,
  priceEur: number | undefined
): NormalizedPackInfo | undefined {
  const n: NormalizedPackInfo = {};
  if (fromSize?.packGrams != null) n.packGrams = fromSize.packGrams;
  if (fromSize?.packMl != null) n.packMl = fromSize.packMl;
  if (fromSize?.unitCount != null) n.unitCount = fromSize.unitCount;

  if (fromPpu.imputedPricePerKgEur != null) {
    n.imputedPricePerKgEur = fromPpu.imputedPricePerKgEur;
  }
  if (fromPpu.imputedPricePerLiterEur != null) {
    n.imputedPricePerLiterEur = fromPpu.imputedPricePerLiterEur;
  }

  if (priceEur != null && priceEur > 0) {
    if (n.packGrams != null && n.packGrams > 0) {
      const im = (priceEur / n.packGrams) * 1000;
      if (n.imputedPricePerKgEur == null) {
        n.imputedPricePerKgEur = im;
      } else {
        const rel = Math.abs(n.imputedPricePerKgEur - im) / im;
        if (rel > 0.25) {
          n.imputedPricePerKgEur = im;
        }
      }
    }
    if (n.packMl != null && n.packMl > 0) {
      const im = (priceEur / n.packMl) * 1000;
      if (n.imputedPricePerLiterEur == null) {
        n.imputedPricePerLiterEur = im;
      } else {
        const rel = Math.abs(n.imputedPricePerLiterEur - im) / im;
        if (rel > 0.25) {
          n.imputedPricePerLiterEur = im;
        }
      }
    }
  }

  if (
    n.packGrams == null &&
    n.packMl == null &&
    n.unitCount == null &&
    n.imputedPricePerKgEur == null &&
    n.imputedPricePerLiterEur == null
  ) {
    return undefined;
  }
  return n;
}

/**
 * Attach `normalizedPack` when shelf strings allow.
 */
export function normalizePriceResult(p: PriceResult): PriceResult {
  const fromSize = parsePackFromUnitSize(p.unitSize);
  const fromPpu = parsePricePerUnitDisplay(p.pricePerUnit);
  const normalizedPack = mergeNormalizedPack(fromSize, fromPpu, p.priceEur);
  if (!normalizedPack) return p;
  return { ...p, normalizedPack };
}

export function enrichPriceResults(list: PriceResult[]): PriceResult[] {
  return list.map(normalizePriceResult);
}

export interface LineCostEstimate {
  estimatedCostEur: number;
  basis: string;
  packsUsed?: number;
}

export function scaleIngredientNeed(
  need: IngredientNeed | null,
  factor: number
): IngredientNeed | null {
  if (need == null || !Number.isFinite(factor) || factor <= 0) return need;
  return {
    ...(need.grams != null && { grams: need.grams * factor }),
    ...(need.ml != null && { ml: need.ml * factor }),
    ...(need.each != null && { each: need.each * factor }),
  };
}

export function formatIngredientNeed(need: IngredientNeed | null): string | undefined {
  if (need == null) return undefined;
  if (need.grams != null) return `${need.grams} g`;
  if (need.ml != null) return `${need.ml} ml`;
  if (need.each != null) return String(need.each);
  return undefined;
}

/**
 * Combine sticker price with parsed need + pack metadata for a line total.
 */
export function estimateLineCost(price: PriceResult, need: IngredientNeed | null): LineCostEstimate {
  const sticker = price.priceEur;
  const norm = price.normalizedPack;

  if (need == null) {
    return {
      estimatedCostEur: sticker ?? 0,
      basis: sticker == null ? "no_price" : "sticker_no_need_parse",
    };
  }

  if (sticker == null) {
    if (need.grams != null && norm?.imputedPricePerKgEur != null) {
      return {
        estimatedCostEur: (need.grams / 1000) * norm.imputedPricePerKgEur,
        basis: "per_kg_only_no_sticker",
      };
    }
    if (need.ml != null && norm?.imputedPricePerLiterEur != null) {
      return {
        estimatedCostEur: (need.ml / 1000) * norm.imputedPricePerLiterEur,
        basis: "per_liter_only_no_sticker",
      };
    }
    return { estimatedCostEur: 0, basis: "no_price" };
  }

  if (need.grams != null && norm?.packGrams != null && norm.packGrams > 0) {
    const packs = Math.max(1, Math.ceil(need.grams / norm.packGrams));
    return {
      estimatedCostEur: packs * sticker,
      basis: "pack_scale_grams",
      packsUsed: packs,
    };
  }

  if (need.ml != null && norm?.packMl != null && norm.packMl > 0) {
    const packs = Math.max(1, Math.ceil(need.ml / norm.packMl));
    return {
      estimatedCostEur: packs * sticker,
      basis: "pack_scale_ml",
      packsUsed: packs,
    };
  }

  if (need.each != null && norm?.unitCount != null && norm.unitCount > 0) {
    const packs = Math.max(1, Math.ceil(need.each / norm.unitCount));
    return {
      estimatedCostEur: packs * sticker,
      basis: "pack_scale_each_count",
      packsUsed: packs,
    };
  }

  if (need.grams != null && norm?.imputedPricePerKgEur != null) {
    return {
      estimatedCostEur: (need.grams / 1000) * norm.imputedPricePerKgEur,
      basis: "by_price_per_kg",
    };
  }

  if (need.ml != null && norm?.imputedPricePerLiterEur != null) {
    return {
      estimatedCostEur: (need.ml / 1000) * norm.imputedPricePerLiterEur,
      basis: "by_price_per_liter",
    };
  }

  return {
    estimatedCostEur: sticker,
    basis: "sticker_unscaled",
  };
}

export function selectBestPriceForNeed(
  prices: PriceResult[],
  need: IngredientNeed | null
): { price: PriceResult; estimate: LineCostEstimate } | null {
  const priced = prices.filter(
    (p): p is PriceResult & { priceEur: number } => p.priceEur != null
  );
  if (priced.length === 0) return null;

  let best: { price: PriceResult; estimate: LineCostEstimate } | null = null;
  for (const price of priced) {
    const estimate = estimateLineCost(price, need);
    if (
      best == null ||
      estimate.estimatedCostEur < best.estimate.estimatedCostEur ||
      (
        estimate.estimatedCostEur === best.estimate.estimatedCostEur &&
        (price.priceEur ?? Number.POSITIVE_INFINITY) < (best.price.priceEur ?? Number.POSITIVE_INFINITY)
      )
    ) {
      best = { price, estimate };
    }
  }

  return best;
}
