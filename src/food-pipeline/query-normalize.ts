/**
 * Normalize ingredient text into cleaner store search terms and comparable tokens.
 */

const LEADING_MEASURE_RE =
  /^[\s]*(?:emb\.?\s*)?[\d.,/]+(?:\s*[x×]\s*[\d.,/]+)?\s*(?:kg|gr|g|ml|l|cl|tbsp|tsp|cup|cups|can|cans|bunch|bunches|large|medium|small|cloves?|slices?|stalks?|sheets?)?\s*(?:\([^)]*\))?\s*/i;

const SECTION_PREFIX_RE = /^(?:toppings?|for\s+[\p{L}\- ]+|para\s+[\p{L}\- ]+):\s*/iu;
const SPLIT_VARIANTS_RE = /\s+\b(?:and|or|e|ou)\b\s+|\/+/iu;

const TRAILING_PREP_RE = new RegExp(
  String.raw`\b(?:drained|rinsed|minced|diced|chopped|sliced|cubed|peeled|crushed|grated|divided|optional|to taste|for garnish|for serving|cut into .*|washed|trimmed|beaten|softened|melted|halved|shredded|escorrido|escorrida|lavado|lavada|picado|picada|fatiado|fatiada|cortado|cortada|ralado|ralada|dividido|dividida|opcional|a gosto|para servir)\b.*$`,
  "iu"
);

const STOPWORDS = new Set([
  "a",
  "as",
  "com",
  "da",
  "das",
  "de",
  "do",
  "dos",
  "e",
  "em",
  "for",
  "of",
  "or",
  "ou",
  "para",
  "the",
  "with",
]);

const LEADING_DESCRIPTORS = new Set([
  "baby",
  "boneless",
  "chopped",
  "congelada",
  "congelado",
  "crushed",
  "diced",
  "dried",
  "extra",
  "fatiada",
  "fatiado",
  "finely",
  "fresh",
  "fresca",
  "fresco",
  "frozen",
  "grated",
  "ground",
  "large",
  "medium",
  "minced",
  "moida",
  "moido",
  "organic",
  "peeled",
  "picada",
  "picado",
  "plain",
  "ripe",
  "seco",
  "seca",
  "skinless",
  "sliced",
  "small",
  "smoked",
  "virgem",
  "virgin",
  "whole",
]);

const OPTIONAL_QUALIFIERS = new Set([
  "black",
  "branco",
  "branca",
  "brown",
  "extra",
  "green",
  "natural",
  "red",
  "roxa",
  "roxo",
  "virgem",
  "virgin",
  "white",
  "yellow",
]);

function stripEdgeNoise(text: string): string {
  return text.replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, "").trim();
}

export function normalizeSearchText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\d]+/gu, " ")
    .trim();
}

export function tokenizeSearchText(text: string): string[] {
  return normalizeSearchText(text)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/**
 * Extract a cleaner store query from a recipe or shopping-list line.
 */
export function extractSearchTerm(note: string): string {
  const original = note.trim();
  let text = original;

  text = text.replace(SECTION_PREFIX_RE, "");
  text = text.replace(LEADING_MEASURE_RE, "");
  text = text.split(/[;,]/)[0]?.trim() ?? text;
  text = text.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  text = text.split(SPLIT_VARIANTS_RE)[0]?.trim() ?? text;
  text = text.replace(TRAILING_PREP_RE, "").trim();

  const tokens = text
    .split(/\s+/)
    .map(stripEdgeNoise)
    .filter(Boolean);

  while (tokens.length > 1 && LEADING_DESCRIPTORS.has(normalizeSearchText(tokens[0]))) {
    tokens.shift();
  }

  const cleaned = tokens.join(" ").replace(/\s+/g, " ").trim();
  return cleaned || original;
}

/**
 * Build fallback search queries from most-specific to simpler variants.
 */
export function buildSearchQueries(note: string): string[] {
  const cleaned = extractSearchTerm(note);
  const variants = [cleaned];
  const tokens = cleaned.split(/\s+/).map((token) => token.trim()).filter(Boolean);
  if (tokens.length > 1) {
    const baseTokens = tokens.filter(
      (token) => !OPTIONAL_QUALIFIERS.has(normalizeSearchText(token))
    );
    if (baseTokens.length > 0) {
      const base = baseTokens.join(" ");
      if (!variants.includes(base)) {
        variants.push(base);
      }
    }
  }
  return variants;
}

/**
 * Score how well a product/result text matches a search query.
 * Higher is better. Negative scores mean weak or noisy matches.
 */
export function scoreSearchMatch(query: string, resultText: string): number {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedResult = normalizeSearchText(resultText);
  if (!normalizedQuery || !normalizedResult) return 0;

  const queryTokens = tokenizeSearchText(query);
  if (queryTokens.length === 0) return 0;

  const resultTokens = new Set(tokenizeSearchText(resultText));
  let score = 0;

  if (normalizedResult === normalizedQuery) {
    score += 50;
  } else if (normalizedResult.startsWith(normalizedQuery)) {
    score += 20;
  } else if (normalizedResult.includes(normalizedQuery)) {
    score += 12;
  }

  for (const token of queryTokens) {
    if (resultTokens.has(token)) {
      score += token.length >= 5 ? 8 : 5;
    } else if (normalizedResult.includes(token)) {
      score += 2;
    } else {
      score -= token.length >= 5 ? 5 : 3;
    }
  }

  return score;
}
