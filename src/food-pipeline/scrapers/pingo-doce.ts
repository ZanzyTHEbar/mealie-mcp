/**
 * Pingo Doce (Portugal) product price scraper via Mercadão.
 * Product search is at mercadao.pt/store/pingo-doce/search?queries={query}.
 */

import axios from "axios";
import * as cheerio from "cheerio";
import type { GroceryScraperAdapter, PriceResult } from "../types.js";

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

  await throttle();
  const url = `${SEARCH_URL}?queries=${encodeURIComponent(query)}`;
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
      console.warn(`[pingo-doce] Empty response for query "${query}" - possible rate limiting or blocking`);
      return [];
    }
  } catch (err: any) {
    const status = err?.response?.status;
    const statusText = err?.response?.statusText;
    console.error(`[pingo-doce] HTTP ${status} ${statusText} searching '${query}': ${err?.message}`);

    // Retry on transient errors (429, 502, 503, 504)
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
        if (typeof html !== "string" || !html.trim()) return [];
      } catch (retryErr: any) {
        console.error(`[pingo-doce] Retry failed: ${retryErr?.message}`);
        return [];
      }
    } else {
      return [];
    }
  }

  const $ = cheerio.load(html);
  const results: PriceResult[] = [];
  const seen = new Set<string>();

  // HTML structure validation
  const productLinks = $('a[href*="/home/produtos/"]');
  if (productLinks.length === 0) {
    console.warn(`[pingo-doce] No product links found for query "${query}" - HTML structure may have changed`);
    return [];
  }

  // Mercadão product links: /home/produtos/.../product-name-123.html
  productLinks.each((_, el) => {
    try {
      if (results.length >= maxResults) return false;

      const href = $(el).attr("href") ?? "";
      if (!href) return;

      const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
      const text = $(el).text().trim();
      if (!text || text.length < 2) return;

      // Avoid duplicate URLs
      const slug = href.split("/").pop() ?? href;
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      // Parent container often has price nearby (e.g. "0,89 €" or "1,38 € 1,85 €")
      const parent = $(el).closest("div");
      const blockText = parent.text();

      // Look for price patterns - handle multiple prices (use first/lower one)
      const priceMatches = [...blockText.matchAll(/(\d+[,.]\d+)\s*€/g)];
      let priceEur: number | undefined;
      if (priceMatches.length > 0) {
        // Parse all prices and use the lowest (usually current price vs. crossed-out original)
        const prices = priceMatches
          .map(m => parsePriceEur(m[1]))
          .filter((p): p is number => p != null);
        if (prices.length > 0) {
          priceEur = Math.min(...prices);
        }
      }

      // Validate price range (should be between 0.01 and 10000 EUR for groceries)
      if (priceEur != null && (priceEur < 0.01 || priceEur > 10000)) {
        console.warn(`[pingo-doce] Suspicious price ${priceEur} for "${text.slice(0, 50)}"`);
        priceEur = undefined;
      }

      const productName = text.split("\n")[0].trim().slice(0, 120);
      if (!productName) return;

      results.push({
        store: "Pingo Doce",
        productName,
        priceEur,
        productUrl: fullUrl,
      });
    } catch (parseErr) {
      console.warn(`[pingo-doce] Error parsing product tile: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
      // Continue with next product
    }
  });

  return results;
}

export const pingoDoceAdapter: GroceryScraperAdapter = {
  name: "Pingo Doce",
  search: searchPingoDoce,
};
