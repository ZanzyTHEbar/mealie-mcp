/**
 * Lidl (discount store) scraper adapter.
 * Lidl has per-country sites (e.g. lidl.pt). Product search URLs and DOM
 * vary by region. This stub returns no results until selectors are
 * implemented for your target country.
 * To add support: implement search(), return PriceResult[], and ensure
 * each result has store: "Lidl", productName, and priceEur when available.
 */

import type { GroceryScraperAdapter, PriceResult } from "../types.js";

async function searchLidl(
  _query: string,
  _maxResults = 3
): Promise<PriceResult[]> {
  // TODO: Implement for lidl.pt or your country. Example:
  // const url = `https://www.lidl.pt/pesquisa?q=${encodeURIComponent(query)}`;
  // Fetch, parse with cheerio, return PriceResult[] with store: "Lidl".
  return [];
}

export const lidlAdapter: GroceryScraperAdapter = {
  name: "Lidl",
  search: searchLidl,
};
