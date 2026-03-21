/**
 * Pingo Doce (Portugal) product price scraper via Mercadão.
 * Product search is at mercadao.pt/store/pingo-doce/search?queries={query}.
 */

import axios from "axios";
import * as cheerio from "cheerio";
import type { GroceryScraperAdapter, PriceResult } from "../types.js";
import { buildSearchQueries, scoreSearchMatch } from "../query-normalize.js";

const BASE_URL = "https://mercadao.pt";
const SEARCH_URL = `${BASE_URL}/store/pingo-doce/search`;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const REQUEST_DELAY_MS = 1500;

// Promise queue to ensure sequential throttling (prevents race conditions)
let throttlePromise = Promise.resolve();

async function throttle(): Promise<void> {
  // Chain to the existing promise queue to ensure sequential execution
  const currentThrottle = throttlePromise;
  throttlePromise = currentThrottle.then(async () => {
    const startTime = Date.now();
    await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
    const elapsed = Date.now() - startTime;
    if (elapsed < REQUEST_DELAY_MS) {
      await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS - elapsed));
    }
  });
  await throttlePromise;
}

/** Parse price string like "0,89 €" or "1,38 €" to number. */
function parsePriceEur(text: string): number | undefined {
  const normalized = text.replace(/\s/g, "").replace(",", ".");
  const match = normalized.match(/[\d.]+/);
  if (!match) return undefined;
  const n = parseFloat(match[0]);
  return isNaN(n) ? undefined : n;
}

function extractUnitSize(text: string): string | undefined {
  const compact = text.replace(/\s+/g, " ").trim();
  const numeric = String.raw`\d+(?:[.,]\d+)?`;
  const multi = compact.match(new RegExp(`(${numeric}\\s*[x×]\\s*${numeric}\\s*(?:cl|ml|l|g|kg))`, "i"));
  if (multi?.[1]) return multi[1].replace(/\s*[x×]\s*/i, " x ");

  const single = compact.match(new RegExp(`(${numeric}\\s*(?:kg|g|ml|cl|l|un|uni|unid|unidade)s?\\.?)`, "i"));
  if (single?.[1]) return single[1].trim();

  const pack = compact.match(new RegExp(`((?:pack|embalagem)\\s*(?:de\\s*)?${numeric})`, "i"));
  return pack?.[1]?.trim();
}

function extractPricePerUnit(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  const match = normalized.match(/(\d+[,.]\d+\s*€\s*\/\s*(?:kg|g|l|ml|cl|un))/i);
  return match?.[1]?.trim();
}

async function searchPingoDoce(
  query: string,
  maxResults = 3
): Promise<PriceResult[]> {
  // Input validation
  if (typeof query !== 'string' || !query.trim()) {
    console.warn('[pingo-doce] Empty query provided');
    return [];
  }
  const sanitizedQuery = query.trim();
  if (sanitizedQuery.length > 200) {
    console.warn('[pingo-doce] Query exceeds 200 characters, truncating');
    query = sanitizedQuery.slice(0, 200);
  } else {
    query = sanitizedQuery;
  }

  const queries = buildSearchQueries(query);

  for (const candidateQuery of queries) {
    await throttle();
    const url = `${SEARCH_URL}?queries=${encodeURIComponent(candidateQuery)}`;
    let html: string;
    try {
      const resp = await axios.get<string>(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
        },
        timeout: 15_000,
      });
      html = resp?.data;
      if (typeof html !== "string" || !html.trim()) {
        console.warn(`[pingo-doce] Empty response for query "${candidateQuery}" - possible rate limiting or blocking`);
        continue;
      }
    } catch (err: any) {
      const status = err?.response?.status;
      const statusText = err?.response?.statusText;
      console.error(`[pingo-doce] HTTP ${status} ${statusText} searching '${candidateQuery}': ${err?.message}`);

      if ([429, 502, 503, 504].includes(status)) {
        console.log(`[pingo-doce] Retrying after transient error ${status}...`);
        await new Promise(r => setTimeout(r, 2000));
        try {
          const retryResp = await axios.get<string>(url, {
            headers: {
              "User-Agent": USER_AGENT,
              "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
            },
            timeout: 15_000,
          });
          html = retryResp?.data;
          if (typeof html !== "string" || !html.trim()) {
            continue;
          }
        } catch (retryErr: any) {
          console.error(`[pingo-doce] Retry failed: ${retryErr?.message}`);
          continue;
        }
      } else {
        continue;
      }
    }

    const $ = cheerio.load(html);
    const candidates: Array<PriceResult & { __score: number }> = [];
    const seen = new Set<string>();

    const productLinks = $('a[href*="/home/produtos/"]');
    if (productLinks.length === 0) {
      console.warn(`[pingo-doce] No product links found for query "${candidateQuery}" - HTML structure may have changed`);
      continue;
    }

    productLinks.each((_, el) => {
      try {
        const href = $(el).attr("href") ?? "";
        if (!href) return;

        const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
        const text = $(el).text().trim();
        if (!text || text.length < 2) return;

        const slug = href.split("/").pop() ?? href;
        if (!slug || seen.has(slug)) return;
        seen.add(slug);

        const productCard =
          $(el).closest('article, li, [data-testid*="product"], [class*="product"]').first();
        const block = productCard.length > 0 ? productCard : $(el).closest("div");
        const blockText = block.text().replace(/\s+/g, " ").trim();

        const priceMatches = [...blockText.matchAll(/(\d+[,.]\d+)\s*€/g)];
        let priceEur: number | undefined;
        if (priceMatches.length > 0) {
          priceEur = parsePriceEur(priceMatches[0][1]);
        }

        if (priceEur != null && (priceEur < 0.01 || priceEur > 10000)) {
          console.warn(`[pingo-doce] Suspicious price ${priceEur} for "${text.slice(0, 50)}"`);
          priceEur = undefined;
        }

        const productName = text.split("\n")[0].trim().slice(0, 120);
        if (!productName) return;

        const unitSize = extractUnitSize(blockText) ?? extractUnitSize(productName);
        const pricePerUnit = extractPricePerUnit(blockText);
        const titleScore = scoreSearchMatch(candidateQuery, productName);
        const slugScore = scoreSearchMatch(candidateQuery, href);
        const matchScore = Math.max(
          titleScore,
          slugScore,
          scoreSearchMatch(candidateQuery, `${productName} ${blockText}`)
        );

        if (Math.max(titleScore, slugScore) <= 0) {
          return;
        }

        if (priceEur == null && !unitSize && !pricePerUnit && matchScore <= 0) {
          return;
        }

        candidates.push({
          store: "Pingo Doce",
          productName,
          priceEur,
          unitSize,
          pricePerUnit,
          productUrl: fullUrl,
          __score: matchScore,
        });
      } catch (parseErr) {
        console.warn(`[pingo-doce] Error parsing product tile: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
      }
    });

    const positives = candidates.filter((candidate) => candidate.__score > 0);
    if (positives.length === 0) {
      continue;
    }

    const ranked = positives.sort((a, b) => {
      if (b.__score !== a.__score) return b.__score - a.__score;
      const aPrice = a.priceEur ?? Number.POSITIVE_INFINITY;
      const bPrice = b.priceEur ?? Number.POSITIVE_INFINITY;
      if (aPrice !== bPrice) return aPrice - bPrice;
      return a.productName.localeCompare(b.productName, "pt");
    });

    return ranked.slice(0, maxResults).map(({ __score: _score, ...result }) => result);
  }

  return [];
}

export const pingoDoceAdapter: GroceryScraperAdapter = {
  name: "Pingo Doce",
  search: searchPingoDoce,
};
