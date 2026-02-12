/**
 * Request-scoped context for multi-user MCP (e.g. Open WebUI).
 * When the client sends X-Mealie-Token (or Authorization: Bearer) we run the request
 * in this context so executeApiTool uses that token instead of env.
 */
import { AsyncLocalStorage } from 'async_hooks';

interface MealieRequestContext {
  mealieToken?: string;
}

const storage = new AsyncLocalStorage<MealieRequestContext>();

export function runWithMealieToken<T>(token: string | undefined, fn: () => T): T {
  return storage.run({ mealieToken: token }, fn);
}

export function getMealieToken(): string | undefined {
  return storage.getStore()?.mealieToken;
}
