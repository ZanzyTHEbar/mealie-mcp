/**
 * Continente.pt product price scraper.
 *
 * Scrapes product data from Portugal's largest grocery retailer.
 * The search page embeds JSON product data in tile elements which we
 * parse with cheerio (server-side jQuery-like HTML parser).
 */

import axios, { type AxiosInstance } from "axios";
import * as cheerio from "cheerio";
import type { PriceResult } from "./types.js";

const BASE_URL = "https://www.continente.pt";
const SEARCH_URL = `${BASE_URL}/pesquisa/?q={query}&start=0&srule=Continente&pmin=0.01`;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const REQUEST_DELAY_MS = 1500;

let lastRequestTime = 0;

function getClient(): AxiosInstance {
  return axios.create({
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
    },
    timeout: 15_000,
    maxRedirects: 5,
  });
}

async function throttle(): Promise<void> {
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < REQUEST_DELAY_MS) {
    await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

function parseTile(el: cheerio.Cheerio<any>, $: cheerio.CheerioAPI): PriceResult | null {
  // Embedded JSON in data-product-tile-impression
  let productData: Record<string, any> = {};
  const jsonEl = el.find("[data-product-tile-impression]").first();
  if (jsonEl.length) {
    try {
      productData = JSON.parse(jsonEl.attr("data-product-tile-impression") ?? "{}");
    } catch { /* ignore parse errors */ }
  }

  // Product name from link text
  const nameEl = el.find(".col-pdp-link a").first();
  let productName = "";
  let productUrl = "";
  if (nameEl.length) {
    productName = nameEl.text().trim();
    const href = nameEl.attr("href") ?? "";
    productUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
  } else {
    productName = (productData.name as string) ?? "Unknown";
  }

  // Price
  let priceEur: number | undefined;
  const rawPrice = productData.price;
  if (rawPrice != null) {
    const parsed = parseFloat(String(rawPrice));
    if (!isNaN(parsed)) priceEur = parsed;
  }

  // Unit size / packaging
  const qtyEl = el.find(".pwc-tile--quantity").first();
  const unitSize = qtyEl.length ? qtyEl.text().trim() : undefined;

  // Price per unit (e.g. "€2.50/kg")
  const ppvEl = el.find(".ct-price-value").first();
  let pricePerUnit = ppvEl.length ? ppvEl.text().trim() : undefined;
  if (pricePerUnit) pricePerUnit = pricePerUnit.replace(/\s+/g, " ").trim();

  // Discount
  const discEl = el.find(".ct-product-tile-badge-value--pvpr").first();
  const discountPct = discEl.length ? discEl.text().trim() : undefined;

  // Original price
  const origEl = el.find(".pwc-discount-amount").first();
  const originalPrice = origEl.length
    ? origEl.text().trim().replace("PVP Recomendado: ", "")
    : undefined;

  // Promotion text
  const promoEl = el.find(".dual-badge-message-text").first();
  const promotion = promoEl.length ? promoEl.text().trim() : undefined;

  // Product image
  const imgEl = el.find(".ct-tile-image").first();
  const imageUrl = imgEl.length
    ? (imgEl.attr("data-src") ?? imgEl.attr("src") ?? undefined)
    : undefined;

  if (!productName && priceEur == null) return null;

  return {
    store: "Continente",
    productName,
    brand: (productData.brand as string) ?? undefined,
    priceEur,
    pricePerUnit,
    unitSize,
    discountPct,
    originalPrice,
    promotion,
    imageUrl,
    productUrl,
    category: (productData.category as string) ?? undefined,
  };
}

/**
 * Search Continente.pt for a product and return price results.
 */
export async function searchContinente(
  query: string,
  maxResults = 3
): Promise<PriceResult[]> {
  await throttle();

  const url = SEARCH_URL.replace("{query}", encodeURIComponent(query));

  let html: string;
  try {
    const resp = await getClient().get<string>(url);
    html = resp?.data;
    if (typeof html !== "string" || !html.trim()) {
      console.error(`[continente] Empty or invalid response for '${query}'`);
      return [];
    }
  } catch (err: any) {
    console.error(`[continente] HTTP error searching '${query}':`, err?.message ?? err);
    return [];
  }

  const $ = cheerio.load(html);
  const results: PriceResult[] = [];

  $("div.product").each((_i, rawEl) => {
    if (results.length >= maxResults) return false; // break
    try {
      const el = $(rawEl);
      const result = parseTile(el, $);
      if (result) results.push(result);
    } catch (err: any) {
      console.error(`[continente] Error parsing tile:`, err?.message ?? err);
    }
  });

  return results;
}
