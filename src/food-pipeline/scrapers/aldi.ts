/**
 * Aldi (discount store) scraper adapter.
 * Aldi has per-country sites (e.g. aldi.pt). Product search URLs and DOM
 * vary by region. This stub returns no results until selectors are
 * implemented for your target country.
 * To add support: implement search(), return PriceResult[], and ensure
 * each result has store: "Aldi", productName, and priceEur when available.
 */

import type { GroceryScraperAdapter, PriceResult } from "../types.js";

async function searchAldi(
  _query: string,
  _maxResults = 3
): Promise<PriceResult[]> {
  // TODO: Implement for aldi.pt or your country. Example:
  // const url = `https://www.aldi.pt/pesquisa?q=${encodeURIComponent(query)}`;
  // Fetch, parse with cheerio, return PriceResult[] with store: "Aldi".
  return [];
}

export const aldiAdapter: GroceryScraperAdapter = {
  name: "Aldi",
  search: searchAldi,
};
