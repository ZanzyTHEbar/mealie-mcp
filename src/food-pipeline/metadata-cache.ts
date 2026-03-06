/**
 * Metadata caching for Mealie MCP registry.
 *
 * Caches the markdown registry output to avoid rebuilding on every call.
 * Default TTL: 5 minutes
 */

interface CachedRegistry {
  markdown: string;
  timestamp: number;
}

let cachedRegistry: CachedRegistry | null = null;
const REGISTRY_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get a filtered view of the cached registry for a specific query.
 */
function filterRegistryByQuery(markdown: string, query: string): string {
  const q = query.toLowerCase();
  const lines = markdown.split('\n');
  const filtered: string[] = [];
  let currentGroup: string[] = [];
  let currentGroupHeader = '';

  let lastMatchWasTool = false;

  for (const line of lines) {
    // Group header line (## groupname)
    if (line.startsWith('## ')) {
      if (currentGroup.length > 0 && currentGroupHeader) {
        filtered.push(currentGroupHeader, ...currentGroup, '');
      }
      currentGroupHeader = line;
      currentGroup = [];
      lastMatchWasTool = false;
    }
    // Tool entry line (- **short_id** — description)
    else if (line.startsWith('- **')) {
      if (line.toLowerCase().includes(q)) {
        currentGroup.push(line);
        lastMatchWasTool = true;
      } else {
        lastMatchWasTool = false;
      }
    }
    // Hint line (  Common: ...) - include if previous tool matched
    else if (line.trim().startsWith('Common:') && lastMatchWasTool) {
      currentGroup.push(line);
    }
    // Other lines (pass through if we're in a matching group)
    else {
      // Skip empty lines and separator lines unless we have content
    }
  }

  // Flush last group
  if (currentGroup.length > 0 && currentGroupHeader) {
    filtered.push(currentGroupHeader, ...currentGroup, '');
  }

  if (filtered.length === 0) {
    return `# Mealie API operations (use short_id with mealie_call)\n\nNo operations found matching "${query}".\n\n---\nCall with: \`mealie_call\` and params \`tool_id\` (short_id above) and \`params\` (object).`;
  }

  return ['# Mealie API operations (use short_id with mealie_call)', '', ...filtered, '---', 'Call with: `mealie_call` and params `tool_id` (short_id above) and `params` (object).'].join('\n');
}

/**
 * Get the cached registry or build it if expired.
 * @param query Optional filter query
 * @param buildFn Function to build the full registry markdown
 * @returns Registry markdown string
 */
export function getCachedRegistry(
  query: string | undefined,
  buildFn: () => string
): string {
  const now = Date.now();

  // Check if we have a valid cached version
  if (cachedRegistry && (now - cachedRegistry.timestamp) < REGISTRY_TTL_MS) {
    if (!query) return cachedRegistry.markdown;
    return filterRegistryByQuery(cachedRegistry.markdown, query);
  }

  // Build fresh registry
  const markdown = buildFn();
  cachedRegistry = { markdown, timestamp: now };

  console.error(`[metadata-cache] Registry rebuilt and cached (TTL: ${REGISTRY_TTL_MS / 1000}s)`);

  if (!query) return markdown;
  return filterRegistryByQuery(markdown, query);
}

/**
 * Invalidate the cached registry.
 * Call this when the OpenAPI spec changes.
 */
export function invalidateRegistryCache(): void {
  cachedRegistry = null;
  console.error('[metadata-cache] Registry cache invalidated');
}

/**
 * Get cache statistics.
 */
export function getRegistryCacheStats(): {
  cached: boolean;
  ageMs: number | null;
  ttlMs: number;
} {
  if (!cachedRegistry) {
    return { cached: false, ageMs: null, ttlMs: REGISTRY_TTL_MS };
  }
  return {
    cached: true,
    ageMs: Date.now() - cachedRegistry.timestamp,
    ttlMs: REGISTRY_TTL_MS
  };
}
