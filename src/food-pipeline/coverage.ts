/**
 * Aggregate per-store price-fetch health for multi-item reports and route optimization.
 */

import type { StoreOutcomeStatus, StoreSearchOutcome } from "./types.js";
import { getScrapers } from "./scrapers/registry.js";

const STATUS_RANK: Record<StoreOutcomeStatus, number> = {
  stub_disabled: 0,
  ok: 1,
  empty: 2,
  error: 3,
};

function worse(a: StoreOutcomeStatus, b: StoreOutcomeStatus): StoreOutcomeStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/**
 * Roll up per-store status across many enrichment rows (worst wins).
 */
export function rollupStoreOutcomes(
  items: { storeSearchOutcomes?: StoreSearchOutcome[] }[]
): Map<string, StoreOutcomeStatus> {
  const m = new Map<string, StoreOutcomeStatus>();
  for (const it of items) {
    for (const o of it.storeSearchOutcomes ?? []) {
      const prev = m.get(o.store);
      if (!prev) {
        m.set(o.store, o.status);
      } else {
        m.set(o.store, worse(prev, o.status));
      }
    }
  }
  return m;
}

export interface PriceCoverageSummary {
  /** At least one store returned `error` for at least one ingredient search. */
  anyStoreError: boolean;
  /** Stores that only appear as stub_disabled in rollups (from registered scrapers). */
  stubOnlyStores: string[];
  /** Stores with rolled-up `error`. */
  storesWithErrors: string[];
  /** Registered scraper count (includes stubs). */
  registeredStoreCount: number;
  /** Live scrapers that are not stubs. */
  activeScraperCount: number;
  /**
   * Totals are uncertain: scrape errors, or fewer than two non-stub stores reporting ok/empty.
   */
  partialPriceCoverage: boolean;
  /** Short explanation for tool consumers. */
  coverageNotes: string[];
}

/**
 * Build a summary for aggregate cost reports (shopping list, meal plan, etc.).
 */
export function summarizePriceCoverageForEnriched(
  enriched: { storeSearchOutcomes?: StoreSearchOutcome[] }[]
): PriceCoverageSummary {
  const rollup = rollupStoreOutcomes(enriched);
  const scrapers = getScrapers();
  const registeredStoreCount = scrapers.length;
  const activeScraperCount = scrapers.filter((s) => !s.isStub).length;

  const stubOnlyStores = scrapers.filter((s) => s.isStub).map((s) => s.name);
  const storesWithErrors = [...rollup.entries()]
    .filter(([, st]) => st === "error")
    .map(([name]) => name);

  const anyStoreError = storesWithErrors.length > 0;

  const okOrEmptyStores = [...rollup.entries()].filter(
    ([, st]) => st === "ok" || st === "empty"
  ).length;

  const partialPriceCoverage =
    anyStoreError ||
    (activeScraperCount >= 2 && okOrEmptyStores < Math.min(2, activeScraperCount));

  const coverageNotes: string[] = [];
  if (anyStoreError) {
    coverageNotes.push(
      `Price scrape errors for: ${storesWithErrors.join(", ")}. Line costs may omit those stores.`
    );
  }
  if (stubOnlyStores.length > 0) {
    coverageNotes.push(
      `Stub/disabled scrapers (no live prices): ${stubOnlyStores.join(", ")}.`
    );
  }
  if (partialPriceCoverage && !anyStoreError) {
    coverageNotes.push(
      "Limited live store coverage; compare totals across visits with caution."
    );
  }

  return {
    anyStoreError,
    stubOnlyStores,
    storesWithErrors,
    registeredStoreCount,
    activeScraperCount,
    partialPriceCoverage,
    coverageNotes,
  };
}

/**
 * Stores to deprioritize when sorting shopping routes (scrape errors).
 */
export function degradedStoreNames(rollup: Map<string, StoreOutcomeStatus>): Set<string> {
  return new Set(
    [...rollup.entries()]
      .filter(([, st]) => st === "error")
      .map(([name]) => name)
  );
}
