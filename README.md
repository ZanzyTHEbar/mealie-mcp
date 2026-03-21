# mealie-mcp

MCP (Model Context Protocol) server generated from the [Mealie](https://mealie.io) OpenAPI spec. Exposes Mealie's REST API as MCP tools for AI agents (e.g. Claude, Cursor) over **StreamableHTTP**.

## Features

- **Generated from OpenAPI**: All Mealie API endpoints (recipes, shopping lists, meal plans, etc.) are exposed as MCP tools.
- **StreamableHTTP transport**: HTTP-based MCP so it can be deployed as a web service and used by remote MCP clients.
- **Configurable base URL**: Set `MEALIE_BASE_URL` or `BASE_URL` to point at your Mealie instance.
- **Authentication**: Mealie uses OAuth2 password bearer. Set a Mealie API token (or OIDC token) via env.
- **Nutrition planning**: Includes `nutrition_tdee_calculate` for adult TDEE and calorie-target estimation using Mifflin-St Jeor by default and Cunningham when explicitly requested with body-fat data.

## Quick start (local)

```bash
npm install
cp .env.example .env
# Edit .env: set MEALIE_BASE_URL and OAUTH_TOKEN_OAUTH2PASSWORDBEARER (or BEARER_TOKEN_OAUTH2PASSWORDBEARER)
npm run build
npm run start:http
```

- MCP endpoint: `http://localhost:<PORT>/mcp` (default PORT=3031)
- Test client: `http://localhost:<PORT>`

To use a different port, set `PORT` in your env or `.env`.

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP port (configurable) | `3031` |
| `MEALIE_BASE_URL` or `BASE_URL` | Mealie instance URL (e.g. `https://mealie.example.com`) | `https://mealie.example.com` |
| `BEARER_TOKEN_OAUTH2PASSWORDBEARER` or `OAUTH_TOKEN_OAUTH2PASSWORDBEARER` | Mealie API token (from Mealie Admin → API Tokens, or your OIDC access token) | — |
| `ENRICHMENT_CACHE_ENABLED` | Enable in-memory food enrichment cache | `true` |
| `ENRICHMENT_CACHE_TTL_HOURS` | Cache TTL for price/nutrition enrichment lookups | `24` |

## Docker

```bash
docker build -t mealie-mcp .
docker run -p 3031:3031 \
  -e MEALIE_BASE_URL=https://mealie.example.com \
  -e BEARER_TOKEN_OAUTH2PASSWORDBEARER=your-token \
  mealie-mcp

# Different port: docker run -p 3032:3032 -e PORT=3032 -e MEALIE_BASE_URL=... -e BEARER_TOKEN_...=... mealie-mcp
```

## MCP client configuration

Point your MCP client at the StreamableHTTP URL, e.g.:

- **Cursor**: Add an MCP server with URL `https://mealie-mcp.yourdomain.com/mcp` (if deployed behind HTTPS).
- **Claude Desktop**: Configure the server URL in your MCP settings.

Session header: `mcp-session-id` (optional; server supports transport/session reuse). This is separate from the `mealie_start_session` tool, which currently reserves server-side context for future integrations rather than powering today's composite tools.

## Generation

This server was generated with [openapi-mcp-generator](https://github.com/harsha-iiiv/openapi-mcp-generator):

```bash
npx openapi-mcp-generator \
  --input mealie-openapi.json \
  --output mealie-mcp \
  --base-url https://mealie.example.com \
  --server-name mealie-mcp \
  --transport streamable-http \
  --port 3031
```

Regenerate after updating the OpenAPI spec (e.g. after a Mealie upgrade).

## Testing

- **Unit tests** (no network): `npm test` — runs deterministic food-pipeline and nutrition/TDEE tests.
- **Meal-planning tests**: `npm run test:meal-planning` — validates calendar-safe date handling and ingredient normalization helpers.
- **Nutrition-only tests**: `npm run test:nutrition` — validates TDEE equations, goal targets, and input validation.
- **Live tests** (real HTTP): `npm run test:live` — calls Continente.pt and Open Food Facts to validate the food-pipeline. Use `SKIP_CONTINENTE=1` or `SKIP_NUTRITION=1` to skip flaky endpoints.

## Custom nutrition tool

`nutrition_tdee_calculate` is a pure-computation MCP tool, so it does not require Mealie credentials.

Inputs:

- `age_years`, `sex_for_formula`, `height_cm`, `weight_kg`, `activity_level`
- Optional `activity_multiplier` for `activity_level: "custom"`
- Optional `body_fat_pct` for Cunningham
- Optional `formula` (`auto`, `mifflin_st_jeor`, `cunningham`)
- Optional `goal` (`maintain`, `cut`, `gain`, `custom`) and `goal_delta_kcal`

`auto` uses Mifflin-St Jeor as the primary equation. If `body_fat_pct` is provided, Cunningham may be returned under `alternative_estimates` as an additional resting-energy reference, but it is not selected as the primary formula unless `formula: "cunningham"` is passed.

The tool returns resting energy, the applied activity multiplier, estimated TDEE, maintenance and cut/gain targets, normalized input data, and warnings to help agents explain uncertainty clearly.

## License

MIT. Mealie is licensed under the AGPL; this MCP adapter is a separate layer.
