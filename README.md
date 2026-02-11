# mealie-mcp

MCP (Model Context Protocol) server generated from the [Mealie](https://mealie.io) OpenAPI spec. Exposes Mealie's REST API as MCP tools for AI agents (e.g. Claude, Cursor) over **StreamableHTTP**.

## Features

- **Generated from OpenAPI**: All Mealie API endpoints (recipes, shopping lists, meal plans, etc.) are exposed as MCP tools.
- **StreamableHTTP transport**: HTTP-based MCP so it can be deployed as a web service and used by remote MCP clients.
- **Configurable base URL**: Set `MEALIE_BASE_URL` or `BASE_URL` to point at your Mealie instance.
- **Authentication**: Mealie uses OAuth2 password bearer. Set a Mealie API token (or OIDC token) via env.

## Quick start (local)

```bash
npm install
cp .env.example .env
# Edit .env: set MEALIE_BASE_URL and OAUTH_TOKEN_OAUTH2PASSWORDBEARER (or BEARER_TOKEN_OAUTH2PASSWORDBEARER)
npm run build
npm run start:http
```

- MCP endpoint: `http://localhost:3000/mcp`
- Test client: `http://localhost:3000`

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP port | `3000` |
| `MEALIE_BASE_URL` or `BASE_URL` | Mealie instance URL (e.g. `https://mealie.example.com`) | `https://mealie.example.com` |
| `BEARER_TOKEN_OAUTH2PASSWORDBEARER` or `OAUTH_TOKEN_OAUTH2PASSWORDBEARER` | Mealie API token (from Mealie Admin → API Tokens, or your OIDC access token) | — |

## Docker

```bash
docker build -t mealie-mcp .
docker run -p 3000:3000 \
  -e MEALIE_BASE_URL=https://mealie.example.com \
  -e BEARER_TOKEN_OAUTH2PASSWORDBEARER=your-token \
  mealie-mcp
```

## MCP client configuration

Point your MCP client at the StreamableHTTP URL, e.g.:

- **Cursor**: Add an MCP server with URL `https://mealie-mcp.yourdomain.com/mcp` (if deployed behind HTTPS).
- **Claude Desktop**: Configure the server URL in your MCP settings.

Session header: `mcp-session-id` (optional; server supports session reuse).

## Generation

This server was generated with [openapi-mcp-generator](https://github.com/harsha-iiiv/openapi-mcp-generator):

```bash
npx openapi-mcp-generator \
  --input mealie-openapi.json \
  --output mealie-mcp \
  --base-url https://mealie.example.com \
  --server-name mealie-mcp \
  --transport streamable-http \
  --port 3000
```

Regenerate after updating the OpenAPI spec (e.g. after a Mealie upgrade).

## License

MIT. Mealie is licensed under the AGPL; this MCP adapter is a separate layer.
