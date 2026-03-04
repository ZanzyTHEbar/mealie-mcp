/**
 * Grocery scrapers barrel. Register new adapters in registry.ts.
 */
export { getScrapers, registerScraper, searchAllStores } from "./registry.js";
export { continenteAdapter } from "./continente.js";
export { pingoDoceAdapter } from "./pingo-doce.js";
export { aldiAdapter } from "./aldi.js";
export { lidlAdapter } from "./lidl.js";
