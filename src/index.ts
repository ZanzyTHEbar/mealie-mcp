#!/usr/bin/env node
/**
 * MCP Server generated from OpenAPI spec for mealie-mcp v1.0.0
 * Generated on: 2026-02-11T18:49:42.718Z
 */

// Load environment variables from .env file
import dotenv from 'dotenv';
dotenv.config();

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type Tool,
  type CallToolResult,
  type CallToolRequest,
  type PromptMessage
} from "@modelcontextprotocol/sdk/types.js";
import { setupStreamableHttpServer } from "./streamable-http.js";
import { getMealieToken } from "./request-context.js";

import { z, ZodError } from 'zod';
import { jsonSchemaToZod } from 'json-schema-to-zod';
import axios, { type AxiosRequestConfig, type AxiosError } from 'axios';

// Food pipeline: price scraping, nutrition lookup, ingredient enrichment
import {
  searchContinente,
  searchNutrition,
  getNutritionByBarcode,
  enrichIngredient,
  enrichIngredients,
  extractSearchTerm,
} from './food-pipeline/index.js';

/**
 * Type definition for JSON objects
 */
type JsonObject = Record<string, any>;

/**
 * Interface for MCP Tool Definition
 */
interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: any;
  method: string;
  pathTemplate: string;
  executionParameters: { name: string, in: string }[];
  requestBodyContentType?: string;
  securityRequirements: any[];
}

/**
 * Server configuration
 */
export const SERVER_NAME = "mealie-mcp";
export const SERVER_VERSION = "1.0.0";
export const API_BASE_URL = process.env.MEALIE_BASE_URL ?? process.env.BASE_URL ?? "https://mealie.example.com";

/**
 * Instructions sent to the client when the MCP is loaded. Clients may add this to the system prompt
 * so the model acts as an expert chef/nutritionist/meal planner and uses Mealie tools correctly.
 * Uses verbalized reasoning: state your plan and reasoning before acting.
 */
const MEALIE_INSTRUCTIONS = `## Your role
You are an expert personal chef, nutritionist, and meal planner. You help the user with recipes, meal plans, shopping lists, and nutrition-aware choices using their Mealie instance. You speak with warmth and authority: suggest balanced meals, consider dietary needs and preferences, explain why a dish fits their goals, and guide them through planning and cooking.

## How you work with Mealie (verbalized reasoning)
Before using any tool, briefly say what you are about to do and why. Example: "I'll look up which Mealie operations we have for recipes, then search for weeknight dinners so we can pick one and add it to your meal plan." Then use the tools. After a tool result, briefly interpret it in chef/nutritionist terms when relevant (e.g. "That gives us three options; the second is higher in protein and fits a post-workout meal.").

You have two Mealie API tools and four food pipeline tools:

### Mealie API tools
1. **mealie_registry** — Discover what the Mealie API can do. Call with no args for the full list, or \`query\`: "recipe", "mealplan", "shopping", "nutrition", "cookbook", etc. Response is markdown of \`short_id\` and description. Use this when you are unsure which operation to call or when starting a new kind of task.

2. **mealie_call** — Run one Mealie operation. Requires \`tool_id\` (exact short_id from the registry, e.g. \`recipes_list\`, \`recipe_get\`, \`mealplans_list\`) and \`params\` (path params like \`slug\` or \`item_id\`, query params like \`search\`/\`perPage\`, and for POST/PUT a \`requestBody\` object). Always confirm the exact \`tool_id\` and param names from the registry before calling.

### Food pipeline tools (price, nutrition, enrichment)
3. **food_price_search** — Search Portuguese grocery stores (Continente.pt) for product prices. Pass \`query\` (product name) and optional \`max_results\`. Returns product name, price in EUR, brand, unit size, price per unit, promotions, and image URL.

4. **food_nutrition_lookup** — Look up nutritional data per 100g from Open Food Facts. Pass \`query\` (product name) or \`barcode\` (EAN). Returns calories, protein, fat, carbs, fiber, sugar, salt.

5. **food_enrich_ingredient** — Combined price + nutrition enrichment for a single ingredient. Pass \`ingredient\` (raw text like "600g chicken breast, diced"). Automatically extracts a clean search term. Returns prices, cheapest option, nutrition, estimated cost, and image.

6. **food_enrich_shopping_list** — Enrich ALL items in a Mealie shopping list in one call. Pass \`list_id\` (UUID). Fetches the list from Mealie, then enriches each unchecked item with prices and nutrition. Returns a full report with per-item data and total estimated cost.

## Workflow (discover → reason → act)
1. **Discover** — If needed, call mealie_registry (with a focused \`query\`) and read the short_ids.
2. **Reason** — State in one sentence what you will do and which operation(s) you will use.
3. **Act** — Call the appropriate tool. Then summarize or interpret the result for the user in your expert role (chef/nutritionist/meal planner).

## When to use food pipeline tools
- Use \`food_price_search\` when the user asks about grocery prices, wants to compare products, or needs to estimate shopping costs.
- Use \`food_nutrition_lookup\` when the user asks about nutritional content of a specific food or product.
- Use \`food_enrich_ingredient\` when analyzing a single recipe ingredient's cost and nutrition.
- Use \`food_enrich_shopping_list\` when the user wants a full budget/nutrition breakdown of their shopping list.`;

/**
 * Custom prompts: expert chef / nutritionist / meal planner with verbalized reasoning.
 * Each prompt reinforces role, then gives a user query and an assistant reply that models
 * discover → reason → act and, where useful, considering multiple options before choosing.
 */
const MEALIE_PROMPTS: Record<string, { title: string; description: string; messages: PromptMessage[] }> = {
  mealie_expert_role: {
    title: "Expert chef, nutritionist & meal planner — Role",
    description: "Establish the assistant as your personal chef, nutritionist, and meal planner using Mealie.",
    messages: [
      {
        role: "user",
        content: { type: "text", text: "From now on, when we talk about food, recipes, or meal planning, act as my expert personal chef, nutritionist, and meal planner. You have access to my Mealie recipe app. Help me plan meals, choose recipes, and use my meal plans and shopping lists. Explain your reasoning before you use any tools, and after results tell me what it means in plain terms (e.g. nutrition, timing, portions)." }
      },
      {
        role: "assistant",
        content: {
          type: "text",
          text: `I'll act as your personal chef, nutritionist, and meal planner. When we work with Mealie I'll:

1. **Say what I'm doing** — Before calling the app I'll briefly state my plan (e.g. "I'll look up recipe operations, then search for quick dinners so we can add one to your plan").
2. **Use the right operations** — I'll use \`mealie_registry\` to see what's available when needed, then \`mealie_call\` with the correct \`tool_id\` and \`params\`.
3. **Interpret results for you** — After each step I'll summarize in chef/nutritionist terms: why a recipe fits, how it fits your week, what to watch for (portions, allergens, timing).

Tell me your goals (e.g. more protein, fewer carbs, batch cooking, family dinners) and I'll tailor suggestions and plans accordingly.`
        }
      }
    ]
  },
  mealie_verbalized_planning: {
    title: "Verbalized meal planning — Reason then act",
    description: "Model for planning a week of dinners with explicit reasoning and tool use.",
    messages: [
      {
        role: "user",
        content: { type: "text", text: "Help me plan dinners for the next week. I want a mix of cuisines and something I can batch-cook for two nights." }
      },
      {
        role: "assistant",
        content: {
          type: "text",
          text: `I'll plan your week using verbalized reasoning so you see how I'm thinking.

**My plan:** First I'll check what Mealie can do for recipes and meal plans (mealie_registry with query "recipe" and "mealplan"). Then I'll list your current meal plan so we don't double-book, then search recipes that fit "batch" or "meal prep" and "dinner", and suggest 2–3 options. I'll pick one batch-friendly recipe and one or two quicker ones, then add them to your plan with mealie_call. After each tool I'll summarize what we have and why it works.

**Reasoning:** A balanced week needs variety (cuisines, cooking time) and at least one batch option to save time. I need the exact API short_ids from the registry before calling anything.

I'll start by discovering the relevant operations now.`
        }
      }
    ]
  },
  mealie_nutrition_aware_search: {
    title: "Nutrition-aware recipe search",
    description: "Find recipes that fit protein/carb/calorie goals with clear reasoning.",
    messages: [
      {
        role: "user",
        content: { type: "text", text: "I'm aiming for higher protein and moderate carbs. Find me a few dinner recipes in Mealie that could work and tell me why you picked them." }
      },
      {
        role: "assistant",
        content: {
          type: "text",
          text: `**What I'll do:** I'll look up Mealie's recipe operations (mealie_registry query "recipe"), then search your library for dinners. I'll fetch full details for a few so we can check nutrition if Mealie provides it, and I'll recommend 2–3 that typically suit higher protein / moderate carb (e.g. lean meat, legumes, vegetables, limited refined carbs). I'll state why each fits your goals before you choose.

**Verbalized step:** Calling the registry first to get the exact short_id for listing and searching recipes, then I'll run the search and pull recipe details.`
        }
      }
    ]
  },
  mealie_today_and_shopping: {
    title: "Today's meals and shopping list",
    description: "Check today's plan and add a recipe's ingredients to the shopping list.",
    messages: [
      {
        role: "user",
        content: { type: "text", text: "What's on my meal plan for today? And add the ingredients for tonight's recipe to my shopping list." }
      },
      {
        role: "assistant",
        content: {
          type: "text",
          text: `**Plan:** I'll (1) look up meal plan and shopping list operations in the registry, (2) get today's meals so we know what's for dinner, (3) list your shopping lists to get the right list id, (4) add tonight's recipe ingredients to that list. I'll say each step before I do it and then confirm what was added.

**Reasoning:** "Today's meals" and "add recipe to shopping list" need different API calls; I need the exact short_ids and params (e.g. item_id for the list, recipe slug or id) from the registry. Starting with mealie_registry for "mealplan" and "shopping".`
        }
      }
    ]
  },
  mealie_consider_options_then_choose: {
    title: "Consider options then choose (diverse suggestions)",
    description: "Verbalized sampling style: consider 2–3 distinct options, then recommend one with reasoning.",
    messages: [
      {
        role: "user",
        content: { type: "text", text: "Suggest a few different dinner ideas from my Mealie recipes—maybe one comfort food, one lighter, one quick—then pick the best for a Wednesday and say why." }
      },
      {
        role: "assistant",
        content: {
          type: "text",
          text: `**Approach (verbalized sampling):** I'll pull recipe options from your Mealie library, then consider 2–3 distinct directions (e.g. comfort vs light vs quick) rather than one default. I'll assign each a brief "fit" for Wednesday (energy, time, balance) and then choose one with clear reasoning so you see the tradeoffs.

**Steps:** (1) Registry for recipe operations. (2) List or search recipes, get details for a shortlist. (3) I'll present 2–3 options with one-sentence rationale each. (4) I'll recommend one for Wednesday and state why. After that we can add it to your meal plan if you want.`
        }
      }
    ]
  },
  mealie_getting_started: {
    title: "Mealie tools — Quick reference",
    description: "Technical summary: mealie_registry and mealie_call workflow.",
    messages: [
      {
        role: "user",
        content: { type: "text", text: "How do the Mealie MCP tools work in one paragraph?" }
      },
      {
        role: "assistant",
        content: {
          type: "text",
          text: `You have two tools: **mealie_registry** (discover operations; optional \`query\`: "recipe", "mealplan", "shopping") returns markdown of \`short_id\` and description. **mealie_call** runs one operation: pass \`tool_id\` (exact short_id from the registry) and \`params\` (path/query/requestBody as needed). Always use the registry when unsure of \`tool_id\` or param names. Workflow: discover → state your plan → act → interpret results for the user.`
        }
      }
    ]
  }
};

/**
 * MCP Server instance
 */
/**
 * Ensure inputSchema has type: 'object' at root so MCP clients (e.g. Cursor) accept the tool.
 * Some generated schemas may have anyOf/oneOf at root and get rejected.
 */
function normalizeToolInputSchema(schema: unknown): Tool['inputSchema'] {
  if (schema && typeof schema === 'object' && 'type' in schema && (schema as { type: string }).type === 'object') {
    const s = schema as { type: string; properties?: Record<string, object>; required?: string[] };
    return {
      type: 'object',
      ...(s.properties && Object.keys(s.properties).length > 0 && { properties: s.properties }),
      ...(s.required && s.required.length > 0 && { required: s.required })
    };
  }
  return { type: 'object', properties: {} };
}

/**
 * Creates a new MCP Server instance (one per connection).
 * Required because the SDK allows only one transport per Server; Streamable HTTP has multiple sessions.
 */
function createMcpServer(): Server {
  const s = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, prompts: {} },
      instructions: MEALIE_INSTRUCTIONS
    }
  );

  // Progressive disclosure: expose only 2 tools (registry + call). Names stay under 60 chars with "mealie:" prefix.
  const PROGRESSIVE_TOOLS: Tool[] = [
    {
      name: 'mealie_registry',
      description: `Discover Mealie API operations before calling them. Returns a markdown registry of short_id and description, grouped by area (recipes, mealplans, shopping, users, etc.). Always use this first (or when unsure of the correct tool_id). Optional "query" filters by keyword (e.g. "recipe", "mealplan", "shopping", "user"). Then use mealie_call with a short_id from this list.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional search term to filter operations (e.g. recipe, mealplan, shopping, user, cookbook)' }
        }
      }
    },
    {
      name: 'mealie_call',
      description: `Run one Mealie operation. Requires "tool_id" (exact short_id from mealie_registry) and "params" (path/query/requestBody as required). Optional "mealie_token": use in multi-user setups (e.g. Open WebUI) so each user's Mealie API token is used. Use after you have stated your plan; then interpret the result for the user in chef/nutritionist/meal-planner terms.`,
      inputSchema: {
        type: 'object',
        properties: {
          tool_id: { type: 'string', description: 'Exact short_id from mealie_registry (e.g. recipes_list, recipe_get, mealplans_list)' },
          params: { type: 'object', description: 'Path params (slug, item_id), query (search, perPage), and/or requestBody for POST/PUT' },
          mealie_token: { type: 'string', description: 'Optional: Mealie API token for this call (multi-user chat UIs; overrides server env and X-Mealie-Token header)' }
        },
        required: ['tool_id']
      }
    },
    // ── Food Pipeline tools ─────────────────────────────────────────────
    {
      name: 'food_price_search',
      description: 'Search Portuguese grocery stores (Continente.pt) for product prices. Returns product name, price in EUR, brand, unit size, price per unit, promotions, and product image URL. Use for price comparison and shopping budget estimation.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Product name to search for (e.g. "chicken breast", "olive oil", "quinoa")' },
          max_results: { type: 'number', description: 'Maximum number of results to return (default: 5, max: 10)' }
        },
        required: ['query']
      }
    },
    {
      name: 'food_nutrition_lookup',
      description: 'Look up nutritional data per 100g from Open Food Facts. Search by product name or barcode (EAN). Returns calories, protein, fat, carbs, fiber, sugar, and salt. Use for dietary analysis and meal planning.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Product name to search for (e.g. "chicken breast", "quinoa")' },
          barcode: { type: 'string', description: 'EAN/UPC barcode (alternative to query, e.g. "5601312000105")' }
        }
      }
    },
    {
      name: 'food_enrich_ingredient',
      description: 'Enrich a single ingredient with both price data (Continente.pt) and nutritional info (Open Food Facts) in one call. Automatically cleans the ingredient text (removes quantities, prep instructions) to produce a clean search term. Returns prices, cheapest option, nutrition per 100g, estimated cost, and product image.',
      inputSchema: {
        type: 'object',
        properties: {
          ingredient: { type: 'string', description: 'Raw ingredient text (e.g. "600g chicken breast, diced", "2 tbsp olive oil", "quinoa")' },
          quantity: { type: 'string', description: 'Optional quantity context' },
          skip_price: { type: 'boolean', description: 'Skip price lookup (default: false)' },
          skip_nutrition: { type: 'boolean', description: 'Skip nutrition lookup (default: false)' },
          max_price_results: { type: 'number', description: 'Max price results per ingredient (default: 3)' }
        },
        required: ['ingredient']
      }
    },
    {
      name: 'food_enrich_shopping_list',
      description: 'Enrich ALL items in a Mealie shopping list with prices and nutrition in one call. Fetches the shopping list from Mealie, then for each unchecked item looks up prices (Continente.pt) and nutrition (Open Food Facts). Returns a full report with per-item costs, nutrition, images, and a total estimated cost. Use for budget analysis and nutritional planning of a whole shopping trip.',
      inputSchema: {
        type: 'object',
        properties: {
          list_id: { type: 'string', description: 'Mealie shopping list UUID' },
          skip_price: { type: 'boolean', description: 'Skip price lookups (default: false)' },
          skip_nutrition: { type: 'boolean', description: 'Skip nutrition lookups (default: false)' },
          checked_items: { type: 'boolean', description: 'Include already-checked items (default: false, only enriches unchecked)' },
          mealie_token: { type: 'string', description: 'Optional: Mealie API token override for multi-user setups' }
        },
        required: ['list_id']
      }
    }
  ];

  s.setRequestHandler(ListPromptsRequestSchema, async () => {
    const prompts = Object.entries(MEALIE_PROMPTS).map(([name, p]) => ({
      name,
      description: p.description,
      title: p.title
    }));
    return { prompts };
  });

  s.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const name = request.params?.name as string;
    const prompt = name ? MEALIE_PROMPTS[name] : undefined;
    if (!prompt) {
      return {
        description: `Unknown prompt: ${name}. Available: ${Object.keys(MEALIE_PROMPTS).join(', ')}.`,
        messages: []
      };
    }
    return { description: prompt.description, messages: prompt.messages };
  });

  s.setRequestHandler(ListToolsRequestSchema, async () => {
    console.error(`ListTools: returning ${PROGRESSIVE_TOOLS.length} tools (progressive disclosure)`);
    return { tools: PROGRESSIVE_TOOLS };
  });
  s.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest): Promise<CallToolResult> => {
    const { name: toolName, arguments: toolArgs } = request.params;
    const args = (toolArgs ?? {}) as JsonObject;

    if (toolName === 'mealie_registry') {
      const query = typeof args.query === 'string' ? args.query : undefined;
      const markdown = buildRegistryMarkdown(query);
      return { content: [{ type: 'text', text: markdown }] };
    }

    if (toolName === 'mealie_call') {
      const toolId = typeof args.tool_id === 'string' ? args.tool_id.trim() : '';
      const params = (args.params && typeof args.params === 'object' && !Array.isArray(args.params)) ? (args.params as JsonObject) : {};
      const mealieToken = typeof args.mealie_token === 'string' ? args.mealie_token.trim() || undefined : undefined;
      const map = getShortIdMap();
      const operationKey = map.get(toolId);
      if (!operationKey) {
        return { content: [{ type: 'text', text: `Error: Unknown tool_id "${toolId}". Use mealie_registry to list valid short_ids.` }] };
      }
      const toolDefinition = toolDefinitionMap.get(operationKey);
      if (!toolDefinition) {
        return { content: [{ type: 'text', text: `Error: No definition for ${operationKey}.` }] };
      }
      return await executeApiTool(operationKey, toolDefinition, params, securitySchemes, mealieToken);
    }

    // ── Food Pipeline tool handlers ───────────────────────────────────

    if (toolName === 'food_price_search') {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return { content: [{ type: 'text', text: 'Error: "query" is required.' }] };
      const maxResults = Math.min(Math.max(parseInt(String(args.max_results ?? '5'), 10) || 5, 1), 10);
      try {
        const results = await searchContinente(query, maxResults);
        if (results.length === 0) {
          return { content: [{ type: 'text', text: `No products found on Continente.pt for "${query}".` }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error searching prices: ${err?.message ?? err}` }] };
      }
    }

    if (toolName === 'food_nutrition_lookup') {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      const barcode = typeof args.barcode === 'string' ? args.barcode.trim() : '';
      if (!query && !barcode) return { content: [{ type: 'text', text: 'Error: Provide either "query" or "barcode".' }] };
      try {
        const info = barcode
          ? await getNutritionByBarcode(barcode)
          : await searchNutrition(query);
        if (!info) {
          return { content: [{ type: 'text', text: `No nutritional data found for "${query || barcode}".` }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error looking up nutrition: ${err?.message ?? err}` }] };
      }
    }

    if (toolName === 'food_enrich_ingredient') {
      const ingredient = typeof args.ingredient === 'string' ? args.ingredient.trim() : '';
      if (!ingredient) return { content: [{ type: 'text', text: 'Error: "ingredient" is required.' }] };
      const quantity = typeof args.quantity === 'string' ? args.quantity.trim() || undefined : undefined;
      const rawMax = args.max_price_results;
      const maxPriceResults = Math.min(Math.max(parseInt(String(rawMax ?? 3), 10) || 3, 1), 10);
      try {
        const enriched = await enrichIngredient(ingredient, quantity, {
          skipPrice: args.skip_price === true,
          skipNutrition: args.skip_nutrition === true,
          maxPriceResults,
        });
        return { content: [{ type: 'text', text: JSON.stringify(enriched, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error enriching ingredient: ${err?.message ?? err}` }] };
      }
    }

    if (toolName === 'food_enrich_shopping_list') {
      const listId = typeof args.list_id === 'string' ? args.list_id.trim() : '';
      if (!listId) return { content: [{ type: 'text', text: 'Error: "list_id" is required.' }] };
      const includeChecked = args.checked_items === true;
      const mealieToken = typeof args.mealie_token === 'string' ? args.mealie_token.trim() || undefined : undefined;

      const token = mealieToken ?? getMealieToken() ?? process.env.BEARER_TOKEN_OAUTH2PASSWORDBEARER ?? '';
      if (!token) {
        return { content: [{ type: 'text', text: 'Error: Mealie API token required to fetch the shopping list. Set BEARER_TOKEN_OAUTH2PASSWORDBEARER in the server environment or pass mealie_token in the request.' }] };
      }

      try {
        const mealieBase = API_BASE_URL.replace(/\/$/, '');
        const listResp = await axios.get(`${mealieBase}/api/households/shopping/lists/${listId}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          timeout: 15_000,
        });
        const listData = listResp.data;
        const listName: string = listData?.name ?? 'Shopping List';
        const allItems: any[] = listData?.listItems ?? [];

        // Filter to unchecked unless includeChecked
        const items = includeChecked ? allItems : allItems.filter((i: any) => !i.checked);

        if (items.length === 0) {
          return { content: [{ type: 'text', text: `Shopping list "${listName}" has no ${includeChecked ? '' : 'unchecked '}items to enrich.` }] };
        }

        // Build ingredient list from shopping items
        const toEnrich = items.map((item: any) => ({
          note: item.display ?? item.note ?? item.food?.name ?? 'unknown',
          quantity: item.quantity != null ? String(item.quantity) : undefined,
        }));

        const enriched = await enrichIngredients(toEnrich, {
          skipPrice: args.skip_price === true,
          skipNutrition: args.skip_nutrition === true,
        });

        // Compute totals
        let totalEstimatedCost = 0;
        let itemsWithPrice = 0;
        let itemsWithNutrition = 0;
        for (const e of enriched) {
          if (e.estimatedCostEur != null) { totalEstimatedCost += e.estimatedCostEur; itemsWithPrice++; }
          if (e.nutrition) itemsWithNutrition++;
        }

        const report = {
          listName,
          listId,
          totalItems: items.length,
          itemsWithPrice,
          itemsWithNutrition,
          totalEstimatedCostEur: Math.round(totalEstimatedCost * 100) / 100,
          items: enriched,
        };

        return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
      } catch (err: any) {
        const status = err?.response?.status;
        if (status === 404) return { content: [{ type: 'text', text: `Error: Shopping list "${listId}" not found.` }] };
        if (status === 401 || status === 403) return { content: [{ type: 'text', text: `Error: Unauthorized. Check Mealie API token.` }] };
        return { content: [{ type: 'text', text: `Error enriching shopping list: ${err?.message ?? err}` }] };
      }
    }

    console.error(`Error: Unknown tool requested: ${toolName}`);
    return { content: [{ type: 'text', text: `Error: Unknown tool requested: ${toolName}. Available tools: mealie_registry, mealie_call, food_price_search, food_nutrition_lookup, food_enrich_ingredient, food_enrich_shopping_list.` }] };
  });
  return s;
}

/** Max length for MCP tool name so "mealie:" + name <= 60 */
const MCP_TOOL_NAME_MAX = 53;

/** Relevance for AI agent: only high/medium/low are exposed; exclude is filtered out. */
export type ToolRelevance = 'high' | 'medium' | 'low' | 'exclude';

/**
 * Rank tools by importance and relevance for an AI agent. Returns 'exclude' for operations
 * that do not make logical sense for an agent (auth flows, admin, binary uploads, etc.).
 */
function getRelevance(pathTemplate: string, method: string, operationKey: string): ToolRelevance {
  const p = pathTemplate;
  const m = method.toLowerCase();

  // --- EXCLUDE: No use for an AI agent ---
  if (p.startsWith('/api/app/')) return 'exclude'; // app info, theme, startup (human UI)
  if (p.startsWith('/api/auth/')) return 'exclude'; // token, oauth, logout, refresh (handled by env/bearer)
  if (p.startsWith('/api/admin/')) return 'exclude'; // users, households, groups, backups, maintenance, debug, email
  if (p.startsWith('/api/users/register') || p.startsWith('/api/users/forgot-password') || p.startsWith('/api/users/reset-password')) return 'exclude'; // auth flows
  if (p.includes('/users/') && (p.includes('/image') || p.includes('/api-tokens'))) return 'exclude'; // user image upload, API token create/delete
  if (p.startsWith('/api/groups/migrations') || p.startsWith('/api/groups/seeders')) return 'exclude'; // data migration, seed DB
  if (p.startsWith('/api/groups/reports') && m === 'delete') return 'exclude'; // report delete (admin-ish)
  if (p.startsWith('/api/groups/storage')) return 'exclude'; // storage stats (admin)
  if (p.startsWith('/api/households/events/notifications')) return 'exclude'; // event notifiers (webhooks/push config)
  if (p.startsWith('/api/households/recipe-actions')) return 'exclude'; // external recipe actions / trigger URLs
  if (p.startsWith('/api/households/webhooks')) return 'exclude'; // webhook config (scheduled push)
  if (p.startsWith('/api/utils/download')) return 'exclude'; // file download by token (opaque)
  if (p.startsWith('/api/media/docker')) return 'exclude'; // docker validation (internal)
  if (p.startsWith('/api/recipes/create/zip') || p.startsWith('/api/recipes/create/image')) return 'exclude'; // binary upload (zip, image) — agent can't send binary
  if (p.startsWith('/api/recipes/') && p.includes('/image') && (m === 'put' || m === 'post')) return 'exclude'; // recipe image upload / scrape image URL
  if (p.startsWith('/api/recipes/timeline-events/') && p.includes('/image')) return 'exclude'; // timeline event image upload
  if (operationKey.includes('oauth_callback') || operationKey.includes('oauth_login')) return 'exclude';

  // --- HIGH: Core agent use cases (read recipes, meal plans, shopping; suggest; add to list) ---
  if (p.startsWith('/api/recipes') && !p.includes('/bulk-actions') && m === 'get') return 'high'; // list, get one, suggest, exports (read-only)
  if (p.startsWith('/api/households/mealplans') && !p.includes('/rules')) return 'high'; // mealplan list, today, random, create, get, update, delete
  if (p.startsWith('/api/households/shopping/lists') || p.startsWith('/api/households/shopping/items')) return 'high'; // shopping lists and items
  if (p.startsWith('/api/households/cookbooks')) return 'high'; // cookbooks
  if (p.startsWith('/api/organizers/categories') || p.startsWith('/api/organizers/tags') || p.startsWith('/api/organizers/tools')) return 'high'; // categories, tags, tools (organizers)
  if (p.startsWith('/api/foods') || p.startsWith('/api/units')) return 'high'; // foods, units (ingredients)
  if (p.startsWith('/api/parser/')) return 'high'; // parse ingredient(s)
  if (p === '/api/users/self' || p.startsWith('/api/users/self/ratings') || p.startsWith('/api/users/self/favorites')) return 'high'; // logged-in user, ratings, favorites
  if (p.startsWith('/api/households/self') || p === '/api/households/members') return 'high'; // household self, members
  if (p.startsWith('/api/recipes/exports')) return 'high'; // export formats

  // --- MEDIUM: Useful but not primary (create/update/delete recipe, bulk, shared, comments, labels, group info) ---
  if (p.startsWith('/api/recipes/create/url') || p.startsWith('/api/recipes/create/html')) return 'medium'; // create from URL or HTML/JSON
  if (p.startsWith('/api/recipes') && (m === 'put' || m === 'patch' || m === 'post' || m === 'delete')) return 'medium'; // recipe update, delete, duplicate, last-made, bulk
  if (p.startsWith('/api/recipes/shared') || p.startsWith('/api/recipes/comments')) return 'medium'; // shared recipe, comments
  if (p.startsWith('/api/recipes/timeline-events') && !p.includes('/image')) return 'medium'; // timeline events (no binary)
  if (p.startsWith('/api/groups/labels')) return 'medium'; // labels (shopping list labels etc.)
  if (p.startsWith('/api/groups/households') || p.startsWith('/api/groups/self') || p.startsWith('/api/groups/members') || p.startsWith('/api/groups/preferences')) return 'medium'; // group/household info
  if (p.startsWith('/api/households/preferences') || p.startsWith('/api/households/invitations') || p.startsWith('/api/households/statistics')) return 'medium'; // preferences, invites, stats
  if (p.startsWith('/api/users/') && (p.includes('/ratings') || p.includes('/favorites'))) return 'medium'; // set rating, add/remove favorite (by user id)
  if (p.startsWith('/api/users/password') || p === '/api/users/self' || p.includes('/users/{item_id}')) return 'medium'; // password update, user update (self)
  if (p.startsWith('/api/households/permissions')) return 'medium'; // member permissions
  if (p.startsWith('/api/explore/')) return 'medium'; // public explore (groups, recipes by group_slug)
  if (p.startsWith('/api/media/recipes/') && m === 'get') return 'medium'; // recipe image/asset URL (read-only)

  // --- LOW: Niche or rarely needed by agent ---
  if (p.startsWith('/api/households/mealplans/rules')) return 'low'; // mealplan rules (auto-planning)
  if (p.startsWith('/api/groups/reports') && m === 'get') return 'low'; // reports list/get
  if (p.startsWith('/api/comments')) return 'low'; // global comments list
  if (p.startsWith('/api/shared/recipes')) return 'low'; // shared recipes (create/list/delete share token)

  // Default: allow but rank low (e.g. test scrape URL, get recipe as format)
  return 'low';
}

/**
 * Whether a tool is exposed to the agent (high, medium, low). Excluded tools are not in the registry or callable.
 */
function isToolAllowed(relevance: ToolRelevance): boolean {
  return relevance !== 'exclude';
}

/** One row for the ranked tool list (for documentation). */
export interface RankedToolRow {
  shortId: string;
  operationKey: string;
  pathTemplate: string;
  method: string;
  relevance: ToolRelevance;
  description: string;
}

/**
 * Builds the full ranked list of all tools (including excluded). Used to generate TOOL_RANKING.md.
 * ShortIds are computed with same uniqueness as the allowed map, but across all tools.
 */
export function getToolRankingList(): RankedToolRow[] {
  const used = new Set<string>();
  const rows: RankedToolRow[] = [];
  for (const [opKey, def] of toolDefinitionMap.entries()) {
    let shortId = pathToShortId(def.pathTemplate, def.method);
    let n = 2;
    while (used.has(shortId)) {
      shortId = (pathToShortId(def.pathTemplate, def.method).slice(0, MCP_TOOL_NAME_MAX - 4) + '_' + n).slice(0, MCP_TOOL_NAME_MAX);
      n++;
    }
    used.add(shortId);
    const relevance = getRelevance(def.pathTemplate, def.method, opKey);
    rows.push({
      shortId,
      operationKey: opKey,
      pathTemplate: def.pathTemplate,
      method: def.method,
      relevance,
      description: (def.description || '').replace(/\n/g, ' ').trim().slice(0, 80)
    });
  }
  const order: Record<ToolRelevance, number> = { high: 0, medium: 1, low: 2, exclude: 3 };
  rows.sort((a, b) => order[a.relevance] - order[b.relevance] || a.shortId.localeCompare(b.shortId));
  return rows;
}

/**
 * Derives a short, readable id from path and method for registry and call tool.
 * Keeps ids under MCP_TOOL_NAME_MAX and unique.
 */
function pathToShortId(pathTemplate: string, method: string): string {
  const raw = pathTemplate.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const segments = raw.filter(s => !s.startsWith('{'));
  const hasParam = pathTemplate.includes('{');
  const m = method.toLowerCase();
  const action = m === 'get' && !hasParam ? 'list' : m;
  let base: string;
  if (segments.length === 0) base = 'root_' + action;
  else if (segments.length === 1) {
    const r = segments[0];
    base = (hasParam ? r.replace(/e?s$/, '') : r) + '_' + action;
  } else {
    const last = segments[segments.length - 1];
    const rest = segments.slice(0, -1);
    if (hasParam) base = (last.replace(/e?s$/, '') || last) + '_' + action;
    else base = last + '_' + action;
    if (rest.length > 0) base = rest[rest.length - 1] + '_' + base;
  }
  return base.replace(/[^a-z0-9_]/gi, '_').replace(/_+/g, '_').toLowerCase().slice(0, MCP_TOOL_NAME_MAX);
}

/**
 * Builds shortId -> operationKey map from toolDefinitionMap. Ensures uniqueness.
 */
function buildShortIdToOperationKey(): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set<string>();
  for (const [opKey, def] of toolDefinitionMap.entries()) {
    let shortId = pathToShortId(def.pathTemplate, def.method);
    let n = 2;
    while (used.has(shortId)) {
      shortId = (pathToShortId(def.pathTemplate, def.method).slice(0, MCP_TOOL_NAME_MAX - 4) + '_' + n).slice(0, MCP_TOOL_NAME_MAX);
      n++;
    }
    used.add(shortId);
    result.set(shortId, opKey);
  }
  return result;
}

/**
 * Map of tool definitions by name
 */
const toolDefinitionMap: Map<string, McpToolDefinition> = new Map([

  ["get_app_info_api_app_about_get", {
    name: "get_app_info_api_app_about_get",
    description: `Get general application information`,
    inputSchema: { "type": "object", "properties": {} },
    method: "get",
    pathTemplate: "/api/app/about",
    executionParameters: [],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["get_startup_info_api_app_about_startup_info_get", {
    name: "get_startup_info_api_app_about_startup_info_get",
    description: `returns helpful startup information`,
    inputSchema: { "type": "object", "properties": {} },
    method: "get",
    pathTemplate: "/api/app/about/startup-info",
    executionParameters: [],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["get_app_theme_api_app_about_theme_get", {
    name: "get_app_theme_api_app_about_theme_get",
    description: `Get's the current theme settings`,
    inputSchema: { "type": "object", "properties": {} },
    method: "get",
    pathTemplate: "/api/app/about/theme",
    executionParameters: [],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["get_token_api_auth_token_post", {
    name: "get_token_api_auth_token_post",
    description: `Get Token`,
    inputSchema: { "type": "object", "properties": { "requestBody": { "type": "string", "description": "Request body (content type: application/x-www-form-urlencoded)" } } },
    method: "post",
    pathTemplate: "/api/auth/token",
    executionParameters: [],
    requestBodyContentType: "application/x-www-form-urlencoded",
    securityRequirements: []
  }],
  ["oauth_login_api_auth_oauth_get", {
    name: "oauth_login_api_auth_oauth_get",
    description: `Oauth Login`,
    inputSchema: { "type": "object", "properties": {} },
    method: "get",
    pathTemplate: "/api/auth/oauth",
    executionParameters: [],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["oauth_callback_api_auth_oauth_callback_get", {
    name: "oauth_callback_api_auth_oauth_callback_get",
    description: `Oauth Callback`,
    inputSchema: { "type": "object", "properties": {} },
    method: "get",
    pathTemplate: "/api/auth/oauth/callback",
    executionParameters: [],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["refresh_token_api_auth_refresh_get", {
    name: "refresh_token_api_auth_refresh_get",
    description: `Use a valid token to get another token`,
    inputSchema: { "type": "object", "properties": {} },
    method: "get",
    pathTemplate: "/api/auth/refresh",
    executionParameters: [],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["logout_api_auth_logout_post", {
    name: "logout_api_auth_logout_post",
    description: `Logout`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "post",
    pathTemplate: "/api/auth/logout",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["register_new_user_api_users_register_post", {
    name: "register_new_user_api_users_register_post",
    description: `Register New User`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "group": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Group" }, "household": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Household" }, "groupToken": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Grouptoken" }, "email": { "type": "string", "title": "Email" }, "username": { "type": "string", "title": "Username" }, "fullName": { "type": "string", "title": "Fullname" }, "password": { "type": "string", "title": "Password" }, "passwordConfirm": { "type": "string", "title": "Passwordconfirm" }, "advanced": { "type": "boolean", "title": "Advanced", "default": false }, "private": { "type": "boolean", "title": "Private", "default": false }, "seedData": { "type": "boolean", "title": "Seeddata", "default": false }, "locale": { "type": "string", "title": "Locale", "default": "en-US" } }, "type": "object", "required": ["email", "username", "fullName", "password", "passwordConfirm"], "title": "CreateUserRegistration", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/users/register",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: []
  }],
  ["get_logged_in_user_api_users_self_get", {
    name: "get_logged_in_user_api_users_self_get",
    description: `Get Logged In User`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/users/self",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_logged_in_user_ratings_api_users_self_ratings_get", {
    name: "get_logged_in_user_ratings_api_users_self_ratings_get",
    description: `Get Logged In User Ratings`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/users/self/ratings",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_logged_in_user_rating_for_recipe_api_users_self_ratings__recipe_id__get", {
    name: "get_logged_in_user_rating_for_recipe_api_users_self_ratings__recipe_id__get",
    description: `Get Logged In User Rating For Recipe`,
    inputSchema: { "type": "object", "properties": { "recipe_id": { "type": "string", "format": "uuid4", "title": "Recipe Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["recipe_id"] },
    method: "get",
    pathTemplate: "/api/users/self/ratings/{recipe_id}",
    executionParameters: [{ "name": "recipe_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_logged_in_user_favorites_api_users_self_favorites_get", {
    name: "get_logged_in_user_favorites_api_users_self_favorites_get",
    description: `Get Logged In User Favorites`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/users/self/favorites",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_password_api_users_password_put", {
    name: "update_password_api_users_password_put",
    description: `Resets the User Password`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "currentPassword": { "type": "string", "title": "Currentpassword", "default": "" }, "newPassword": { "type": "string", "minLength": 8, "title": "Newpassword" } }, "type": "object", "required": ["newPassword"], "title": "ChangePassword", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "put",
    pathTemplate: "/api/users/password",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_user_api_users__item_id__put", {
    name: "update_user_api_users__item_id__put",
    description: `Update User`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "id": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "null" }], "title": "Id" }, "username": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Username" }, "fullName": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Fullname" }, "email": { "type": "string", "title": "Email" }, "authMethod": { "default": "Mealie", "type": "string", "enum": ["Mealie", "LDAP", "OIDC"], "title": "AuthMethod" }, "admin": { "type": "boolean", "title": "Admin", "default": false }, "group": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Group" }, "household": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Household" }, "advanced": { "type": "boolean", "title": "Advanced", "default": false }, "canInvite": { "type": "boolean", "title": "Caninvite", "default": false }, "canManage": { "type": "boolean", "title": "Canmanage", "default": false }, "canManageHousehold": { "type": "boolean", "title": "Canmanagehousehold", "default": false }, "canOrganize": { "type": "boolean", "title": "Canorganize", "default": false } }, "type": "object", "required": ["email"], "title": "UserBase", "description": "The JSON request body." } }, "required": ["item_id", "requestBody"] },
    method: "put",
    pathTemplate: "/api/users/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["forgot_password_api_users_forgot_password_post", {
    name: "forgot_password_api_users_forgot_password_post",
    description: `Sends an email with a reset link to the user`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "email": { "type": "string", "title": "Email" } }, "type": "object", "required": ["email"], "title": "ForgotPassword", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/users/forgot-password",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: []
  }],
  ["reset_password_api_users_reset_password_post", {
    name: "reset_password_api_users_reset_password_post",
    description: `Resets the user password`,
    inputSchema: { "type": "object", "properties": { "requestBody": { "properties": { "token": { "type": "string", "title": "Token" }, "email": { "type": "string", "title": "Email" }, "password": { "type": "string", "title": "Password" }, "passwordConfirm": { "type": "string", "title": "Passwordconfirm" } }, "type": "object", "required": ["token", "email", "password", "passwordConfirm"], "title": "ResetPassword", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/users/reset-password",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: []
  }],
  ["update_user_image_api_users__id__image_post", {
    name: "update_user_image_api_users__id__image_post",
    description: `Updates a User Image`,
    inputSchema: { "type": "object", "properties": { "id": { "type": "string", "format": "uuid4", "title": "Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "type": "string", "description": "Request body (content type: multipart/form-data)" } }, "required": ["id", "requestBody"] },
    method: "post",
    pathTemplate: "/api/users/{id}/image",
    executionParameters: [{ "name": "id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "multipart/form-data",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_api_token_api_users_api_tokens_post", {
    name: "create_api_token_api_users_api_tokens_post",
    description: `Create api_token in the Database`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "name": { "type": "string", "title": "Name" }, "integrationId": { "type": "string", "title": "Integrationid", "default": "generic" } }, "type": "object", "required": ["name"], "title": "LongLiveTokenIn", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/users/api-tokens",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_api_token_api_users_api_tokens__token_id__delete", {
    name: "delete_api_token_api_users_api_tokens__token_id__delete",
    description: `Delete api_token from the Database`,
    inputSchema: { "type": "object", "properties": { "token_id": { "type": "number", "title": "Token Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["token_id"] },
    method: "delete",
    pathTemplate: "/api/users/api-tokens/{token_id}",
    executionParameters: [{ "name": "token_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_ratings_api_users__id__ratings_get", {
    name: "get_ratings_api_users__id__ratings_get",
    description: `Get user's rated recipes`,
    inputSchema: { "type": "object", "properties": { "id": { "type": "string", "format": "uuid4", "title": "Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["id"] },
    method: "get",
    pathTemplate: "/api/users/{id}/ratings",
    executionParameters: [{ "name": "id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_favorites_api_users__id__favorites_get", {
    name: "get_favorites_api_users__id__favorites_get",
    description: `Get user's favorited recipes`,
    inputSchema: { "type": "object", "properties": { "id": { "type": "string", "format": "uuid4", "title": "Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["id"] },
    method: "get",
    pathTemplate: "/api/users/{id}/favorites",
    executionParameters: [{ "name": "id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["set_rating_api_users__id__ratings__slug__post", {
    name: "set_rating_api_users__id__ratings__slug__post",
    description: `Sets the user's rating for a recipe`,
    inputSchema: { "type": "object", "properties": { "id": { "type": "string", "format": "uuid4", "title": "Id" }, "slug": { "type": "string", "title": "Slug" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "rating": { "anyOf": [{ "type": "number" }, { "type": "null" }], "title": "Rating" }, "isFavorite": { "anyOf": [{ "type": "boolean" }, { "type": "null" }], "title": "Isfavorite" } }, "type": "object", "title": "UserRatingUpdate", "description": "The JSON request body." } }, "required": ["id", "slug", "requestBody"] },
    method: "post",
    pathTemplate: "/api/users/{id}/ratings/{slug}",
    executionParameters: [{ "name": "id", "in": "path" }, { "name": "slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["add_favorite_api_users__id__favorites__slug__post", {
    name: "add_favorite_api_users__id__favorites__slug__post",
    description: `Adds a recipe to the user's favorites`,
    inputSchema: { "type": "object", "properties": { "id": { "type": "string", "format": "uuid4", "title": "Id" }, "slug": { "type": "string", "title": "Slug" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["id", "slug"] },
    method: "post",
    pathTemplate: "/api/users/{id}/favorites/{slug}",
    executionParameters: [{ "name": "id", "in": "path" }, { "name": "slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["remove_favorite_api_users__id__favorites__slug__delete", {
    name: "remove_favorite_api_users__id__favorites__slug__delete",
    description: `Removes a recipe from the user's favorites`,
    inputSchema: { "type": "object", "properties": { "id": { "type": "string", "format": "uuid4", "title": "Id" }, "slug": { "type": "string", "title": "Slug" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["id", "slug"] },
    method: "delete",
    pathTemplate: "/api/users/{id}/favorites/{slug}",
    executionParameters: [{ "name": "id", "in": "path" }, { "name": "slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_all_api_households_cookbooks_get", {
    name: "get_all_api_households_cookbooks_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/households/cookbooks",
    executionParameters: [{ "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_many_api_households_cookbooks_put", {
    name: "update_many_api_households_cookbooks_put",
    description: `Update Many`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "type": "array", "items": { "properties": { "name": { "type": "string", "title": "Name" }, "description": { "type": "string", "title": "Description", "default": "" }, "slug": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Slug" }, "position": { "type": "number", "title": "Position", "default": 1 }, "public": { "type": "boolean", "title": "Public", "default": false }, "queryFilterString": { "type": "string", "title": "Queryfilterstring", "default": "" }, "groupId": { "type": "string", "format": "uuid4", "title": "Groupid" }, "householdId": { "type": "string", "format": "uuid4", "title": "Householdid" }, "id": { "type": "string", "format": "uuid4", "title": "Id" } }, "type": "object", "required": ["name", "groupId", "householdId", "id"], "title": "UpdateCookBook" }, "title": "Data", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "put",
    pathTemplate: "/api/households/cookbooks",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_one_api_households_cookbooks_post", {
    name: "create_one_api_households_cookbooks_post",
    description: `Create One`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "name": { "type": "string", "title": "Name" }, "description": { "type": "string", "title": "Description", "default": "" }, "slug": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Slug" }, "position": { "type": "number", "title": "Position", "default": 1 }, "public": { "type": "boolean", "title": "Public", "default": false }, "queryFilterString": { "type": "string", "title": "Queryfilterstring", "default": "" } }, "type": "object", "required": ["name"], "title": "CreateCookBook", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/households/cookbooks",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_api_households_cookbooks__item_id__get", {
    name: "get_one_api_households_cookbooks__item_id__get",
    description: `Get One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "string" }], "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "get",
    pathTemplate: "/api/households/cookbooks/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_one_api_households_cookbooks__item_id__put", {
    name: "update_one_api_households_cookbooks__item_id__put",
    description: `Update One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "name": { "type": "string", "title": "Name" }, "description": { "type": "string", "title": "Description", "default": "" }, "slug": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Slug" }, "position": { "type": "number", "title": "Position", "default": 1 }, "public": { "type": "boolean", "title": "Public", "default": false }, "queryFilterString": { "type": "string", "title": "Queryfilterstring", "default": "" } }, "type": "object", "required": ["name"], "title": "CreateCookBook", "description": "The JSON request body." } }, "required": ["item_id", "requestBody"] },
    method: "put",
    pathTemplate: "/api/households/cookbooks/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_one_api_households_cookbooks__item_id__delete", {
    name: "delete_one_api_households_cookbooks__item_id__delete",
    description: `Delete One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "delete",
    pathTemplate: "/api/households/cookbooks/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_all_api_households_events_notifications_get", {
    name: "get_all_api_households_events_notifications_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/households/events/notifications",
    executionParameters: [{ "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_one_api_households_events_notifications_post", {
    name: "create_one_api_households_events_notifications_post",
    description: `Create One`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "name": { "type": "string", "title": "Name" }, "appriseUrl": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Appriseurl" } }, "type": "object", "required": ["name"], "title": "GroupEventNotifierCreate", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/households/events/notifications",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_api_households_events_notifications__item_id__get", {
    name: "get_one_api_households_events_notifications__item_id__get",
    description: `Get One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "get",
    pathTemplate: "/api/households/events/notifications/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_one_api_households_events_notifications__item_id__put", {
    name: "update_one_api_households_events_notifications__item_id__put",
    description: `Update One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "name": { "type": "string", "title": "Name" }, "appriseUrl": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Appriseurl" }, "enabled": { "type": "boolean", "title": "Enabled", "default": true }, "groupId": { "type": "string", "format": "uuid4", "title": "Groupid" }, "householdId": { "type": "string", "format": "uuid4", "title": "Householdid" }, "options": { "default": { "testMessage": false, "webhookTask": false, "recipeCreated": false, "recipeUpdated": false, "recipeDeleted": false, "userSignup": false, "dataMigrations": false, "dataExport": false, "dataImport": false, "mealplanEntryCreated": false, "shoppingListCreated": false, "shoppingListUpdated": false, "shoppingListDeleted": false, "cookbookCreated": false, "cookbookUpdated": false, "cookbookDeleted": false, "tagCreated": false, "tagUpdated": false, "tagDeleted": false, "categoryCreated": false, "categoryUpdated": false, "categoryDeleted": false, "labelCreated": false, "labelUpdated": false, "labelDeleted": false }, "properties": { "testMessage": { "type": "boolean", "title": "Testmessage", "default": false }, "webhookTask": { "type": "boolean", "title": "Webhooktask", "default": false }, "recipeCreated": { "type": "boolean", "title": "Recipecreated", "default": false }, "recipeUpdated": { "type": "boolean", "title": "Recipeupdated", "default": false }, "recipeDeleted": { "type": "boolean", "title": "Recipedeleted", "default": false }, "userSignup": { "type": "boolean", "title": "Usersignup", "default": false }, "dataMigrations": { "type": "boolean", "title": "Datamigrations", "default": false }, "dataExport": { "type": "boolean", "title": "Dataexport", "default": false }, "dataImport": { "type": "boolean", "title": "Dataimport", "default": false }, "mealplanEntryCreated": { "type": "boolean", "title": "Mealplanentrycreated", "default": false }, "shoppingListCreated": { "type": "boolean", "title": "Shoppinglistcreated", "default": false }, "shoppingListUpdated": { "type": "boolean", "title": "Shoppinglistupdated", "default": false }, "shoppingListDeleted": { "type": "boolean", "title": "Shoppinglistdeleted", "default": false }, "cookbookCreated": { "type": "boolean", "title": "Cookbookcreated", "default": false }, "cookbookUpdated": { "type": "boolean", "title": "Cookbookupdated", "default": false }, "cookbookDeleted": { "type": "boolean", "title": "Cookbookdeleted", "default": false }, "tagCreated": { "type": "boolean", "title": "Tagcreated", "default": false }, "tagUpdated": { "type": "boolean", "title": "Tagupdated", "default": false }, "tagDeleted": { "type": "boolean", "title": "Tagdeleted", "default": false }, "categoryCreated": { "type": "boolean", "title": "Categorycreated", "default": false }, "categoryUpdated": { "type": "boolean", "title": "Categoryupdated", "default": false }, "categoryDeleted": { "type": "boolean", "title": "Categorydeleted", "default": false }, "labelCreated": { "type": "boolean", "title": "Labelcreated", "default": false }, "labelUpdated": { "type": "boolean", "title": "Labelupdated", "default": false }, "labelDeleted": { "type": "boolean", "title": "Labeldeleted", "default": false } }, "type": "object", "title": "GroupEventNotifierOptions", "description": "These events are in-sync with the EventTypes found in the EventBusService.\nIf you modify this, make sure to update the EventBusService as well." }, "id": { "type": "string", "format": "uuid4", "title": "Id" } }, "type": "object", "required": ["name", "groupId", "householdId", "id"], "title": "GroupEventNotifierUpdate", "description": "The JSON request body." } }, "required": ["item_id", "requestBody"] },
    method: "put",
    pathTemplate: "/api/households/events/notifications/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_one_api_households_events_notifications__item_id__delete", {
    name: "delete_one_api_households_events_notifications__item_id__delete",
    description: `Delete One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "delete",
    pathTemplate: "/api/households/events/notifications/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["test_notification_api_households_events_notifications__item_id__test_post", {
    name: "test_notification_api_households_events_notifications__item_id__test_post",
    description: `Test Notification`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "post",
    pathTemplate: "/api/households/events/notifications/{item_id}/test",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_all_api_households_recipe_actions_get", {
    name: "get_all_api_households_recipe_actions_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/households/recipe-actions",
    executionParameters: [{ "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_one_api_households_recipe_actions_post", {
    name: "create_one_api_households_recipe_actions_post",
    description: `Create One`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "actionType": { "type": "string", "enum": ["link", "post"], "title": "GroupRecipeActionType" }, "title": { "type": "string", "title": "Title" }, "url": { "type": "string", "title": "Url" } }, "type": "object", "required": ["actionType", "title", "url"], "title": "CreateGroupRecipeAction", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/households/recipe-actions",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_api_households_recipe_actions__item_id__get", {
    name: "get_one_api_households_recipe_actions__item_id__get",
    description: `Get One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "get",
    pathTemplate: "/api/households/recipe-actions/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_one_api_households_recipe_actions__item_id__put", {
    name: "update_one_api_households_recipe_actions__item_id__put",
    description: `Update One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "actionType": { "type": "string", "enum": ["link", "post"], "title": "GroupRecipeActionType" }, "title": { "type": "string", "title": "Title" }, "url": { "type": "string", "title": "Url" }, "groupId": { "type": "string", "format": "uuid4", "title": "Groupid" }, "householdId": { "type": "string", "format": "uuid4", "title": "Householdid" } }, "type": "object", "required": ["actionType", "title", "url", "groupId", "householdId"], "title": "SaveGroupRecipeAction", "description": "The JSON request body." } }, "required": ["item_id", "requestBody"] },
    method: "put",
    pathTemplate: "/api/households/recipe-actions/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_one_api_households_recipe_actions__item_id__delete", {
    name: "delete_one_api_households_recipe_actions__item_id__delete",
    description: `Delete One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "delete",
    pathTemplate: "/api/households/recipe-actions/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["trigger_action_api_households_recipe_actions__item_id__trigger__recipe_slug__post", {
    name: "trigger_action_api_households_recipe_actions__item_id__trigger__recipe_slug__post",
    description: `Trigger Action`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "recipe_slug": { "type": "string", "title": "Recipe Slug" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "recipe_scale": { "type": "number", "title": "Recipe Scale", "default": 1 } }, "type": "object", "title": "Body_trigger_action_api_households_recipe_actions__item_id__trigger__recipe_slug__post", "description": "The JSON request body." } }, "required": ["item_id", "recipe_slug"] },
    method: "post",
    pathTemplate: "/api/households/recipe-actions/{item_id}/trigger/{recipe_slug}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "recipe_slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_logged_in_user_household_api_households_self_get", {
    name: "get_logged_in_user_household_api_households_self_get",
    description: `Returns the Household Data for the Current User`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/households/self",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_household_recipe_api_households_self_recipes__recipe_slug__get", {
    name: "get_household_recipe_api_households_self_recipes__recipe_slug__get",
    description: `Returns recipe data for the current household`,
    inputSchema: { "type": "object", "properties": { "recipe_slug": { "type": "string", "title": "Recipe Slug" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["recipe_slug"] },
    method: "get",
    pathTemplate: "/api/households/self/recipes/{recipe_slug}",
    executionParameters: [{ "name": "recipe_slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_household_members_api_households_members_get", {
    name: "get_household_members_api_households_members_get",
    description: `Returns all users belonging to the current household`,
    inputSchema: { "type": "object", "properties": { "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/households/members",
    executionParameters: [{ "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_household_preferences_api_households_preferences_get", {
    name: "get_household_preferences_api_households_preferences_get",
    description: `Get Household Preferences`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/households/preferences",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_household_preferences_api_households_preferences_put", {
    name: "update_household_preferences_api_households_preferences_put",
    description: `Update Household Preferences`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "privateHousehold": { "type": "boolean", "title": "Privatehousehold", "default": true }, "lockRecipeEditsFromOtherHouseholds": { "type": "boolean", "title": "Lockrecipeeditsfromotherhouseholds", "default": true }, "firstDayOfWeek": { "type": "number", "title": "Firstdayofweek", "default": 0 }, "recipePublic": { "type": "boolean", "title": "Recipepublic", "default": true }, "recipeShowNutrition": { "type": "boolean", "title": "Recipeshownutrition", "default": false }, "recipeShowAssets": { "type": "boolean", "title": "Recipeshowassets", "default": false }, "recipeLandscapeView": { "type": "boolean", "title": "Recipelandscapeview", "default": false }, "recipeDisableComments": { "type": "boolean", "title": "Recipedisablecomments", "default": false } }, "type": "object", "title": "UpdateHouseholdPreferences", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "put",
    pathTemplate: "/api/households/preferences",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["set_member_permissions_api_households_permissions_put", {
    name: "set_member_permissions_api_households_permissions_put",
    description: `Set Member Permissions`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "userId": { "type": "string", "format": "uuid4", "title": "Userid" }, "canManageHousehold": { "type": "boolean", "title": "Canmanagehousehold", "default": false }, "canManage": { "type": "boolean", "title": "Canmanage", "default": false }, "canInvite": { "type": "boolean", "title": "Caninvite", "default": false }, "canOrganize": { "type": "boolean", "title": "Canorganize", "default": false } }, "type": "object", "required": ["userId"], "title": "SetPermissions", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "put",
    pathTemplate: "/api/households/permissions",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_statistics_api_households_statistics_get", {
    name: "get_statistics_api_households_statistics_get",
    description: `Get Statistics`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/households/statistics",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_invite_tokens_api_households_invitations_get", {
    name: "get_invite_tokens_api_households_invitations_get",
    description: `Get Invite Tokens`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/households/invitations",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_invite_token_api_households_invitations_post", {
    name: "create_invite_token_api_households_invitations_post",
    description: `Create Invite Token`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "uses": { "type": "number", "title": "Uses" }, "groupId": { "anyOf": [{ "type": "string", "format": "uuid" }, { "type": "null" }], "title": "Groupid" }, "householdId": { "anyOf": [{ "type": "string", "format": "uuid" }, { "type": "null" }], "title": "Householdid" } }, "type": "object", "required": ["uses"], "title": "CreateInviteToken", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/households/invitations",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["email_invitation_api_households_invitations_email_post", {
    name: "email_invitation_api_households_invitations_email_post",
    description: `Email Invitation`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "email": { "type": "string", "title": "Email" }, "token": { "type": "string", "title": "Token" } }, "type": "object", "required": ["email", "token"], "title": "EmailInvitation", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/households/invitations/email",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_all_api_households_shopping_lists_get", {
    name: "get_all_api_households_shopping_lists_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/households/shopping/lists",
    executionParameters: [{ "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_one_api_households_shopping_lists_post", {
    name: "create_one_api_households_shopping_lists_post",
    description: `Create One`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "name": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Name" }, "extras": { "anyOf": [{ "additionalProperties": true, "type": "object" }, { "type": "null" }], "title": "Extras", "default": {} }, "createdAt": { "anyOf": [{ "type": "string", "format": "date-time" }, { "type": "null" }], "title": "Createdat" }, "update_at": { "anyOf": [{ "type": "string", "format": "date-time" }, { "type": "null" }], "title": "Update At" } }, "type": "object", "title": "ShoppingListCreate", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/households/shopping/lists",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_api_households_shopping_lists__item_id__get", {
    name: "get_one_api_households_shopping_lists__item_id__get",
    description: `Get One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "get",
    pathTemplate: "/api/households/shopping/lists/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_one_api_households_shopping_lists__item_id__put", {
    name: "update_one_api_households_shopping_lists__item_id__put",
    description: `Update One`,
    inputSchema: {},
    method: "put",
    pathTemplate: "/api/households/shopping/lists/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_one_api_households_shopping_lists__item_id__delete", {
    name: "delete_one_api_households_shopping_lists__item_id__delete",
    description: `Delete One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "delete",
    pathTemplate: "/api/households/shopping/lists/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_label_settings_api_households_shopping_lists__item_id__label_settings_put", {
    name: "update_label_settings_api_households_shopping_lists__item_id__label_settings_put",
    description: `Update Label Settings`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "type": "array", "items": { "properties": { "shoppingListId": { "type": "string", "format": "uuid4", "title": "Shoppinglistid" }, "labelId": { "type": "string", "format": "uuid4", "title": "Labelid" }, "position": { "type": "number", "title": "Position", "default": 0 }, "id": { "type": "string", "format": "uuid4", "title": "Id" } }, "type": "object", "required": ["shoppingListId", "labelId", "id"], "title": "ShoppingListMultiPurposeLabelUpdate" }, "title": "Data", "description": "The JSON request body." } }, "required": ["item_id", "requestBody"] },
    method: "put",
    pathTemplate: "/api/households/shopping/lists/{item_id}/label-settings",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["add_recipe_ingredients_to_list_api_households_shopping_lists__item_id__recipe_post", {
    name: "add_recipe_ingredients_to_list_api_households_shopping_lists__item_id__recipe_post",
    description: `Add Recipe Ingredients To List`,
    inputSchema: {},
    method: "post",
    pathTemplate: "/api/households/shopping/lists/{item_id}/recipe",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["add_single_recipe_ingredients_to_list_api_households_shopping_lists__item_id__recipe__recipe_id__post", {
    name: "add_single_recipe_ingredients_to_list_api_households_shopping_lists__item_id__recipe__recipe_id__post",
    description: `Add Single Recipe Ingredients To List`,
    inputSchema: {},
    method: "post",
    pathTemplate: "/api/households/shopping/lists/{item_id}/recipe/{recipe_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "recipe_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["remove_recipe_ingredients_from_list_api_households_shopping_lists__item_id__recipe__recipe_id__delete_post", {
    name: "remove_recipe_ingredients_from_list_api_households_shopping_lists__item_id__recipe__recipe_id__delete_post",
    description: `Remove Recipe Ingredients From List`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "recipe_id": { "type": "string", "format": "uuid4", "title": "Recipe Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "anyOf": [{ "properties": { "recipeDecrementQuantity": { "type": "number", "title": "Recipedecrementquantity", "default": 1 } }, "type": "object", "title": "ShoppingListRemoveRecipeParams" }, { "type": "null" }], "title": "Data", "description": "The JSON request body." } }, "required": ["item_id", "recipe_id"] },
    method: "post",
    pathTemplate: "/api/households/shopping/lists/{item_id}/recipe/{recipe_id}/delete",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "recipe_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_all_api_households_shopping_items_get", {
    name: "get_all_api_households_shopping_items_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/households/shopping/items",
    executionParameters: [{ "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_many_api_households_shopping_items_put", {
    name: "update_many_api_households_shopping_items_put",
    description: `Update Many`,
    inputSchema: {},
    method: "put",
    pathTemplate: "/api/households/shopping/items",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_one_api_households_shopping_items_post", {
    name: "create_one_api_households_shopping_items_post",
    description: `Create One`,
    inputSchema: {},
    method: "post",
    pathTemplate: "/api/households/shopping/items",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_many_api_households_shopping_items_delete", {
    name: "delete_many_api_households_shopping_items_delete",
    description: `Delete Many`,
    inputSchema: { "type": "object", "properties": { "ids": { "type": "array", "items": { "type": "string", "format": "uuid4" }, "title": "Ids" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "delete",
    pathTemplate: "/api/households/shopping/items",
    executionParameters: [{ "name": "ids", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_many_api_households_shopping_items_create_bulk_post", {
    name: "create_many_api_households_shopping_items_create_bulk_post",
    description: `Create Many`,
    inputSchema: {},
    method: "post",
    pathTemplate: "/api/households/shopping/items/create-bulk",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_api_households_shopping_items__item_id__get", {
    name: "get_one_api_households_shopping_items__item_id__get",
    description: `Get One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "get",
    pathTemplate: "/api/households/shopping/items/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_one_api_households_shopping_items__item_id__put", {
    name: "update_one_api_households_shopping_items__item_id__put",
    description: `Update One`,
    inputSchema: {},
    method: "put",
    pathTemplate: "/api/households/shopping/items/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_one_api_households_shopping_items__item_id__delete", {
    name: "delete_one_api_households_shopping_items__item_id__delete",
    description: `Delete One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "delete",
    pathTemplate: "/api/households/shopping/items/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_all_api_households_webhooks_get", {
    name: "get_all_api_households_webhooks_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/households/webhooks",
    executionParameters: [{ "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_one_api_households_webhooks_post", {
    name: "create_one_api_households_webhooks_post",
    description: `Create One`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "enabled": { "type": "boolean", "title": "Enabled", "default": true }, "name": { "type": "string", "title": "Name", "default": "" }, "url": { "type": "string", "title": "Url", "default": "" }, "webhookType": { "default": "mealplan", "type": "string", "enum": ["mealplan"], "title": "WebhookType" }, "scheduledTime": { "type": "string", "format": "time", "title": "Scheduledtime" } }, "type": "object", "required": ["scheduledTime"], "title": "CreateWebhook", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/households/webhooks",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["rerun_webhooks_api_households_webhooks_rerun_post", {
    name: "rerun_webhooks_api_households_webhooks_rerun_post",
    description: `Manually re-fires all previously scheduled webhooks for today`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "post",
    pathTemplate: "/api/households/webhooks/rerun",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_api_households_webhooks__item_id__get", {
    name: "get_one_api_households_webhooks__item_id__get",
    description: `Get One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "get",
    pathTemplate: "/api/households/webhooks/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_one_api_households_webhooks__item_id__put", {
    name: "update_one_api_households_webhooks__item_id__put",
    description: `Update One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "enabled": { "type": "boolean", "title": "Enabled", "default": true }, "name": { "type": "string", "title": "Name", "default": "" }, "url": { "type": "string", "title": "Url", "default": "" }, "webhookType": { "default": "mealplan", "type": "string", "enum": ["mealplan"], "title": "WebhookType" }, "scheduledTime": { "type": "string", "format": "time", "title": "Scheduledtime" } }, "type": "object", "required": ["scheduledTime"], "title": "CreateWebhook", "description": "The JSON request body." } }, "required": ["item_id", "requestBody"] },
    method: "put",
    pathTemplate: "/api/households/webhooks/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_one_api_households_webhooks__item_id__delete", {
    name: "delete_one_api_households_webhooks__item_id__delete",
    description: `Delete One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "delete",
    pathTemplate: "/api/households/webhooks/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["test_one_api_households_webhooks__item_id__test_post", {
    name: "test_one_api_households_webhooks__item_id__test_post",
    description: `Test One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "post",
    pathTemplate: "/api/households/webhooks/{item_id}/test",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_all_api_households_mealplans_rules_get", {
    name: "get_all_api_households_mealplans_rules_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/households/mealplans/rules",
    executionParameters: [{ "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_one_api_households_mealplans_rules_post", {
    name: "create_one_api_households_mealplans_rules_post",
    description: `Create One`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "day": { "default": "unset", "type": "string", "enum": ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "unset"], "title": "PlanRulesDay" }, "entryType": { "default": "unset", "type": "string", "enum": ["breakfast", "lunch", "dinner", "side", "snack", "drink", "dessert", "unset"], "title": "PlanRulesType" }, "queryFilterString": { "type": "string", "title": "Queryfilterstring", "default": "" } }, "type": "object", "title": "PlanRulesCreate", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/households/mealplans/rules",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_api_households_mealplans_rules__item_id__get", {
    name: "get_one_api_households_mealplans_rules__item_id__get",
    description: `Get One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "get",
    pathTemplate: "/api/households/mealplans/rules/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_one_api_households_mealplans_rules__item_id__put", {
    name: "update_one_api_households_mealplans_rules__item_id__put",
    description: `Update One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "day": { "default": "unset", "type": "string", "enum": ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "unset"], "title": "PlanRulesDay" }, "entryType": { "default": "unset", "type": "string", "enum": ["breakfast", "lunch", "dinner", "side", "snack", "drink", "dessert", "unset"], "title": "PlanRulesType" }, "queryFilterString": { "type": "string", "title": "Queryfilterstring", "default": "" } }, "type": "object", "title": "PlanRulesCreate", "description": "The JSON request body." } }, "required": ["item_id", "requestBody"] },
    method: "put",
    pathTemplate: "/api/households/mealplans/rules/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_one_api_households_mealplans_rules__item_id__delete", {
    name: "delete_one_api_households_mealplans_rules__item_id__delete",
    description: `Delete One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "delete",
    pathTemplate: "/api/households/mealplans/rules/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_all_api_households_mealplans_get", {
    name: "get_all_api_households_mealplans_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "start_date": { "anyOf": [{ "type": "string", "format": "date" }, { "type": "null" }], "title": "Start Date" }, "end_date": { "anyOf": [{ "type": "string", "format": "date" }, { "type": "null" }], "title": "End Date" }, "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/households/mealplans",
    executionParameters: [{ "name": "start_date", "in": "query" }, { "name": "end_date", "in": "query" }, { "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_one_api_households_mealplans_post", {
    name: "create_one_api_households_mealplans_post",
    description: `Create One`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "date": { "type": "string", "format": "date", "title": "Date" }, "entryType": { "default": "breakfast", "type": "string", "enum": ["breakfast", "lunch", "dinner", "side", "snack", "drink", "dessert"], "title": "PlanEntryType" }, "title": { "type": "string", "title": "Title", "default": "" }, "text": { "type": "string", "title": "Text", "default": "" }, "recipeId": { "anyOf": [{ "type": "string", "format": "uuid" }, { "type": "null" }], "title": "Recipeid" } }, "type": "object", "required": ["date"], "title": "CreatePlanEntry", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/households/mealplans",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_todays_meals_api_households_mealplans_today_get", {
    name: "get_todays_meals_api_households_mealplans_today_get",
    description: `Get Todays Meals`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/households/mealplans/today",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_random_meal_api_households_mealplans_random_post", {
    name: "create_random_meal_api_households_mealplans_random_post",
    description: `\`create_random_meal\` is a route that provides the randomized functionality for mealplaners.
It operates by following the rules set out in the household's mealplan settings. If no settings
are set, it will return any random meal.

Refer to the mealplan settings routes for more information on how rules can be applied
to the random meal selector.`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "date": { "type": "string", "format": "date", "title": "Date" }, "entryType": { "default": "dinner", "type": "string", "enum": ["breakfast", "lunch", "dinner", "side", "snack", "drink", "dessert"], "title": "PlanEntryType" } }, "type": "object", "required": ["date"], "title": "CreateRandomEntry", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/households/mealplans/random",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_api_households_mealplans__item_id__get", {
    name: "get_one_api_households_mealplans__item_id__get",
    description: `Get One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "number", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "get",
    pathTemplate: "/api/households/mealplans/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_one_api_households_mealplans__item_id__put", {
    name: "update_one_api_households_mealplans__item_id__put",
    description: `Update One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "number", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "date": { "type": "string", "format": "date", "title": "Date" }, "entryType": { "default": "breakfast", "type": "string", "enum": ["breakfast", "lunch", "dinner", "side", "snack", "drink", "dessert"], "title": "PlanEntryType" }, "title": { "type": "string", "title": "Title", "default": "" }, "text": { "type": "string", "title": "Text", "default": "" }, "recipeId": { "anyOf": [{ "type": "string", "format": "uuid" }, { "type": "null" }], "title": "Recipeid" }, "id": { "type": "number", "title": "Id" }, "groupId": { "type": "string", "format": "uuid", "title": "Groupid" }, "userId": { "type": "string", "format": "uuid", "title": "Userid" } }, "type": "object", "required": ["date", "id", "groupId", "userId"], "title": "UpdatePlanEntry", "description": "The JSON request body." } }, "required": ["item_id", "requestBody"] },
    method: "put",
    pathTemplate: "/api/households/mealplans/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_one_api_households_mealplans__item_id__delete", {
    name: "delete_one_api_households_mealplans__item_id__delete",
    description: `Delete One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "number", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "delete",
    pathTemplate: "/api/households/mealplans/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_all_households_api_groups_households_get", {
    name: "get_all_households_api_groups_households_get",
    description: `Get All Households`,
    inputSchema: { "type": "object", "properties": { "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/groups/households",
    executionParameters: [{ "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_household_api_groups_households__household_slug__get", {
    name: "get_one_household_api_groups_households__household_slug__get",
    description: `Get One Household`,
    inputSchema: { "type": "object", "properties": { "household_slug": { "type": "string", "title": "Household Slug" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["household_slug"] },
    method: "get",
    pathTemplate: "/api/groups/households/{household_slug}",
    executionParameters: [{ "name": "household_slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_logged_in_user_group_api_groups_self_get", {
    name: "get_logged_in_user_group_api_groups_self_get",
    description: `Returns the Group Data for the Current User`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/groups/self",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_group_members_api_groups_members_get", {
    name: "get_group_members_api_groups_members_get",
    description: `Returns all users belonging to the current group`,
    inputSchema: { "type": "object", "properties": { "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/groups/members",
    executionParameters: [{ "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_group_member_api_groups_members__username_or_id__get", {
    name: "get_group_member_api_groups_members__username_or_id__get",
    description: `Returns a single user belonging to the current group`,
    inputSchema: { "type": "object", "properties": { "username_or_id": { "anyOf": [{ "type": "string" }, { "type": "string", "format": "uuid4" }], "title": "Username Or Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["username_or_id"] },
    method: "get",
    pathTemplate: "/api/groups/members/{username_or_id}",
    executionParameters: [{ "name": "username_or_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_group_preferences_api_groups_preferences_get", {
    name: "get_group_preferences_api_groups_preferences_get",
    description: `Get Group Preferences`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/groups/preferences",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_group_preferences_api_groups_preferences_put", {
    name: "update_group_preferences_api_groups_preferences_put",
    description: `Update Group Preferences`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "privateGroup": { "type": "boolean", "title": "Privategroup", "default": true } }, "type": "object", "title": "UpdateGroupPreferences", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "put",
    pathTemplate: "/api/groups/preferences",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_storage_api_groups_storage_get", {
    name: "get_storage_api_groups_storage_get",
    description: `Get Storage`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/groups/storage",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["start_data_migration_api_groups_migrations_post", {
    name: "start_data_migration_api_groups_migrations_post",
    description: `Start Data Migration`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "type": "string", "description": "Request body (content type: multipart/form-data)" } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/groups/migrations",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "multipart/form-data",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_all_api_groups_reports_get", {
    name: "get_all_api_groups_reports_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "report_type": { "anyOf": [{ "type": "string", "enum": ["backup", "restore", "migration", "bulk_import"], "title": "ReportCategory" }, { "type": "null" }], "title": "Report Type" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/groups/reports",
    executionParameters: [{ "name": "report_type", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_api_groups_reports__item_id__get", {
    name: "get_one_api_groups_reports__item_id__get",
    description: `Get One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "get",
    pathTemplate: "/api/groups/reports/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_one_api_groups_reports__item_id__delete", {
    name: "delete_one_api_groups_reports__item_id__delete",
    description: `Delete One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "delete",
    pathTemplate: "/api/groups/reports/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_all_api_groups_labels_get", {
    name: "get_all_api_groups_labels_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "search": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Search" }, "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/groups/labels",
    executionParameters: [{ "name": "search", "in": "query" }, { "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_one_api_groups_labels_post", {
    name: "create_one_api_groups_labels_post",
    description: `Create One`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "name": { "type": "string", "title": "Name" }, "color": { "type": "string", "title": "Color", "default": "#959595" } }, "type": "object", "required": ["name"], "title": "MultiPurposeLabelCreate", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/groups/labels",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_api_groups_labels__item_id__get", {
    name: "get_one_api_groups_labels__item_id__get",
    description: `Get One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "get",
    pathTemplate: "/api/groups/labels/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_one_api_groups_labels__item_id__put", {
    name: "update_one_api_groups_labels__item_id__put",
    description: `Update One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "name": { "type": "string", "title": "Name" }, "color": { "type": "string", "title": "Color", "default": "#959595" }, "groupId": { "type": "string", "format": "uuid4", "title": "Groupid" }, "id": { "type": "string", "format": "uuid4", "title": "Id" } }, "type": "object", "required": ["name", "groupId", "id"], "title": "MultiPurposeLabelUpdate", "description": "The JSON request body." } }, "required": ["item_id", "requestBody"] },
    method: "put",
    pathTemplate: "/api/groups/labels/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_one_api_groups_labels__item_id__delete", {
    name: "delete_one_api_groups_labels__item_id__delete",
    description: `Delete One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "delete",
    pathTemplate: "/api/groups/labels/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["seed_foods_api_groups_seeders_foods_post", {
    name: "seed_foods_api_groups_seeders_foods_post",
    description: `Seed Foods`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "locale": { "type": "string", "title": "Locale" } }, "type": "object", "required": ["locale"], "title": "SeederConfig", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/groups/seeders/foods",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["seed_labels_api_groups_seeders_labels_post", {
    name: "seed_labels_api_groups_seeders_labels_post",
    description: `Seed Labels`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "locale": { "type": "string", "title": "Locale" } }, "type": "object", "required": ["locale"], "title": "SeederConfig", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/groups/seeders/labels",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["seed_units_api_groups_seeders_units_post", {
    name: "seed_units_api_groups_seeders_units_post",
    description: `Seed Units`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "locale": { "type": "string", "title": "Locale" } }, "type": "object", "required": ["locale"], "title": "SeederConfig", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/groups/seeders/units",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_recipe_formats_and_templates_api_recipes_exports_get", {
    name: "get_recipe_formats_and_templates_api_recipes_exports_get",
    description: `Get Recipe Formats And Templates`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/recipes/exports",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_recipe_as_format_api_recipes__slug__exports_get", {
    name: "get_recipe_as_format_api_recipes__slug__exports_get",
    description: `## Parameters
\`template_name\`: The name of the template to use to use in the exports listed. Template type will automatically
be set on the backend. Because of this, it's important that your templates have unique names. See available
names and formats in the /api/recipes/exports endpoint.`,
    inputSchema: { "type": "object", "properties": { "slug": { "type": "string", "title": "Slug" }, "template_name": { "type": "string", "title": "Template Name" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["slug", "template_name"] },
    method: "get",
    pathTemplate: "/api/recipes/{slug}/exports",
    executionParameters: [{ "name": "slug", "in": "path" }, { "name": "template_name", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["test_parse_recipe_url_api_recipes_test_scrape_url_post", {
    name: "test_parse_recipe_url_api_recipes_test_scrape_url_post",
    description: `Test Parse Recipe Url`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "url": { "type": "string", "title": "Url" }, "useOpenAI": { "type": "boolean", "title": "Useopenai", "default": false } }, "type": "object", "required": ["url"], "title": "ScrapeRecipeTest", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/recipes/test-scrape-url",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_recipe_from_html_or_json_api_recipes_create_html_or_json_post", {
    name: "create_recipe_from_html_or_json_api_recipes_create_html_or_json_post",
    description: `Takes in raw HTML or a https://schema.org/Recipe object as a JSON string and parses it like a URL`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "includeTags": { "type": "boolean", "title": "Includetags", "default": false }, "includeCategories": { "type": "boolean", "title": "Includecategories", "default": false }, "data": { "type": "string", "title": "Data" }, "url": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Url" } }, "type": "object", "required": ["data"], "title": "ScrapeRecipeData", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/recipes/create/html-or-json",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["parse_recipe_url_api_recipes_create_url_post", {
    name: "parse_recipe_url_api_recipes_create_url_post",
    description: `Takes in a URL and attempts to scrape data and load it into the database`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "includeTags": { "type": "boolean", "title": "Includetags", "default": false }, "includeCategories": { "type": "boolean", "title": "Includecategories", "default": false }, "url": { "type": "string", "title": "Url" } }, "type": "object", "required": ["url"], "title": "ScrapeRecipe", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/recipes/create/url",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["parse_recipe_url_bulk_api_recipes_create_url_bulk_post", {
    name: "parse_recipe_url_bulk_api_recipes_create_url_bulk_post",
    description: `Takes in a URL and attempts to scrape data and load it into the database`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "imports": { "items": { "properties": { "url": { "type": "string", "title": "Url" }, "categories": { "anyOf": [{ "items": { "properties": { "id": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "null" }], "title": "Id" }, "groupId": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "null" }], "title": "Groupid" }, "name": { "type": "string", "title": "Name" }, "slug": { "type": "string", "title": "Slug" } }, "type": "object", "required": ["name", "slug"], "title": "RecipeCategory" }, "type": "array" }, { "type": "null" }], "title": "Categories" }, "tags": { "anyOf": [{ "items": { "properties": { "id": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "null" }], "title": "Id" }, "groupId": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "null" }], "title": "Groupid" }, "name": { "type": "string", "title": "Name" }, "slug": { "type": "string", "title": "Slug" } }, "type": "object", "required": ["name", "slug"], "title": "RecipeTag" }, "type": "array" }, { "type": "null" }], "title": "Tags" } }, "type": "object", "required": ["url"], "title": "CreateRecipeBulk" }, "type": "array", "title": "Imports" } }, "type": "object", "required": ["imports"], "title": "CreateRecipeByUrlBulk", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/recipes/create/url/bulk",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_recipe_from_zip_api_recipes_create_zip_post", {
    name: "create_recipe_from_zip_api_recipes_create_zip_post",
    description: `Create recipe from archive`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "type": "string", "description": "Request body (content type: multipart/form-data)" } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/recipes/create/zip",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "multipart/form-data",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_recipe_from_image_api_recipes_create_image_post", {
    name: "create_recipe_from_image_api_recipes_create_image_post",
    description: `Create a recipe from an image using OpenAI.
Optionally specify a language for it to translate the recipe to.`,
    inputSchema: { "type": "object", "properties": { "translateLanguage": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Translatelanguage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "type": "string", "description": "Request body (content type: multipart/form-data)" } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/recipes/create/image",
    executionParameters: [{ "name": "translateLanguage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "multipart/form-data",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_all_api_recipes_get", {
    name: "get_all_api_recipes_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "categories": { "anyOf": [{ "type": "array", "items": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "string" }] } }, { "type": "null" }], "title": "Categories" }, "tags": { "anyOf": [{ "type": "array", "items": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "string" }] } }, { "type": "null" }], "title": "Tags" }, "tools": { "anyOf": [{ "type": "array", "items": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "string" }] } }, { "type": "null" }], "title": "Tools" }, "foods": { "anyOf": [{ "type": "array", "items": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "string" }] } }, { "type": "null" }], "title": "Foods" }, "households": { "anyOf": [{ "type": "array", "items": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "string" }] } }, { "type": "null" }], "title": "Households" }, "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "cookbook": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "string" }, { "type": "null" }], "title": "Cookbook" }, "requireAllCategories": { "type": "boolean", "default": false, "title": "Requireallcategories" }, "requireAllTags": { "type": "boolean", "default": false, "title": "Requirealltags" }, "requireAllTools": { "type": "boolean", "default": false, "title": "Requirealltools" }, "requireAllFoods": { "type": "boolean", "default": false, "title": "Requireallfoods" }, "search": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Search" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/recipes",
    executionParameters: [{ "name": "categories", "in": "query" }, { "name": "tags", "in": "query" }, { "name": "tools", "in": "query" }, { "name": "foods", "in": "query" }, { "name": "households", "in": "query" }, { "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "cookbook", "in": "query" }, { "name": "requireAllCategories", "in": "query" }, { "name": "requireAllTags", "in": "query" }, { "name": "requireAllTools", "in": "query" }, { "name": "requireAllFoods", "in": "query" }, { "name": "search", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_many_api_recipes_put", {
    name: "update_many_api_recipes_put",
    description: `Update Many`,
    inputSchema: {},
    method: "put",
    pathTemplate: "/api/recipes",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_one_api_recipes_post", {
    name: "create_one_api_recipes_post",
    description: `Takes in a JSON string and loads data into the database as a new entry`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "name": { "type": "string", "title": "Name" } }, "type": "object", "required": ["name"], "title": "CreateRecipe", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/recipes",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["patch_many_api_recipes_patch", {
    name: "patch_many_api_recipes_patch",
    description: `Patch Many`,
    inputSchema: {},
    method: "patch",
    pathTemplate: "/api/recipes",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["suggest_recipes_api_recipes_suggestions_get", {
    name: "suggest_recipes_api_recipes_suggestions_get",
    description: `Suggest Recipes`,
    inputSchema: { "type": "object", "properties": { "foods": { "anyOf": [{ "type": "array", "items": { "type": "string", "format": "uuid4" } }, { "type": "null" }], "title": "Foods" }, "tools": { "anyOf": [{ "type": "array", "items": { "type": "string", "format": "uuid4" } }, { "type": "null" }], "title": "Tools" }, "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "limit": { "type": "number", "default": 10, "title": "Limit" }, "maxMissingFoods": { "type": "number", "default": 5, "title": "Maxmissingfoods" }, "maxMissingTools": { "type": "number", "default": 5, "title": "Maxmissingtools" }, "includeFoodsOnHand": { "type": "boolean", "default": true, "title": "Includefoodsonhand" }, "includeToolsOnHand": { "type": "boolean", "default": true, "title": "Includetoolsonhand" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/recipes/suggestions",
    executionParameters: [{ "name": "foods", "in": "query" }, { "name": "tools", "in": "query" }, { "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "limit", "in": "query" }, { "name": "maxMissingFoods", "in": "query" }, { "name": "maxMissingTools", "in": "query" }, { "name": "includeFoodsOnHand", "in": "query" }, { "name": "includeToolsOnHand", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_api_recipes__slug__get", {
    name: "get_one_api_recipes__slug__get",
    description: `Takes in a recipe's slug or id and returns all data for a recipe`,
    inputSchema: { "type": "object", "properties": { "slug": { "type": "string", "description": "A recipe's slug or id", "title": "Slug" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["slug"] },
    method: "get",
    pathTemplate: "/api/recipes/{slug}",
    executionParameters: [{ "name": "slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_one_api_recipes__slug__put", {
    name: "update_one_api_recipes__slug__put",
    description: `Updates a recipe by existing slug and data.`,
    inputSchema: {},
    method: "put",
    pathTemplate: "/api/recipes/{slug}",
    executionParameters: [{ "name": "slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_one_api_recipes__slug__delete", {
    name: "delete_one_api_recipes__slug__delete",
    description: `Deletes a recipe by slug`,
    inputSchema: { "type": "object", "properties": { "slug": { "type": "string", "title": "Slug" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["slug"] },
    method: "delete",
    pathTemplate: "/api/recipes/{slug}",
    executionParameters: [{ "name": "slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["patch_one_api_recipes__slug__patch", {
    name: "patch_one_api_recipes__slug__patch",
    description: `Updates a recipe by existing slug and data.`,
    inputSchema: {},
    method: "patch",
    pathTemplate: "/api/recipes/{slug}",
    executionParameters: [{ "name": "slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["duplicate_one_api_recipes__slug__duplicate_post", {
    name: "duplicate_one_api_recipes__slug__duplicate_post",
    description: `Duplicates a recipe with a new custom name if given`,
    inputSchema: { "type": "object", "properties": { "slug": { "type": "string", "title": "Slug" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "name": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Name" } }, "type": "object", "title": "RecipeDuplicate", "description": "The JSON request body." } }, "required": ["slug", "requestBody"] },
    method: "post",
    pathTemplate: "/api/recipes/{slug}/duplicate",
    executionParameters: [{ "name": "slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_last_made_api_recipes__slug__last_made_patch", {
    name: "update_last_made_api_recipes__slug__last_made_patch",
    description: `Update a recipe's last made timestamp`,
    inputSchema: { "type": "object", "properties": { "slug": { "type": "string", "title": "Slug" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "timestamp": { "type": "string", "format": "date-time", "title": "Timestamp" } }, "type": "object", "required": ["timestamp"], "title": "RecipeLastMade", "description": "The JSON request body." } }, "required": ["slug", "requestBody"] },
    method: "patch",
    pathTemplate: "/api/recipes/{slug}/last-made",
    executionParameters: [{ "name": "slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_recipe_image_api_recipes__slug__image_put", {
    name: "update_recipe_image_api_recipes__slug__image_put",
    description: `Update Recipe Image`,
    inputSchema: { "type": "object", "properties": { "slug": { "type": "string", "title": "Slug" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "type": "string", "description": "Request body (content type: multipart/form-data)" } }, "required": ["slug", "requestBody"] },
    method: "put",
    pathTemplate: "/api/recipes/{slug}/image",
    executionParameters: [{ "name": "slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "multipart/form-data",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["scrape_image_url_api_recipes__slug__image_post", {
    name: "scrape_image_url_api_recipes__slug__image_post",
    description: `Scrape Image Url`,
    inputSchema: { "type": "object", "properties": { "slug": { "type": "string", "title": "Slug" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "includeTags": { "type": "boolean", "title": "Includetags", "default": false }, "includeCategories": { "type": "boolean", "title": "Includecategories", "default": false }, "url": { "type": "string", "title": "Url" } }, "type": "object", "required": ["url"], "title": "ScrapeRecipe", "description": "The JSON request body." } }, "required": ["slug", "requestBody"] },
    method: "post",
    pathTemplate: "/api/recipes/{slug}/image",
    executionParameters: [{ "name": "slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_recipe_image_api_recipes__slug__image_delete", {
    name: "delete_recipe_image_api_recipes__slug__image_delete",
    description: `Delete Recipe Image`,
    inputSchema: { "type": "object", "properties": { "slug": { "type": "string", "title": "Slug" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["slug"] },
    method: "delete",
    pathTemplate: "/api/recipes/{slug}/image",
    executionParameters: [{ "name": "slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["upload_recipe_asset_api_recipes__slug__assets_post", {
    name: "upload_recipe_asset_api_recipes__slug__assets_post",
    description: `Upload a file to store as a recipe asset`,
    inputSchema: { "type": "object", "properties": { "slug": { "type": "string", "title": "Slug" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "type": "string", "description": "Request body (content type: multipart/form-data)" } }, "required": ["slug", "requestBody"] },
    method: "post",
    pathTemplate: "/api/recipes/{slug}/assets",
    executionParameters: [{ "name": "slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "multipart/form-data",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_recipe_comments_api_recipes__slug__comments_get", {
    name: "get_recipe_comments_api_recipes__slug__comments_get",
    description: `Get all comments for a recipe`,
    inputSchema: { "type": "object", "properties": { "slug": { "type": "string", "title": "Slug" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["slug"] },
    method: "get",
    pathTemplate: "/api/recipes/{slug}/comments",
    executionParameters: [{ "name": "slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["bulk_tag_recipes_api_recipes_bulk_actions_tag_post", {
    name: "bulk_tag_recipes_api_recipes_bulk_actions_tag_post",
    description: `Bulk Tag Recipes`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "recipes": { "items": { "type": "string" }, "type": "array", "title": "Recipes" }, "tags": { "items": { "properties": { "name": { "type": "string", "title": "Name" }, "id": { "type": "string", "format": "uuid4", "title": "Id" }, "groupId": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "null" }], "title": "Groupid" }, "slug": { "type": "string", "title": "Slug" } }, "type": "object", "required": ["name", "id", "slug"], "title": "TagBase" }, "type": "array", "title": "Tags" } }, "type": "object", "required": ["recipes", "tags"], "title": "AssignTags", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/recipes/bulk-actions/tag",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["bulk_settings_recipes_api_recipes_bulk_actions_settings_post", {
    name: "bulk_settings_recipes_api_recipes_bulk_actions_settings_post",
    description: `Bulk Settings Recipes`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "recipes": { "items": { "type": "string" }, "type": "array", "title": "Recipes" }, "settings": { "properties": { "public": { "type": "boolean", "title": "Public", "default": false }, "showNutrition": { "type": "boolean", "title": "Shownutrition", "default": false }, "showAssets": { "type": "boolean", "title": "Showassets", "default": false }, "landscapeView": { "type": "boolean", "title": "Landscapeview", "default": false }, "disableComments": { "type": "boolean", "title": "Disablecomments", "default": true }, "locked": { "type": "boolean", "title": "Locked", "default": false } }, "type": "object", "title": "RecipeSettings" } }, "type": "object", "required": ["recipes", "settings"], "title": "AssignSettings", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/recipes/bulk-actions/settings",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["bulk_categorize_recipes_api_recipes_bulk_actions_categorize_post", {
    name: "bulk_categorize_recipes_api_recipes_bulk_actions_categorize_post",
    description: `Bulk Categorize Recipes`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "recipes": { "items": { "type": "string" }, "type": "array", "title": "Recipes" }, "categories": { "items": { "properties": { "name": { "type": "string", "title": "Name" }, "id": { "type": "string", "format": "uuid4", "title": "Id" }, "groupId": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "null" }], "title": "Groupid" }, "slug": { "type": "string", "title": "Slug" } }, "type": "object", "required": ["name", "id", "slug"], "title": "CategoryBase" }, "type": "array", "title": "Categories" } }, "type": "object", "required": ["recipes", "categories"], "title": "AssignCategories", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/recipes/bulk-actions/categorize",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["bulk_delete_recipes_api_recipes_bulk_actions_delete_post", {
    name: "bulk_delete_recipes_api_recipes_bulk_actions_delete_post",
    description: `Bulk Delete Recipes`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "recipes": { "items": { "type": "string" }, "type": "array", "title": "Recipes" } }, "type": "object", "required": ["recipes"], "title": "DeleteRecipes", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/recipes/bulk-actions/delete",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_exported_data_api_recipes_bulk_actions_export_get", {
    name: "get_exported_data_api_recipes_bulk_actions_export_get",
    description: `Get Exported Data`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/recipes/bulk-actions/export",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["bulk_export_recipes_api_recipes_bulk_actions_export_post", {
    name: "bulk_export_recipes_api_recipes_bulk_actions_export_post",
    description: `Bulk Export Recipes`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "recipes": { "items": { "type": "string" }, "type": "array", "title": "Recipes" }, "exportType": { "default": "json", "type": "string", "enum": ["json"], "title": "ExportTypes" } }, "type": "object", "required": ["recipes"], "title": "ExportRecipes", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/recipes/bulk-actions/export",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_exported_data_token_api_recipes_bulk_actions_export__export_id__download_get", {
    name: "get_exported_data_token_api_recipes_bulk_actions_export__export_id__download_get",
    description: `Returns a token to download a file`,
    inputSchema: { "type": "object", "properties": { "export_id": { "type": "string", "format": "uuid4", "title": "Export Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["export_id"] },
    method: "get",
    pathTemplate: "/api/recipes/bulk-actions/export/{export_id}/download",
    executionParameters: [{ "name": "export_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["purge_export_data_api_recipes_bulk_actions_export_purge_delete", {
    name: "purge_export_data_api_recipes_bulk_actions_export_purge_delete",
    description: `Remove all exports data, including items on disk without database entry`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "delete",
    pathTemplate: "/api/recipes/bulk-actions/export/purge",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_shared_recipe_api_recipes_shared__token_id__get", {
    name: "get_shared_recipe_api_recipes_shared__token_id__get",
    description: `Get Shared Recipe`,
    inputSchema: { "type": "object", "properties": { "token_id": { "type": "string", "format": "uuid4", "title": "Token Id" } }, "required": ["token_id"] },
    method: "get",
    pathTemplate: "/api/recipes/shared/{token_id}",
    executionParameters: [{ "name": "token_id", "in": "path" }],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["get_shared_recipe_as_zip_api_recipes_shared__token_id__zip_get", {
    name: "get_shared_recipe_as_zip_api_recipes_shared__token_id__zip_get",
    description: `Get a recipe and its original image as a Zip file`,
    inputSchema: { "type": "object", "properties": { "token_id": { "type": "string", "format": "uuid4", "title": "Token Id" } }, "required": ["token_id"] },
    method: "get",
    pathTemplate: "/api/recipes/shared/{token_id}/zip",
    executionParameters: [{ "name": "token_id", "in": "path" }],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["get_all_api_recipes_timeline_events_get", {
    name: "get_all_api_recipes_timeline_events_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/recipes/timeline/events",
    executionParameters: [{ "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_one_api_recipes_timeline_events_post", {
    name: "create_one_api_recipes_timeline_events_post",
    description: `Create One`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "recipeId": { "type": "string", "format": "uuid4", "title": "Recipeid" }, "userId": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "null" }], "title": "Userid" }, "subject": { "type": "string", "title": "Subject" }, "eventType": { "type": "string", "enum": ["system", "info", "comment"], "title": "TimelineEventType" }, "eventMessage": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Eventmessage" }, "image": { "anyOf": [{ "type": "string", "enum": ["has image", "does not have image"], "title": "TimelineEventImage" }, { "type": "null" }], "default": "does not have image" }, "timestamp": { "type": "string", "format": "date-time", "title": "Timestamp", "default": "2025-10-24T15:53:00+00:00" } }, "type": "object", "required": ["recipeId", "subject", "eventType"], "title": "RecipeTimelineEventIn", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/recipes/timeline/events",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_api_recipes_timeline_events__item_id__get", {
    name: "get_one_api_recipes_timeline_events__item_id__get",
    description: `Get One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "get",
    pathTemplate: "/api/recipes/timeline/events/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_one_api_recipes_timeline_events__item_id__put", {
    name: "update_one_api_recipes_timeline_events__item_id__put",
    description: `Update One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "subject": { "type": "string", "title": "Subject" }, "eventMessage": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Eventmessage" }, "image": { "anyOf": [{ "type": "string", "enum": ["has image", "does not have image"], "title": "TimelineEventImage" }, { "type": "null" }] } }, "type": "object", "required": ["subject"], "title": "RecipeTimelineEventUpdate", "description": "The JSON request body." } }, "required": ["item_id", "requestBody"] },
    method: "put",
    pathTemplate: "/api/recipes/timeline/events/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_one_api_recipes_timeline_events__item_id__delete", {
    name: "delete_one_api_recipes_timeline_events__item_id__delete",
    description: `Delete One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "delete",
    pathTemplate: "/api/recipes/timeline/events/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_event_image_api_recipes_timeline_events__item_id__image_put", {
    name: "update_event_image_api_recipes_timeline_events__item_id__image_put",
    description: `Update Event Image`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "type": "string", "description": "Request body (content type: multipart/form-data)" } }, "required": ["item_id", "requestBody"] },
    method: "put",
    pathTemplate: "/api/recipes/timeline/events/{item_id}/image",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "multipart/form-data",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_all_api_organizers_categories_get", {
    name: "get_all_api_organizers_categories_get",
    description: `Returns a list of available categories in the database`,
    inputSchema: { "type": "object", "properties": { "search": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Search" }, "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/organizers/categories",
    executionParameters: [{ "name": "search", "in": "query" }, { "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_one_api_organizers_categories_post", {
    name: "create_one_api_organizers_categories_post",
    description: `Creates a Category in the database`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "name": { "type": "string", "title": "Name" } }, "type": "object", "required": ["name"], "title": "CategoryIn", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/organizers/categories",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_all_empty_api_organizers_categories_empty_get", {
    name: "get_all_empty_api_organizers_categories_empty_get",
    description: `Returns a list of categories that do not contain any recipes`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/organizers/categories/empty",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_api_organizers_categories__item_id__get", {
    name: "get_one_api_organizers_categories__item_id__get",
    description: `Returns a list of recipes associated with the provided category.`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "get",
    pathTemplate: "/api/organizers/categories/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_one_api_organizers_categories__item_id__put", {
    name: "update_one_api_organizers_categories__item_id__put",
    description: `Updates an existing Tag in the database`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "name": { "type": "string", "title": "Name" } }, "type": "object", "required": ["name"], "title": "CategoryIn", "description": "The JSON request body." } }, "required": ["item_id", "requestBody"] },
    method: "put",
    pathTemplate: "/api/organizers/categories/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_one_api_organizers_categories__item_id__delete", {
    name: "delete_one_api_organizers_categories__item_id__delete",
    description: `Removes a recipe category from the database. Deleting a
category does not impact a recipe. The category will be removed
from any recipes that contain it`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "delete",
    pathTemplate: "/api/organizers/categories/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_by_slug_api_organizers_categories_slug__category_slug__get", {
    name: "get_one_by_slug_api_organizers_categories_slug__category_slug__get",
    description: `Returns a category object with the associated recieps relating to the category`,
    inputSchema: { "type": "object", "properties": { "category_slug": { "type": "string", "title": "Category Slug" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["category_slug"] },
    method: "get",
    pathTemplate: "/api/organizers/categories/slug/{category_slug}",
    executionParameters: [{ "name": "category_slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_all_api_organizers_tags_get", {
    name: "get_all_api_organizers_tags_get",
    description: `Returns a list of available tags in the database`,
    inputSchema: { "type": "object", "properties": { "search": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Search" }, "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/organizers/tags",
    executionParameters: [{ "name": "search", "in": "query" }, { "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_one_api_organizers_tags_post", {
    name: "create_one_api_organizers_tags_post",
    description: `Creates a Tag in the database`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "name": { "type": "string", "title": "Name" } }, "type": "object", "required": ["name"], "title": "TagIn", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/organizers/tags",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_empty_tags_api_organizers_tags_empty_get", {
    name: "get_empty_tags_api_organizers_tags_empty_get",
    description: `Returns a list of tags that do not contain any recipes`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/organizers/tags/empty",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_api_organizers_tags__item_id__get", {
    name: "get_one_api_organizers_tags__item_id__get",
    description: `Returns a list of recipes associated with the provided tag.`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "get",
    pathTemplate: "/api/organizers/tags/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_one_api_organizers_tags__item_id__put", {
    name: "update_one_api_organizers_tags__item_id__put",
    description: `Updates an existing Tag in the database`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "name": { "type": "string", "title": "Name" } }, "type": "object", "required": ["name"], "title": "TagIn", "description": "The JSON request body." } }, "required": ["item_id", "requestBody"] },
    method: "put",
    pathTemplate: "/api/organizers/tags/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_recipe_tag_api_organizers_tags__item_id__delete", {
    name: "delete_recipe_tag_api_organizers_tags__item_id__delete",
    description: `Removes a recipe tag from the database. Deleting a
tag does not impact a recipe. The tag will be removed
from any recipes that contain it`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "delete",
    pathTemplate: "/api/organizers/tags/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_by_slug_api_organizers_tags_slug__tag_slug__get", {
    name: "get_one_by_slug_api_organizers_tags_slug__tag_slug__get",
    description: `Get One By Slug`,
    inputSchema: { "type": "object", "properties": { "tag_slug": { "type": "string", "title": "Tag Slug" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["tag_slug"] },
    method: "get",
    pathTemplate: "/api/organizers/tags/slug/{tag_slug}",
    executionParameters: [{ "name": "tag_slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_all_api_organizers_tools_get", {
    name: "get_all_api_organizers_tools_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "search": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Search" }, "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/organizers/tools",
    executionParameters: [{ "name": "search", "in": "query" }, { "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_one_api_organizers_tools_post", {
    name: "create_one_api_organizers_tools_post",
    description: `Create One`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "name": { "type": "string", "title": "Name" }, "householdsWithTool": { "items": { "type": "string" }, "type": "array", "title": "Householdswithtool", "default": [] } }, "type": "object", "required": ["name"], "title": "RecipeToolCreate", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/organizers/tools",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_api_organizers_tools__item_id__get", {
    name: "get_one_api_organizers_tools__item_id__get",
    description: `Get One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "get",
    pathTemplate: "/api/organizers/tools/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_one_api_organizers_tools__item_id__put", {
    name: "update_one_api_organizers_tools__item_id__put",
    description: `Update One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "name": { "type": "string", "title": "Name" }, "householdsWithTool": { "items": { "type": "string" }, "type": "array", "title": "Householdswithtool", "default": [] } }, "type": "object", "required": ["name"], "title": "RecipeToolCreate", "description": "The JSON request body." } }, "required": ["item_id", "requestBody"] },
    method: "put",
    pathTemplate: "/api/organizers/tools/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_one_api_organizers_tools__item_id__delete", {
    name: "delete_one_api_organizers_tools__item_id__delete",
    description: `Delete One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "delete",
    pathTemplate: "/api/organizers/tools/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_by_slug_api_organizers_tools_slug__tool_slug__get", {
    name: "get_one_by_slug_api_organizers_tools_slug__tool_slug__get",
    description: `Get One By Slug`,
    inputSchema: { "type": "object", "properties": { "tool_slug": { "type": "string", "title": "Tool Slug" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["tool_slug"] },
    method: "get",
    pathTemplate: "/api/organizers/tools/slug/{tool_slug}",
    executionParameters: [{ "name": "tool_slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_all_api_shared_recipes_get", {
    name: "get_all_api_shared_recipes_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "recipe_id": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "null" }], "title": "Recipe Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/shared/recipes",
    executionParameters: [{ "name": "recipe_id", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_one_api_shared_recipes_post", {
    name: "create_one_api_shared_recipes_post",
    description: `Create One`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "recipeId": { "type": "string", "format": "uuid4", "title": "Recipeid" }, "expiresAt": { "type": "string", "format": "date-time", "title": "Expiresat" } }, "type": "object", "required": ["recipeId"], "title": "RecipeShareTokenCreate", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/shared/recipes",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_api_shared_recipes__item_id__get", {
    name: "get_one_api_shared_recipes__item_id__get",
    description: `Get One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "get",
    pathTemplate: "/api/shared/recipes/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_one_api_shared_recipes__item_id__delete", {
    name: "delete_one_api_shared_recipes__item_id__delete",
    description: `Delete One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "delete",
    pathTemplate: "/api/shared/recipes/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_all_api_comments_get", {
    name: "get_all_api_comments_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/comments",
    executionParameters: [{ "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_one_api_comments_post", {
    name: "create_one_api_comments_post",
    description: `Create One`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "recipeId": { "type": "string", "format": "uuid4", "title": "Recipeid" }, "text": { "type": "string", "title": "Text" } }, "type": "object", "required": ["recipeId", "text"], "title": "RecipeCommentCreate", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/comments",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_api_comments__item_id__get", {
    name: "get_one_api_comments__item_id__get",
    description: `Get One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "get",
    pathTemplate: "/api/comments/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_one_api_comments__item_id__put", {
    name: "update_one_api_comments__item_id__put",
    description: `Update One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "id": { "type": "string", "format": "uuid4", "title": "Id" }, "text": { "type": "string", "title": "Text" } }, "type": "object", "required": ["id", "text"], "title": "RecipeCommentUpdate", "description": "The JSON request body." } }, "required": ["item_id", "requestBody"] },
    method: "put",
    pathTemplate: "/api/comments/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_one_api_comments__item_id__delete", {
    name: "delete_one_api_comments__item_id__delete",
    description: `Delete One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "delete",
    pathTemplate: "/api/comments/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["parse_ingredient_api_parser_ingredient_post", {
    name: "parse_ingredient_api_parser_ingredient_post",
    description: `Parse Ingredient`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "parser": { "default": "nlp", "type": "string", "enum": ["nlp", "brute", "openai"], "title": "RegisteredParser" }, "ingredient": { "type": "string", "title": "Ingredient" } }, "type": "object", "required": ["ingredient"], "title": "IngredientRequest", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/parser/ingredient",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["parse_ingredients_api_parser_ingredients_post", {
    name: "parse_ingredients_api_parser_ingredients_post",
    description: `Parse Ingredients`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "parser": { "default": "nlp", "type": "string", "enum": ["nlp", "brute", "openai"], "title": "RegisteredParser" }, "ingredients": { "items": { "type": "string" }, "type": "array", "title": "Ingredients" } }, "type": "object", "required": ["ingredients"], "title": "IngredientsRequest", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/parser/ingredients",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_all_api_foods_get", {
    name: "get_all_api_foods_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "search": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Search" }, "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/foods",
    executionParameters: [{ "name": "search", "in": "query" }, { "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_one_api_foods_post", {
    name: "create_one_api_foods_post",
    description: `Create One`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "id": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "null" }], "title": "Id" }, "name": { "type": "string", "title": "Name" }, "pluralName": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Pluralname" }, "description": { "type": "string", "title": "Description", "default": "" }, "extras": { "anyOf": [{ "additionalProperties": true, "type": "object" }, { "type": "null" }], "title": "Extras", "default": {} }, "labelId": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "null" }], "title": "Labelid" }, "aliases": { "items": { "properties": { "name": { "type": "string", "title": "Name" } }, "type": "object", "required": ["name"], "title": "CreateIngredientFoodAlias" }, "type": "array", "title": "Aliases", "default": [] }, "householdsWithIngredientFood": { "items": { "type": "string" }, "type": "array", "title": "Householdswithingredientfood", "default": [] } }, "type": "object", "required": ["name"], "title": "CreateIngredientFood", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/foods",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["merge_one_api_foods_merge_put", {
    name: "merge_one_api_foods_merge_put",
    description: `Merge One`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "fromFood": { "type": "string", "format": "uuid4", "title": "Fromfood" }, "toFood": { "type": "string", "format": "uuid4", "title": "Tofood" } }, "type": "object", "required": ["fromFood", "toFood"], "title": "MergeFood", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "put",
    pathTemplate: "/api/foods/merge",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_api_foods__item_id__get", {
    name: "get_one_api_foods__item_id__get",
    description: `Get One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "get",
    pathTemplate: "/api/foods/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_one_api_foods__item_id__put", {
    name: "update_one_api_foods__item_id__put",
    description: `Update One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "id": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "null" }], "title": "Id" }, "name": { "type": "string", "title": "Name" }, "pluralName": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Pluralname" }, "description": { "type": "string", "title": "Description", "default": "" }, "extras": { "anyOf": [{ "additionalProperties": true, "type": "object" }, { "type": "null" }], "title": "Extras", "default": {} }, "labelId": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "null" }], "title": "Labelid" }, "aliases": { "items": { "properties": { "name": { "type": "string", "title": "Name" } }, "type": "object", "required": ["name"], "title": "CreateIngredientFoodAlias" }, "type": "array", "title": "Aliases", "default": [] }, "householdsWithIngredientFood": { "items": { "type": "string" }, "type": "array", "title": "Householdswithingredientfood", "default": [] } }, "type": "object", "required": ["name"], "title": "CreateIngredientFood", "description": "The JSON request body." } }, "required": ["item_id", "requestBody"] },
    method: "put",
    pathTemplate: "/api/foods/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_one_api_foods__item_id__delete", {
    name: "delete_one_api_foods__item_id__delete",
    description: `Delete One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "delete",
    pathTemplate: "/api/foods/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_all_api_units_get", {
    name: "get_all_api_units_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "search": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Search" }, "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/units",
    executionParameters: [{ "name": "search", "in": "query" }, { "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_one_api_units_post", {
    name: "create_one_api_units_post",
    description: `Create One`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "id": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "null" }], "title": "Id" }, "name": { "type": "string", "title": "Name" }, "pluralName": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Pluralname" }, "description": { "type": "string", "title": "Description", "default": "" }, "extras": { "anyOf": [{ "additionalProperties": true, "type": "object" }, { "type": "null" }], "title": "Extras", "default": {} }, "fraction": { "type": "boolean", "title": "Fraction", "default": true }, "abbreviation": { "type": "string", "title": "Abbreviation", "default": "" }, "pluralAbbreviation": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Pluralabbreviation", "default": "" }, "useAbbreviation": { "type": "boolean", "title": "Useabbreviation", "default": false }, "aliases": { "items": { "properties": { "name": { "type": "string", "title": "Name" } }, "type": "object", "required": ["name"], "title": "CreateIngredientUnitAlias" }, "type": "array", "title": "Aliases", "default": [] } }, "type": "object", "required": ["name"], "title": "CreateIngredientUnit", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/units",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["merge_one_api_units_merge_put", {
    name: "merge_one_api_units_merge_put",
    description: `Merge One`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "fromUnit": { "type": "string", "format": "uuid4", "title": "Fromunit" }, "toUnit": { "type": "string", "format": "uuid4", "title": "Tounit" } }, "type": "object", "required": ["fromUnit", "toUnit"], "title": "MergeUnit", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "put",
    pathTemplate: "/api/units/merge",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_api_units__item_id__get", {
    name: "get_one_api_units__item_id__get",
    description: `Get One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "get",
    pathTemplate: "/api/units/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_one_api_units__item_id__put", {
    name: "update_one_api_units__item_id__put",
    description: `Update One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "id": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "null" }], "title": "Id" }, "name": { "type": "string", "title": "Name" }, "pluralName": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Pluralname" }, "description": { "type": "string", "title": "Description", "default": "" }, "extras": { "anyOf": [{ "additionalProperties": true, "type": "object" }, { "type": "null" }], "title": "Extras", "default": {} }, "fraction": { "type": "boolean", "title": "Fraction", "default": true }, "abbreviation": { "type": "string", "title": "Abbreviation", "default": "" }, "pluralAbbreviation": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Pluralabbreviation", "default": "" }, "useAbbreviation": { "type": "boolean", "title": "Useabbreviation", "default": false }, "aliases": { "items": { "properties": { "name": { "type": "string", "title": "Name" } }, "type": "object", "required": ["name"], "title": "CreateIngredientUnitAlias" }, "type": "array", "title": "Aliases", "default": [] } }, "type": "object", "required": ["name"], "title": "CreateIngredientUnit", "description": "The JSON request body." } }, "required": ["item_id", "requestBody"] },
    method: "put",
    pathTemplate: "/api/units/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_one_api_units__item_id__delete", {
    name: "delete_one_api_units__item_id__delete",
    description: `Delete One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "delete",
    pathTemplate: "/api/units/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_app_info_api_admin_about_get", {
    name: "get_app_info_api_admin_about_get",
    description: `Get general application information`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/admin/about",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_app_statistics_api_admin_about_statistics_get", {
    name: "get_app_statistics_api_admin_about_statistics_get",
    description: `Get App Statistics`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/admin/about/statistics",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["check_app_config_api_admin_about_check_get", {
    name: "check_app_config_api_admin_about_check_get",
    description: `Check App Config`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/admin/about/check",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_all_api_admin_users_get", {
    name: "get_all_api_admin_users_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/admin/users",
    executionParameters: [{ "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_one_api_admin_users_post", {
    name: "create_one_api_admin_users_post",
    description: `Create One`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "id": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "null" }], "title": "Id" }, "username": { "type": "string", "title": "Username" }, "fullName": { "type": "string", "title": "Fullname" }, "email": { "type": "string", "title": "Email" }, "authMethod": { "default": "Mealie", "type": "string", "enum": ["Mealie", "LDAP", "OIDC"], "title": "AuthMethod" }, "admin": { "type": "boolean", "title": "Admin", "default": false }, "group": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Group" }, "household": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Household" }, "advanced": { "type": "boolean", "title": "Advanced", "default": false }, "canInvite": { "type": "boolean", "title": "Caninvite", "default": false }, "canManage": { "type": "boolean", "title": "Canmanage", "default": false }, "canManageHousehold": { "type": "boolean", "title": "Canmanagehousehold", "default": false }, "canOrganize": { "type": "boolean", "title": "Canorganize", "default": false }, "password": { "type": "string", "title": "Password" } }, "type": "object", "required": ["username", "fullName", "email", "password"], "title": "UserIn", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/admin/users",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["unlock_users_api_admin_users_unlock_post", {
    name: "unlock_users_api_admin_users_unlock_post",
    description: `Unlock Users`,
    inputSchema: { "type": "object", "properties": { "force": { "type": "boolean", "default": false, "title": "Force" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "post",
    pathTemplate: "/api/admin/users/unlock",
    executionParameters: [{ "name": "force", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_api_admin_users__item_id__get", {
    name: "get_one_api_admin_users__item_id__get",
    description: `Get One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "get",
    pathTemplate: "/api/admin/users/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_one_api_admin_users__item_id__put", {
    name: "update_one_api_admin_users__item_id__put",
    description: `Update One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "id": { "type": "string", "format": "uuid4", "title": "Id" }, "username": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Username" }, "fullName": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Fullname" }, "email": { "type": "string", "title": "Email" }, "authMethod": { "default": "Mealie", "type": "string", "enum": ["Mealie", "LDAP", "OIDC"], "title": "AuthMethod" }, "admin": { "type": "boolean", "title": "Admin", "default": false }, "group": { "type": "string", "title": "Group" }, "household": { "type": "string", "title": "Household" }, "advanced": { "type": "boolean", "title": "Advanced", "default": false }, "canInvite": { "type": "boolean", "title": "Caninvite", "default": false }, "canManage": { "type": "boolean", "title": "Canmanage", "default": false }, "canManageHousehold": { "type": "boolean", "title": "Canmanagehousehold", "default": false }, "canOrganize": { "type": "boolean", "title": "Canorganize", "default": false }, "groupId": { "type": "string", "format": "uuid4", "title": "Groupid" }, "groupSlug": { "type": "string", "title": "Groupslug" }, "householdId": { "type": "string", "format": "uuid4", "title": "Householdid" }, "householdSlug": { "type": "string", "title": "Householdslug" }, "tokens": { "anyOf": [{ "items": { "properties": { "name": { "type": "string", "title": "Name" }, "id": { "type": "integer", "title": "Id" }, "createdAt": { "anyOf": [{ "type": "string", "format": "date-time" }, { "type": "null" }], "title": "Createdat" } }, "type": "object", "required": ["name", "id"], "title": "LongLiveTokenOut" }, "type": "array" }, { "type": "null" }], "title": "Tokens" }, "cacheKey": { "type": "string", "title": "Cachekey" } }, "type": "object", "required": ["id", "email", "group", "household", "groupId", "groupSlug", "householdId", "householdSlug", "cacheKey"], "title": "UserOut", "description": "The JSON request body." } }, "required": ["item_id", "requestBody"] },
    method: "put",
    pathTemplate: "/api/admin/users/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_one_api_admin_users__item_id__delete", {
    name: "delete_one_api_admin_users__item_id__delete",
    description: `Delete One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "delete",
    pathTemplate: "/api/admin/users/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["generate_token_api_admin_users_password_reset_token_post", {
    name: "generate_token_api_admin_users_password_reset_token_post",
    description: `Generates a reset token and returns it. This is an authenticated endpoint`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "email": { "type": "string", "title": "Email" } }, "type": "object", "required": ["email"], "title": "ForgotPassword", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/admin/users/password-reset-token",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_all_api_admin_households_get", {
    name: "get_all_api_admin_households_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/admin/households",
    executionParameters: [{ "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_one_api_admin_households_post", {
    name: "create_one_api_admin_households_post",
    description: `Create One`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "groupId": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "null" }], "title": "Groupid" }, "name": { "type": "string", "minLength": 1, "title": "Name" } }, "type": "object", "required": ["name"], "title": "HouseholdCreate", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/admin/households",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_api_admin_households__item_id__get", {
    name: "get_one_api_admin_households__item_id__get",
    description: `Get One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "get",
    pathTemplate: "/api/admin/households/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_one_api_admin_households__item_id__put", {
    name: "update_one_api_admin_households__item_id__put",
    description: `Update One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "groupId": { "type": "string", "format": "uuid4", "title": "Groupid" }, "name": { "type": "string", "minLength": 1, "title": "Name" }, "id": { "type": "string", "format": "uuid4", "title": "Id" }, "preferences": { "anyOf": [{ "properties": { "privateHousehold": { "type": "boolean", "title": "Privatehousehold", "default": true }, "lockRecipeEditsFromOtherHouseholds": { "type": "boolean", "title": "Lockrecipeeditsfromotherhouseholds", "default": true }, "firstDayOfWeek": { "type": "integer", "title": "Firstdayofweek", "default": 0 }, "recipePublic": { "type": "boolean", "title": "Recipepublic", "default": true }, "recipeShowNutrition": { "type": "boolean", "title": "Recipeshownutrition", "default": false }, "recipeShowAssets": { "type": "boolean", "title": "Recipeshowassets", "default": false }, "recipeLandscapeView": { "type": "boolean", "title": "Recipelandscapeview", "default": false }, "recipeDisableComments": { "type": "boolean", "title": "Recipedisablecomments", "default": false } }, "type": "object", "title": "UpdateHouseholdPreferences" }, { "type": "null" }] } }, "type": "object", "required": ["groupId", "name", "id"], "title": "UpdateHouseholdAdmin", "description": "The JSON request body." } }, "required": ["item_id", "requestBody"] },
    method: "put",
    pathTemplate: "/api/admin/households/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_one_api_admin_households__item_id__delete", {
    name: "delete_one_api_admin_households__item_id__delete",
    description: `Delete One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "delete",
    pathTemplate: "/api/admin/households/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_all_api_admin_groups_get", {
    name: "get_all_api_admin_groups_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/admin/groups",
    executionParameters: [{ "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_one_api_admin_groups_post", {
    name: "create_one_api_admin_groups_post",
    description: `Create One`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "name": { "type": "string", "minLength": 1, "title": "Name" } }, "type": "object", "required": ["name"], "title": "GroupBase", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/admin/groups",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_api_admin_groups__item_id__get", {
    name: "get_one_api_admin_groups__item_id__get",
    description: `Get One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "get",
    pathTemplate: "/api/admin/groups/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["update_one_api_admin_groups__item_id__put", {
    name: "update_one_api_admin_groups__item_id__put",
    description: `Update One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "id": { "type": "string", "format": "uuid4", "title": "Id" }, "name": { "type": "string", "title": "Name" }, "preferences": { "anyOf": [{ "properties": { "privateGroup": { "type": "boolean", "title": "Privategroup", "default": true } }, "type": "object", "title": "UpdateGroupPreferences" }, { "type": "null" }] } }, "type": "object", "required": ["id", "name"], "title": "GroupAdminUpdate", "description": "The JSON request body." } }, "required": ["item_id", "requestBody"] },
    method: "put",
    pathTemplate: "/api/admin/groups/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_one_api_admin_groups__item_id__delete", {
    name: "delete_one_api_admin_groups__item_id__delete",
    description: `Delete One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id"] },
    method: "delete",
    pathTemplate: "/api/admin/groups/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["check_email_config_api_admin_email_get", {
    name: "check_email_config_api_admin_email_get",
    description: `Get general application information`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/admin/email",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["send_test_email_api_admin_email_post", {
    name: "send_test_email_api_admin_email_post",
    description: `Send Test Email`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "properties": { "email": { "type": "string", "title": "Email" } }, "type": "object", "required": ["email"], "title": "EmailTest", "description": "The JSON request body." } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/admin/email",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "application/json",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_all_api_admin_backups_get", {
    name: "get_all_api_admin_backups_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/admin/backups",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["create_one_api_admin_backups_post", {
    name: "create_one_api_admin_backups_post",
    description: `Create One`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "post",
    pathTemplate: "/api/admin/backups",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_one_api_admin_backups__file_name__get", {
    name: "get_one_api_admin_backups__file_name__get",
    description: `Returns a token to download a file`,
    inputSchema: { "type": "object", "properties": { "file_name": { "type": "string", "title": "File Name" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["file_name"] },
    method: "get",
    pathTemplate: "/api/admin/backups/{file_name}",
    executionParameters: [{ "name": "file_name", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["delete_one_api_admin_backups__file_name__delete", {
    name: "delete_one_api_admin_backups__file_name__delete",
    description: `Delete One`,
    inputSchema: { "type": "object", "properties": { "file_name": { "type": "string", "title": "File Name" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["file_name"] },
    method: "delete",
    pathTemplate: "/api/admin/backups/{file_name}",
    executionParameters: [{ "name": "file_name", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["upload_one_api_admin_backups_upload_post", {
    name: "upload_one_api_admin_backups_upload_post",
    description: `Upload a .zip File to later be imported into Mealie`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "type": "string", "description": "Request body (content type: multipart/form-data)" } }, "required": ["requestBody"] },
    method: "post",
    pathTemplate: "/api/admin/backups/upload",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "multipart/form-data",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["import_one_api_admin_backups__file_name__restore_post", {
    name: "import_one_api_admin_backups__file_name__restore_post",
    description: `Import One`,
    inputSchema: { "type": "object", "properties": { "file_name": { "type": "string", "title": "File Name" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["file_name"] },
    method: "post",
    pathTemplate: "/api/admin/backups/{file_name}/restore",
    executionParameters: [{ "name": "file_name", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_maintenance_summary_api_admin_maintenance_get", {
    name: "get_maintenance_summary_api_admin_maintenance_get",
    description: `Get the maintenance summary`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/admin/maintenance",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_storage_details_api_admin_maintenance_storage_get", {
    name: "get_storage_details_api_admin_maintenance_storage_get",
    description: `Get Storage Details`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "get",
    pathTemplate: "/api/admin/maintenance/storage",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["clean_images_api_admin_maintenance_clean_images_post", {
    name: "clean_images_api_admin_maintenance_clean_images_post",
    description: `Purges all the images from the filesystem that aren't .webp`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "post",
    pathTemplate: "/api/admin/maintenance/clean/images",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["clean_temp_api_admin_maintenance_clean_temp_post", {
    name: "clean_temp_api_admin_maintenance_clean_temp_post",
    description: `Clean Temp`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "post",
    pathTemplate: "/api/admin/maintenance/clean/temp",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["clean_recipe_folders_api_admin_maintenance_clean_recipe_folders_post", {
    name: "clean_recipe_folders_api_admin_maintenance_clean_recipe_folders_post",
    description: `Deletes all the recipe folders that don't have names that are valid UUIDs`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } } },
    method: "post",
    pathTemplate: "/api/admin/maintenance/clean/recipe-folders",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["debug_openai_api_admin_debug_openai_post", {
    name: "debug_openai_api_admin_debug_openai_post",
    description: `Debug Openai`,
    inputSchema: { "type": "object", "properties": { "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" }, "requestBody": { "type": "string", "description": "Request body (content type: multipart/form-data)" } } },
    method: "post",
    pathTemplate: "/api/admin/debug/openai",
    executionParameters: [{ "name": "accept-language", "in": "header" }],
    requestBodyContentType: "multipart/form-data",
    securityRequirements: [{ "OAuth2PasswordBearer": [] }]
  }],
  ["get_all_api_explore_groups__group_slug__foods_get", {
    name: "get_all_api_explore_groups__group_slug__foods_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "group_slug": { "type": "string", "title": "Group Slug" }, "search": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Search" }, "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["group_slug"] },
    method: "get",
    pathTemplate: "/api/explore/groups/{group_slug}/foods",
    executionParameters: [{ "name": "group_slug", "in": "path" }, { "name": "search", "in": "query" }, { "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["get_one_api_explore_groups__group_slug__foods__item_id__get", {
    name: "get_one_api_explore_groups__group_slug__foods__item_id__get",
    description: `Get One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "group_slug": { "type": "string", "title": "Group Slug" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id", "group_slug"] },
    method: "get",
    pathTemplate: "/api/explore/groups/{group_slug}/foods/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "group_slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["get_all_api_explore_groups__group_slug__households_get", {
    name: "get_all_api_explore_groups__group_slug__households_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "group_slug": { "type": "string", "title": "Group Slug" }, "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["group_slug"] },
    method: "get",
    pathTemplate: "/api/explore/groups/{group_slug}/households",
    executionParameters: [{ "name": "group_slug", "in": "path" }, { "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["get_household_api_explore_groups__group_slug__households__household_slug__get", {
    name: "get_household_api_explore_groups__group_slug__households__household_slug__get",
    description: `Get Household`,
    inputSchema: { "type": "object", "properties": { "household_slug": { "type": "string", "title": "Household Slug" }, "group_slug": { "type": "string", "title": "Group Slug" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["household_slug", "group_slug"] },
    method: "get",
    pathTemplate: "/api/explore/groups/{group_slug}/households/{household_slug}",
    executionParameters: [{ "name": "household_slug", "in": "path" }, { "name": "group_slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["get_all_api_explore_groups__group_slug__organizers_categories_get", {
    name: "get_all_api_explore_groups__group_slug__organizers_categories_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "group_slug": { "type": "string", "title": "Group Slug" }, "search": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Search" }, "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["group_slug"] },
    method: "get",
    pathTemplate: "/api/explore/groups/{group_slug}/organizers/categories",
    executionParameters: [{ "name": "group_slug", "in": "path" }, { "name": "search", "in": "query" }, { "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["get_one_api_explore_groups__group_slug__organizers_categories__item_id__get", {
    name: "get_one_api_explore_groups__group_slug__organizers_categories__item_id__get",
    description: `Get One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "group_slug": { "type": "string", "title": "Group Slug" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id", "group_slug"] },
    method: "get",
    pathTemplate: "/api/explore/groups/{group_slug}/organizers/categories/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "group_slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["get_all_api_explore_groups__group_slug__organizers_tags_get", {
    name: "get_all_api_explore_groups__group_slug__organizers_tags_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "group_slug": { "type": "string", "title": "Group Slug" }, "search": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Search" }, "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["group_slug"] },
    method: "get",
    pathTemplate: "/api/explore/groups/{group_slug}/organizers/tags",
    executionParameters: [{ "name": "group_slug", "in": "path" }, { "name": "search", "in": "query" }, { "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["get_one_api_explore_groups__group_slug__organizers_tags__item_id__get", {
    name: "get_one_api_explore_groups__group_slug__organizers_tags__item_id__get",
    description: `Get One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "group_slug": { "type": "string", "title": "Group Slug" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id", "group_slug"] },
    method: "get",
    pathTemplate: "/api/explore/groups/{group_slug}/organizers/tags/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "group_slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["get_all_api_explore_groups__group_slug__organizers_tools_get", {
    name: "get_all_api_explore_groups__group_slug__organizers_tools_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "group_slug": { "type": "string", "title": "Group Slug" }, "search": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Search" }, "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["group_slug"] },
    method: "get",
    pathTemplate: "/api/explore/groups/{group_slug}/organizers/tools",
    executionParameters: [{ "name": "group_slug", "in": "path" }, { "name": "search", "in": "query" }, { "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["get_one_api_explore_groups__group_slug__organizers_tools__item_id__get", {
    name: "get_one_api_explore_groups__group_slug__organizers_tools__item_id__get",
    description: `Get One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "type": "string", "format": "uuid4", "title": "Item Id" }, "group_slug": { "type": "string", "title": "Group Slug" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id", "group_slug"] },
    method: "get",
    pathTemplate: "/api/explore/groups/{group_slug}/organizers/tools/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "group_slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["get_all_api_explore_groups__group_slug__cookbooks_get", {
    name: "get_all_api_explore_groups__group_slug__cookbooks_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "group_slug": { "type": "string", "title": "Group Slug" }, "search": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Search" }, "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["group_slug"] },
    method: "get",
    pathTemplate: "/api/explore/groups/{group_slug}/cookbooks",
    executionParameters: [{ "name": "group_slug", "in": "path" }, { "name": "search", "in": "query" }, { "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["get_one_api_explore_groups__group_slug__cookbooks__item_id__get", {
    name: "get_one_api_explore_groups__group_slug__cookbooks__item_id__get",
    description: `Get One`,
    inputSchema: { "type": "object", "properties": { "item_id": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "string" }], "title": "Item Id" }, "group_slug": { "type": "string", "title": "Group Slug" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["item_id", "group_slug"] },
    method: "get",
    pathTemplate: "/api/explore/groups/{group_slug}/cookbooks/{item_id}",
    executionParameters: [{ "name": "item_id", "in": "path" }, { "name": "group_slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["get_all_api_explore_groups__group_slug__recipes_get", {
    name: "get_all_api_explore_groups__group_slug__recipes_get",
    description: `Get All`,
    inputSchema: { "type": "object", "properties": { "group_slug": { "type": "string", "title": "Group Slug" }, "categories": { "anyOf": [{ "type": "array", "items": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "string" }] } }, { "type": "null" }], "title": "Categories" }, "tags": { "anyOf": [{ "type": "array", "items": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "string" }] } }, { "type": "null" }], "title": "Tags" }, "tools": { "anyOf": [{ "type": "array", "items": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "string" }] } }, { "type": "null" }], "title": "Tools" }, "foods": { "anyOf": [{ "type": "array", "items": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "string" }] } }, { "type": "null" }], "title": "Foods" }, "households": { "anyOf": [{ "type": "array", "items": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "string" }] } }, { "type": "null" }], "title": "Households" }, "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "page": { "type": "number", "default": 1, "title": "Page" }, "perPage": { "type": "number", "default": 50, "title": "Perpage" }, "cookbook": { "anyOf": [{ "type": "string", "format": "uuid4" }, { "type": "string" }, { "type": "null" }], "title": "Cookbook" }, "requireAllCategories": { "type": "boolean", "default": false, "title": "Requireallcategories" }, "requireAllTags": { "type": "boolean", "default": false, "title": "Requirealltags" }, "requireAllTools": { "type": "boolean", "default": false, "title": "Requirealltools" }, "requireAllFoods": { "type": "boolean", "default": false, "title": "Requireallfoods" }, "search": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Search" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["group_slug"] },
    method: "get",
    pathTemplate: "/api/explore/groups/{group_slug}/recipes",
    executionParameters: [{ "name": "group_slug", "in": "path" }, { "name": "categories", "in": "query" }, { "name": "tags", "in": "query" }, { "name": "tools", "in": "query" }, { "name": "foods", "in": "query" }, { "name": "households", "in": "query" }, { "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "page", "in": "query" }, { "name": "perPage", "in": "query" }, { "name": "cookbook", "in": "query" }, { "name": "requireAllCategories", "in": "query" }, { "name": "requireAllTags", "in": "query" }, { "name": "requireAllTools", "in": "query" }, { "name": "requireAllFoods", "in": "query" }, { "name": "search", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["suggest_recipes_api_explore_groups__group_slug__recipes_suggestions_get", {
    name: "suggest_recipes_api_explore_groups__group_slug__recipes_suggestions_get",
    description: `Suggest Recipes`,
    inputSchema: { "type": "object", "properties": { "group_slug": { "type": "string", "title": "Group Slug" }, "foods": { "anyOf": [{ "type": "array", "items": { "type": "string", "format": "uuid4" } }, { "type": "null" }], "title": "Foods" }, "tools": { "anyOf": [{ "type": "array", "items": { "type": "string", "format": "uuid4" } }, { "type": "null" }], "title": "Tools" }, "orderBy": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Orderby" }, "orderByNullPosition": { "anyOf": [{ "type": "string", "enum": ["first", "last"], "title": "OrderByNullPosition" }, { "type": "null" }], "title": "Orderbynullposition" }, "orderDirection": { "default": "desc", "type": "string", "enum": ["asc", "desc"], "title": "OrderDirection" }, "queryFilter": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Queryfilter" }, "paginationSeed": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Paginationseed" }, "limit": { "type": "number", "default": 10, "title": "Limit" }, "maxMissingFoods": { "type": "number", "default": 5, "title": "Maxmissingfoods" }, "maxMissingTools": { "type": "number", "default": 5, "title": "Maxmissingtools" }, "includeFoodsOnHand": { "type": "boolean", "default": true, "title": "Includefoodsonhand" }, "includeToolsOnHand": { "type": "boolean", "default": true, "title": "Includetoolsonhand" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["group_slug"] },
    method: "get",
    pathTemplate: "/api/explore/groups/{group_slug}/recipes/suggestions",
    executionParameters: [{ "name": "group_slug", "in": "path" }, { "name": "foods", "in": "query" }, { "name": "tools", "in": "query" }, { "name": "orderBy", "in": "query" }, { "name": "orderByNullPosition", "in": "query" }, { "name": "orderDirection", "in": "query" }, { "name": "queryFilter", "in": "query" }, { "name": "paginationSeed", "in": "query" }, { "name": "limit", "in": "query" }, { "name": "maxMissingFoods", "in": "query" }, { "name": "maxMissingTools", "in": "query" }, { "name": "includeFoodsOnHand", "in": "query" }, { "name": "includeToolsOnHand", "in": "query" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["get_recipe_api_explore_groups__group_slug__recipes__recipe_slug__get", {
    name: "get_recipe_api_explore_groups__group_slug__recipes__recipe_slug__get",
    description: `Get Recipe`,
    inputSchema: { "type": "object", "properties": { "recipe_slug": { "type": "string", "title": "Recipe Slug" }, "group_slug": { "type": "string", "title": "Group Slug" }, "accept-language": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Accept-Language" } }, "required": ["recipe_slug", "group_slug"] },
    method: "get",
    pathTemplate: "/api/explore/groups/{group_slug}/recipes/{recipe_slug}",
    executionParameters: [{ "name": "recipe_slug", "in": "path" }, { "name": "group_slug", "in": "path" }, { "name": "accept-language", "in": "header" }],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["get_recipe_img_api_media_recipes__recipe_id__images__file_name__get", {
    name: "get_recipe_img_api_media_recipes__recipe_id__images__file_name__get",
    description: `Takes in a recipe id, returns the static image. This route is proxied in the docker image
and should not hit the API in production`,
    inputSchema: { "type": "object", "properties": { "recipe_id": { "type": "string", "title": "Recipe Id" }, "file_name": { "type": "string", "enum": ["original.webp", "min-original.webp", "tiny-original.webp"], "title": "ImageType" } }, "required": ["recipe_id", "file_name"] },
    method: "get",
    pathTemplate: "/api/media/recipes/{recipe_id}/images/{file_name}",
    executionParameters: [{ "name": "recipe_id", "in": "path" }, { "name": "file_name", "in": "path" }],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["get_recipe_timeline_event_img_api_media_recipes__recipe_id__images_timeline__timeline_event_id___file_name__get", {
    name: "get_recipe_timeline_event_img_api_media_recipes__recipe_id__images_timeline__timeline_event_id___file_name__get",
    description: `Takes in a recipe id and event timeline id, returns the static image. This route is proxied in the docker image
and should not hit the API in production`,
    inputSchema: { "type": "object", "properties": { "recipe_id": { "type": "string", "title": "Recipe Id" }, "timeline_event_id": { "type": "string", "title": "Timeline Event Id" }, "file_name": { "type": "string", "enum": ["original.webp", "min-original.webp", "tiny-original.webp"], "title": "ImageType" } }, "required": ["recipe_id", "timeline_event_id", "file_name"] },
    method: "get",
    pathTemplate: "/api/media/recipes/{recipe_id}/images/timeline/{timeline_event_id}/{file_name}",
    executionParameters: [{ "name": "recipe_id", "in": "path" }, { "name": "timeline_event_id", "in": "path" }, { "name": "file_name", "in": "path" }],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["get_recipe_asset_api_media_recipes__recipe_id__assets__file_name__get", {
    name: "get_recipe_asset_api_media_recipes__recipe_id__assets__file_name__get",
    description: `Returns a recipe asset`,
    inputSchema: { "type": "object", "properties": { "recipe_id": { "type": "string", "format": "uuid4", "title": "Recipe Id" }, "file_name": { "type": "string", "title": "File Name" } }, "required": ["recipe_id", "file_name"] },
    method: "get",
    pathTemplate: "/api/media/recipes/{recipe_id}/assets/{file_name}",
    executionParameters: [{ "name": "recipe_id", "in": "path" }, { "name": "file_name", "in": "path" }],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["get_user_image_api_media_users__user_id___file_name__get", {
    name: "get_user_image_api_media_users__user_id___file_name__get",
    description: `Takes in a recipe slug, returns the static image. This route is proxied in the docker image
and should not hit the API in production`,
    inputSchema: { "type": "object", "properties": { "user_id": { "type": "string", "format": "uuid4", "title": "User Id" }, "file_name": { "type": "string", "title": "File Name" } }, "required": ["user_id", "file_name"] },
    method: "get",
    pathTemplate: "/api/media/users/{user_id}/{file_name}",
    executionParameters: [{ "name": "user_id", "in": "path" }, { "name": "file_name", "in": "path" }],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["get_validation_text_api_media_docker_validate_txt_get", {
    name: "get_validation_text_api_media_docker_validate_txt_get",
    description: `Get Validation Text`,
    inputSchema: { "type": "object", "properties": {} },
    method: "get",
    pathTemplate: "/api/media/docker/validate.txt",
    executionParameters: [],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
  ["download_file_api_utils_download_get", {
    name: "download_file_api_utils_download_get",
    description: `Uses a file token obtained by an active user to retrieve a file from the operating
system.`,
    inputSchema: { "type": "object", "properties": { "token": { "anyOf": [{ "type": "string" }, { "type": "null" }], "title": "Token" } } },
    method: "get",
    pathTemplate: "/api/utils/download",
    executionParameters: [{ "name": "token", "in": "query" }],
    requestBodyContentType: undefined,
    securityRequirements: []
  }],
]);

/** Lazy-built map: short_id -> operationKey (built from toolDefinitionMap) */
let shortIdToOperationKey: Map<string, string> | null = null;
function getShortIdMap(): Map<string, string> {
  if (shortIdToOperationKey === null) shortIdToOperationKey = buildShortIdToOperationKey();
  return shortIdToOperationKey;
}

/** Path prefixes that must never appear in the registry (app/admin/auth excluded for agents). */
const REGISTRY_EXCLUDED_PATH_PREFIXES = ['/api/app/', '/api/admin/', '/api/auth/'];

/**
 * Group operations by first path segment and return markdown registry.
 * Optional query filters by substring match on short_id or description.
 * App/admin and other excluded paths are never listed (safeguard on top of allowlist).
 */
function buildRegistryMarkdown(query?: string): string {
  const map = getShortIdMap();
  const byGroup = new Map<string, Array<{ shortId: string; description: string }>>();
  for (const [shortId, opKey] of map.entries()) {
    const def = toolDefinitionMap.get(opKey);
    if (!def) continue;
    if (REGISTRY_EXCLUDED_PATH_PREFIXES.some(prefix => def.pathTemplate.startsWith(prefix))) continue;
    const desc = (def.description || '').replace(/\n/g, ' ').trim();
    if (query) {
      const q = query.toLowerCase();
      if (!shortId.toLowerCase().includes(q) && !desc.toLowerCase().includes(q)) continue;
    }
    const segment = def.pathTemplate.replace(/^\/api\/?/, '').split('/').filter(Boolean)[0] || 'api';
    const group = segment.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group)!.push({ shortId, description: desc });
  }
  const lines: string[] = ['# Mealie API operations (use short_id with mealie_call)', ''];
  const sortedGroups = [...byGroup.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [group, entries] of sortedGroups) {
    lines.push(`## ${group}`);
    for (const { shortId, description } of entries.sort((a, b) => a.shortId.localeCompare(b.shortId)))
      lines.push(`- **${shortId}** — ${description}`);
    lines.push('');
  }
  lines.push('---', 'Call with: `mealie_call` and params `tool_id` (short_id above) and `params` (object).');
  return lines.join('\n');
}

/**
 * Security schemes from the OpenAPI spec
 */
const securitySchemes = {
  "OAuth2PasswordBearer": {
    "type": "oauth2",
    "flows": {
      "password": {
        "scopes": {},
        "tokenUrl": "/api/auth/token"
      }
    }
  }
};


/**
 * Type definition for cached OAuth tokens
 */
interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

/**
 * Declare global __oauthTokenCache property for TypeScript
 */
declare global {
  var __oauthTokenCache: Record<string, TokenCacheEntry> | undefined;
}

/**
 * Acquires an OAuth2 token using client credentials flow
 * 
 * @param schemeName Name of the security scheme
 * @param scheme OAuth2 security scheme
 * @returns Acquired token or null if unable to acquire
 */
async function acquireOAuth2Token(schemeName: string, scheme: any): Promise<string | null | undefined> {
  try {
    // Check if we have the necessary credentials
    const clientId = process.env[`OAUTH_CLIENT_ID_SCHEMENAME`];
    const clientSecret = process.env[`OAUTH_CLIENT_SECRET_SCHEMENAME`];
    const scopes = process.env[`OAUTH_SCOPES_SCHEMENAME`];

    if (!clientId || !clientSecret) {
      console.error(`Missing client credentials for OAuth2 scheme '${schemeName}'`);
      return null;
    }

    // Initialize token cache if needed
    if (typeof global.__oauthTokenCache === 'undefined') {
      global.__oauthTokenCache = {};
    }

    // Check if we have a cached token
    const cacheKey = `${schemeName}_${clientId}`;
    const cachedToken = global.__oauthTokenCache[cacheKey];
    const now = Date.now();

    if (cachedToken && cachedToken.expiresAt > now) {
      console.error(`Using cached OAuth2 token for '${schemeName}' (expires in ${Math.floor((cachedToken.expiresAt - now) / 1000)} seconds)`);
      return cachedToken.token;
    }

    // Determine token URL based on flow type
    let tokenUrl = '';
    if (scheme.flows?.clientCredentials?.tokenUrl) {
      tokenUrl = scheme.flows.clientCredentials.tokenUrl;
      console.error(`Using client credentials flow for '${schemeName}'`);
    } else if (scheme.flows?.password?.tokenUrl) {
      tokenUrl = scheme.flows.password.tokenUrl;
      console.error(`Using password flow for '${schemeName}'`);
    } else {
      console.error(`No supported OAuth2 flow found for '${schemeName}'`);
      return null;
    }

    // Prepare the token request
    let formData = new URLSearchParams();
    formData.append('grant_type', 'client_credentials');

    // Add scopes if specified
    if (scopes) {
      formData.append('scope', scopes);
    }

    console.error(`Requesting OAuth2 token from ${tokenUrl}`);

    // Make the token request
    const response = await axios({
      method: 'POST',
      url: tokenUrl,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
      },
      data: formData.toString()
    });

    // Process the response
    if (response.data?.access_token) {
      const token = response.data.access_token;
      const expiresIn = response.data.expires_in || 3600; // Default to 1 hour

      // Cache the token
      global.__oauthTokenCache[cacheKey] = {
        token,
        expiresAt: now + (expiresIn * 1000) - 60000 // Expire 1 minute early
      };

      console.error(`Successfully acquired OAuth2 token for '${schemeName}' (expires in ${expiresIn} seconds)`);
      return token;
    } else {
      console.error(`Failed to acquire OAuth2 token for '${schemeName}': No access_token in response`);
      return null;
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error acquiring OAuth2 token for '${schemeName}':`, errorMessage);
    return null;
  }
}


/**
 * Executes an API tool with the provided arguments
 *
 * @param overrideToken Optional Mealie API token for this call (tool param or from X-Mealie-Token header). Used in multi-user setups.
 */
async function executeApiTool(
  toolName: string,
  definition: McpToolDefinition,
  toolArgs: JsonObject,
  allSecuritySchemes: Record<string, any>,
  overrideToken?: string
): Promise<CallToolResult> {
  const effectiveToken = overrideToken ?? getMealieToken();

  try {
    // Validate arguments against the input schema
    let validatedArgs: JsonObject;
    try {
      const zodSchema = getZodSchemaFromJsonSchema(definition.inputSchema, toolName);
      const argsToParse = (typeof toolArgs === 'object' && toolArgs !== null) ? toolArgs : {};
      validatedArgs = zodSchema.parse(argsToParse);
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        const validationErrorMessage = `Invalid arguments for tool '${toolName}': ${error.errors.map(e => `${e.path.join('.')} (${e.code}): ${e.message}`).join(', ')}`;
        return { content: [{ type: 'text', text: validationErrorMessage }] };
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Internal error during validation setup: ${errorMessage}` }] };
      }
    }

    // Prepare URL, query parameters, headers, and request body
    let urlPath = definition.pathTemplate;
    const queryParams: Record<string, any> = {};
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    let requestBodyData: any = undefined;

    // Apply parameters to the URL path, query, or headers
    definition.executionParameters.forEach((param) => {
      const value = validatedArgs[param.name];
      if (typeof value !== 'undefined' && value !== null) {
        if (param.in === 'path') {
          urlPath = urlPath.replace(`{${param.name}}`, encodeURIComponent(String(value)));
        }
        else if (param.in === 'query') {
          queryParams[param.name] = value;
        }
        else if (param.in === 'header') {
          headers[param.name.toLowerCase()] = String(value);
        }
      }
    });

    // Ensure all path parameters are resolved
    if (urlPath.includes('{')) {
      throw new Error(`Failed to resolve path parameters: ${urlPath}`);
    }

    // Construct the full URL
    const requestUrl = API_BASE_URL ? `${API_BASE_URL}${urlPath}` : urlPath;

    // Handle request body if needed
    if (definition.requestBodyContentType && typeof validatedArgs['requestBody'] !== 'undefined') {
      requestBodyData = validatedArgs['requestBody'];
      headers['content-type'] = definition.requestBodyContentType;
    }


    // Apply security requirements if available
    // Security requirements use OR between array items and AND within each object
    const appliedSecurity = definition.securityRequirements?.find(req => {
      // Try each security requirement (combined with OR)
      return Object.entries(req).every(([schemeName, scopesArray]) => {
        const scheme = allSecuritySchemes[schemeName];
        if (!scheme) return false;

        // API Key security (header, query, cookie)
        if (scheme.type === 'apiKey') {
          return !!process.env[`API_KEY_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
        }

        // HTTP security (basic, bearer)
        if (scheme.type === 'http') {
          if (scheme.scheme?.toLowerCase() === 'bearer') {
            return !!process.env[`BEARER_TOKEN_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
          }
          else if (scheme.scheme?.toLowerCase() === 'basic') {
            return !!process.env[`BASIC_USERNAME_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`] &&
              !!process.env[`BASIC_PASSWORD_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
          }
        }

        // OAuth2 security
        if (scheme.type === 'oauth2') {
          const envKey = schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
          // Per-request/session token (multi-user) or env
          if (effectiveToken || process.env[`BEARER_TOKEN_${envKey}`] || process.env[`OAUTH_TOKEN_${envKey}`]) {
            return true;
          }

          // Check for client credentials for auto-acquisition
          if (process.env[`OAUTH_CLIENT_ID_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`] &&
            process.env[`OAUTH_CLIENT_SECRET_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`]) {
            // Verify we have a supported flow
            if (scheme.flows?.clientCredentials || scheme.flows?.password) {
              return true;
            }
          }

          return false;
        }

        // OpenID Connect
        if (scheme.type === 'openIdConnect') {
          return !!process.env[`OPENID_TOKEN_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
        }

        return false;
      });
    });

    // If we found matching security scheme(s), apply them
    if (appliedSecurity) {
      // Apply each security scheme from this requirement (combined with AND)
      for (const [schemeName, scopesArray] of Object.entries(appliedSecurity)) {
        const scheme = allSecuritySchemes[schemeName];

        // API Key security
        if (scheme?.type === 'apiKey') {
          const apiKey = process.env[`API_KEY_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
          if (apiKey) {
            if (scheme.in === 'header') {
              headers[scheme.name.toLowerCase()] = apiKey;
              console.error(`Applied API key '${schemeName}' in header '${scheme.name}'`);
            }
            else if (scheme.in === 'query') {
              queryParams[scheme.name] = apiKey;
              console.error(`Applied API key '${schemeName}' in query parameter '${scheme.name}'`);
            }
            else if (scheme.in === 'cookie') {
              // Add the cookie, preserving other cookies if they exist
              headers['cookie'] = `${scheme.name}=${apiKey}${headers['cookie'] ? `; ${headers['cookie']}` : ''}`;
              console.error(`Applied API key '${schemeName}' in cookie '${scheme.name}'`);
            }
          }
        }
        // HTTP security (Bearer or Basic)
        else if (scheme?.type === 'http') {
          if (scheme.scheme?.toLowerCase() === 'bearer') {
            const token = process.env[`BEARER_TOKEN_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
            if (token) {
              headers['authorization'] = `Bearer ${token}`;
              console.error(`Applied Bearer token for '${schemeName}'`);
            }
          }
          else if (scheme.scheme?.toLowerCase() === 'basic') {
            const username = process.env[`BASIC_USERNAME_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
            const password = process.env[`BASIC_PASSWORD_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
            if (username && password) {
              headers['authorization'] = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
              console.error(`Applied Basic authentication for '${schemeName}'`);
            }
          }
        }
        // OAuth2 security
        else if (scheme?.type === 'oauth2') {
          const envKey = schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
          // Priority: per-request token (multi-user) > env
          let token = effectiveToken || process.env[`BEARER_TOKEN_${envKey}`] || process.env[`OAUTH_TOKEN_${envKey}`];

          // If no token but we have client credentials, try to acquire a token
          if (!token && (scheme.flows?.clientCredentials || scheme.flows?.password)) {
            console.error(`Attempting to acquire OAuth token for '${schemeName}'`);
            token = (await acquireOAuth2Token(schemeName, scheme)) ?? '';
          }

          // Apply token if available
          if (token) {
            headers['authorization'] = `Bearer ${token}`;
            console.error(`Applied OAuth2 token for '${schemeName}'`);

            // List the scopes that were requested, if any
            const scopes = scopesArray as string[];
            if (scopes && scopes.length > 0) {
              console.error(`Requested scopes: ${scopes.join(', ')}`);
            }
          }
        }
        // OpenID Connect
        else if (scheme?.type === 'openIdConnect') {
          const token = process.env[`OPENID_TOKEN_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
          if (token) {
            headers['authorization'] = `Bearer ${token}`;
            console.error(`Applied OpenID Connect token for '${schemeName}'`);

            // List the scopes that were requested, if any
            const scopes = scopesArray as string[];
            if (scopes && scopes.length > 0) {
              console.error(`Requested scopes: ${scopes.join(', ')}`);
            }
          }
        }
      }
    }
    // Log warning if security is required but not available
    else if (definition.securityRequirements?.length > 0) {
      // First generate a more readable representation of the security requirements
      const securityRequirementsString = definition.securityRequirements
        .map(req => {
          const parts = Object.entries(req)
            .map(([name, scopesArray]) => {
              const scopes = scopesArray as string[];
              if (scopes.length === 0) return name;
              return `${name} (scopes: ${scopes.join(', ')})`;
            })
            .join(' AND ');
          return `[${parts}]`;
        })
        .join(' OR ');

      console.warn(`Tool '${toolName}' requires security: ${securityRequirementsString}, but no suitable credentials found.`);
    }


    // Prepare the axios request configuration
    const config: AxiosRequestConfig = {
      method: definition.method.toUpperCase(),
      url: requestUrl,
      params: queryParams,
      headers: headers,
      ...(requestBodyData !== undefined && { data: requestBodyData }),
    };

    // Log request info to stderr (doesn't affect MCP output)
    console.error(`Executing tool "${toolName}": ${config.method} ${config.url}`);

    // Execute the request
    const response = await axios(config);

    // Process and format the response
    let responseText = '';
    const contentType = response.headers['content-type']?.toLowerCase() || '';

    // Handle JSON responses
    if (contentType.includes('application/json') && typeof response.data === 'object' && response.data !== null) {
      try {
        responseText = JSON.stringify(response.data, null, 2);
      } catch (e) {
        responseText = "[Stringify Error]";
      }
    }
    // Handle string responses
    else if (typeof response.data === 'string') {
      responseText = response.data;
    }
    // Handle other response types
    else if (response.data !== undefined && response.data !== null) {
      responseText = String(response.data);
    }
    // Handle empty responses
    else {
      responseText = `(Status: ${response.status} - No body content)`;
    }

    // Return formatted response
    return {
      content: [
        {
          type: "text",
          text: `API Response (Status: ${response.status}):\n${responseText}`
        }
      ],
    };

  } catch (error: unknown) {
    // Handle errors during execution
    let errorMessage: string;

    // Format Axios errors specially
    if (axios.isAxiosError(error)) {
      errorMessage = formatApiError(error);
    }
    // Handle standard errors
    else if (error instanceof Error) {
      errorMessage = error.message;
    }
    // Handle unexpected error types
    else {
      errorMessage = 'Unexpected error: ' + String(error);
    }

    // Log error to stderr
    console.error(`Error during execution of tool '${toolName}':`, errorMessage);

    // Return error message to client
    return { content: [{ type: "text", text: errorMessage }] };
  }
}


/**
 * Main function to start the server
 */
async function main() {
  // Set up StreamableHTTP transport
  try {
    await setupStreamableHttpServer(createMcpServer, parseInt(process.env.PORT ?? "3031", 10));
  } catch (error) {
    console.error("Error setting up StreamableHTTP server:", error);
    process.exit(1);
  }
}

/**
 * Cleanup function for graceful shutdown
 */
async function cleanup() {
  console.error("Shutting down MCP server...");
  process.exit(0);
}

// Register signal handlers
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// CLI: generate TOOL_RANKING.md and exit (no server)
if (process.argv.includes('--dump-ranking')) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const rows = getToolRankingList();
  const byRelevance = { high: rows.filter(r => r.relevance === 'high'), medium: rows.filter(r => r.relevance === 'medium'), low: rows.filter(r => r.relevance === 'low'), exclude: rows.filter(r => r.relevance === 'exclude') };
  const allowed = rows.filter(r => r.relevance !== 'exclude');
  const out = [
    '# Mealie MCP — Tool ranking for AI agents',
    '',
    'Tools are ranked by relevance. Only **high**, **medium**, and **low** are exposed to the agent; **exclude** tools are not in the registry and cannot be called.',
    '',
    '## Summary',
    '',
    '| Relevance | Count | Exposed |',
    '|-----------|-------|---------|',
    `| high      | ${byRelevance.high.length}  | yes     |`,
    `| medium    | ${byRelevance.medium.length}  | yes     |`,
    `| low       | ${byRelevance.low.length}   | yes     |`,
    `| exclude   | ${byRelevance.exclude.length}  | no      |`,
    `| **Total** | **${rows.length}** | **${allowed.length}** |`,
    '',
    '## Excluded (not exposed)',
    '',
    'These operations do not make logical sense for an AI agent: auth flows, admin, binary uploads, webhooks, migrations, etc.',
    '',
    '| short_id | method | path | description |',
    '|----------|--------|------|-------------|',
    ...byRelevance.exclude.map(r => `| ${r.shortId} | ${r.method} | ${r.pathTemplate} | ${r.description.slice(0, 50)}... |`),
    '',
    '## High relevance (core agent use)',
    '',
    '| short_id | method | path | description |',
    '|----------|--------|------|-------------|',
    ...byRelevance.high.map(r => `| ${r.shortId} | ${r.method} | ${r.pathTemplate} | ${r.description.slice(0, 50)} |`),
    '',
    '## Medium relevance',
    '',
    '| short_id | method | path | description |',
    '|----------|--------|------|-------------|',
    ...byRelevance.medium.map(r => `| ${r.shortId} | ${r.method} | ${r.pathTemplate} | ${r.description.slice(0, 50)} |`),
    '',
    '## Low relevance',
    '',
    '| short_id | method | path | description |',
    '|----------|--------|------|-------------|',
    ...byRelevance.low.map(r => `| ${r.shortId} | ${r.method} | ${r.pathTemplate} | ${r.description.slice(0, 50)} |`),
    ''
  ].join('\n');
  const outPath = path.join(process.cwd(), 'TOOL_RANKING.md');
  fs.writeFileSync(outPath, out);
  console.error(`Wrote ${outPath} (${allowed.length} allowed, ${byRelevance.exclude.length} excluded)`);
  process.exit(0);
}

// Start the server
main().catch((error) => {
  console.error("Fatal error in main execution:", error);
  process.exit(1);
});

/**
 * Formats API errors for better readability
 * 
 * @param error Axios error
 * @returns Formatted error message
 */
function formatApiError(error: AxiosError): string {
  let message = 'API request failed.';
  if (error.response) {
    message = `API Error: Status ${error.response.status} (${error.response.statusText || 'Status text not available'}). `;
    const responseData = error.response.data;
    const MAX_LEN = 200;
    if (typeof responseData === 'string') {
      message += `Response: ${responseData.substring(0, MAX_LEN)}${responseData.length > MAX_LEN ? '...' : ''}`;
    }
    else if (responseData) {
      try {
        const jsonString = JSON.stringify(responseData);
        message += `Response: ${jsonString.substring(0, MAX_LEN)}${jsonString.length > MAX_LEN ? '...' : ''}`;
      } catch {
        message += 'Response: [Could not serialize data]';
      }
    }
    else {
      message += 'No response body received.';
    }
  } else if (error.request) {
    message = 'API Network Error: No response received from server.';
    if (error.code) message += ` (Code: ${error.code})`;
  } else {
    message += `API Request Setup Error: ${error.message}`;
  }
  return message;
}

/**
 * Converts a JSON Schema to a Zod schema for runtime validation
 * 
 * @param jsonSchema JSON Schema
 * @param toolName Tool name for error reporting
 * @returns Zod schema
 */
function getZodSchemaFromJsonSchema(jsonSchema: any, toolName: string): z.ZodTypeAny {
  if (typeof jsonSchema !== 'object' || jsonSchema === null) {
    return z.object({}).passthrough();
  }
  try {
    const zodSchemaString = jsonSchemaToZod(jsonSchema);
    const zodSchema = eval(zodSchemaString);
    if (typeof zodSchema?.parse !== 'function') {
      throw new Error('Eval did not produce a valid Zod schema.');
    }
    return zodSchema as z.ZodTypeAny;
  } catch (err: any) {
    console.error(`Failed to generate/evaluate Zod schema for '${toolName}':`, err);
    return z.object({}).passthrough();
  }
}
