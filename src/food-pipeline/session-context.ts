/**
 * Session context management for multi-turn AI interactions.
 *
 * Maintains state across multiple tool calls to avoid redundant data fetching.
 * Sessions have a TTL (time-to-live) and are automatically cleaned up.
 */

import type { EnrichedItem } from "./types.js";

export interface SessionContext {
  id: string;
  type: 'meal_planning' | 'shopping' | 'recipe_comparison' | 'general';
  createdAt: number;
  lastAccessed: number;
  data: {
    recipes?: any[];
    shoppingListId?: string;
    mealPlanDays?: number;
    enrichedCache?: Map<string, EnrichedItem>;
    pendingIngredients?: string[];
    currentRecipeSlug?: string;
  };
}

// In-memory session storage
const sessions = new Map<string, SessionContext>();

// Configuration
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_SESSIONS = 100;

/**
 * Generate a unique session ID.
 */
function generateSessionId(): string {
  return `sess_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create a new session.
 */
export function createSession(
  type: SessionContext['type'],
  initialData: SessionContext['data'] = {}
): string {
  // Cleanup if we're at capacity
  if (sessions.size >= MAX_SESSIONS) {
    cleanupOldestSessions(1);
  }

  const id = generateSessionId();
  const now = Date.now();
  const session: SessionContext = {
    id,
    type,
    createdAt: now,
    lastAccessed: now,
    data: initialData,
  };

  sessions.set(id, session);
  console.log(`[session] Created ${type} session ${id}`);
  return id;
}

/**
 * Get a session by ID.
 */
export function getSession(id: string): SessionContext | undefined {
  const session = sessions.get(id);
  if (session) {
    // Update last accessed time
    session.lastAccessed = Date.now();
  }
  return session;
}

/**
 * Update session data.
 */
export function updateSession(
  id: string,
  updates: Partial<SessionContext['data']>
): boolean {
  const session = sessions.get(id);
  if (!session) return false;

  session.lastAccessed = Date.now();
  session.data = { ...session.data, ...updates };
  return true;
}

/**
 * Delete a session.
 */
export function deleteSession(id: string): boolean {
  const existed = sessions.delete(id);
  if (existed) {
    console.log(`[session] Deleted session ${id}`);
  }
  return existed;
}

/**
 * Get or create an enriched cache for a session.
 */
export function getSessionCache(sessionId: string): Map<string, EnrichedItem> {
  const session = getSession(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  if (!session.data.enrichedCache) {
    session.data.enrichedCache = new Map();
  }

  return session.data.enrichedCache;
}

/**
 * Cleanup expired sessions.
 * Returns the number of sessions removed.
 */
export function cleanupExpiredSessions(): number {
  const now = Date.now();
  let removed = 0;

  for (const [id, session] of sessions.entries()) {
    if (now - session.lastAccessed > SESSION_TTL_MS) {
      sessions.delete(id);
      removed++;
    }
  }

  if (removed > 0) {
    console.log(`[session] Cleaned up ${removed} expired sessions`);
  }

  return removed;
}

/**
 * Cleanup oldest sessions when at capacity.
 */
function cleanupOldestSessions(count: number): void {
  const sorted = [...sessions.entries()].sort(
    (a, b) => a[1].lastAccessed - b[1].lastAccessed
  );

  for (let i = 0; i < Math.min(count, sorted.length); i++) {
    sessions.delete(sorted[i][0]);
  }

  console.log(`[session] Evicted ${Math.min(count, sorted.length)} oldest sessions`);
}

/**
 * Get session statistics.
 */
export function getSessionStats(): {
  activeSessions: number;
  maxSessions: number;
  ttlMinutes: number;
} {
  return {
    activeSessions: sessions.size,
    maxSessions: MAX_SESSIONS,
    ttlMinutes: SESSION_TTL_MS / 1000 / 60,
  };
}

/**
 * Clear all sessions (use with caution).
 */
export function clearAllSessions(): void {
  sessions.clear();
  console.log('[session] All sessions cleared');
}
