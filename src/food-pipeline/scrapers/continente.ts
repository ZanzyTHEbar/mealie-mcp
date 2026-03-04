/**
 * Continente.pt adapter for the grocery scraper registry.
 */
import type { GroceryScraperAdapter } from "../types.js";
import { searchContinente } from "../continente-scraper.js";

export const continenteAdapter: GroceryScraperAdapter = {
  name: "Continente",
  search: searchContinente,
};
