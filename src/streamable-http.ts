
/**
 * StreamableHTTP server setup for HTTP-based MCP communication using Hono
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { v4 as uuid } from 'uuid';
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InitializeRequestSchema, JSONRPCError } from "@modelcontextprotocol/sdk/types.js";
import { toReqRes, toFetchResponse } from 'fetch-to-node';

import { runWithMealieToken } from './request-context.js';
import { SERVER_NAME, SERVER_VERSION } from './index.js';

/** Header for per-user Mealie API token (multi-tenant chat UIs like Open WebUI). */
export const MEALIE_TOKEN_HEADER = 'X-Mealie-Token';

// Constants
const SESSION_ID_HEADER_NAME = "mcp-session-id";
const JSON_RPC = "2.0";

/** Factory: create a new MCP Server per connection (SDK allows only one transport per Server). */
export type McpServerFactory = () => Server;

/**
 * StreamableHTTP MCP Server handler
 */
class MCPStreamableHttpServer {
  createServer: McpServerFactory;
  // Store active transports by session ID
  transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

  constructor(createServer: McpServerFactory) {
    this.createServer = createServer;
  }

  /**
   * Handle GET requests: return server info for discovery (e.g. Cursor MCP).
   * MCP Streamable HTTP uses POST for JSON-RPC; GET allows clients to discover the server.
   */
  async handleGetRequest(c: any) {
    const accept = c.req.header('Accept') || '';
    if (accept.includes('text/event-stream')) {
      return c.text('Method Not Allowed', 405, {
        'Allow': 'POST',
        'Content-Type': 'text/plain'
      });
    }
    return c.json(
      {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        transport: 'streamable-http',
        message: 'Use POST with JSON-RPC for MCP; include header mcp-session-id for existing sessions.',
        endpoint: '/mcp',
        perUserTokenHeader: MEALIE_TOKEN_HEADER,
        perUserTokenHint: 'Send X-Mealie-Token (or Authorization: Bearer) with the logged-in user\'s Mealie API token for multi-user chat UIs.'
      },
      200,
      {
        'Allow': 'POST, GET',
        'Cache-Control': 'no-store'
      }
    );
  }

  /**
   * Handle POST requests (all MCP communication).
   * Reads X-Mealie-Token or Authorization: Bearer for per-user token (multi-tenant).
   */
  async handlePostRequest(c: any) {
    const mealieToken =
      c.req.header(MEALIE_TOKEN_HEADER)?.trim() ||
      (c.req.header('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim());

    return runWithMealieToken(mealieToken, () => this.handlePostRequestInner(c));
  }

  private async handlePostRequestInner(c: any) {
    const sessionId = c.req.header(SESSION_ID_HEADER_NAME);
    console.error(`POST request received ${sessionId ? 'with session ID: ' + sessionId : 'without session ID'}`);

    try {
      const body = await c.req.json();

      // Convert Fetch Request to Node.js req/res
      const { req, res } = toReqRes(c.req.raw);

      // Reuse existing transport if we have a session ID
      if (sessionId && this.transports[sessionId]) {
        const transport = this.transports[sessionId];

        // Handle the request with the transport
        await transport.handleRequest(req, res, body);

        // Cleanup when the response ends
        res.on('close', () => {
          console.error(`Request closed for session ${sessionId}`);
        });

        // Convert Node.js response back to Fetch Response
        return toFetchResponse(res);
      }

      // Create new transport for initialize requests (one Server per session)
      if (!sessionId && this.isInitializeRequest(body)) {
        console.error("Creating new StreamableHTTP transport for initialize request");

        const server = this.createServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => uuid(),
        });

        // Add error handler for debug purposes
        transport.onerror = (err) => {
          console.error('StreamableHTTP transport error:', err);
        };

        // Connect the transport to a fresh MCP server (one server per connection)
        await server.connect(transport);

        // Handle the request with the transport
        await transport.handleRequest(req, res, body);

        // Store the transport if we have a session ID
        const newSessionId = transport.sessionId;
        if (newSessionId) {
          console.error(`New session established: ${newSessionId}`);
          this.transports[newSessionId] = transport;

          // Set up clean-up for when the transport is closed
          transport.onclose = () => {
            console.error(`Session closed: ${newSessionId}`);
            delete this.transports[newSessionId];
          };
        }

        // Cleanup when the response ends
        res.on('close', () => {
          console.error(`Request closed for new session`);
        });

        // Convert Node.js response back to Fetch Response
        return toFetchResponse(res);
      }

      // Invalid request (no session ID and not initialize)
      return c.json(
        this.createErrorResponse("Bad Request: invalid session ID or method."),
        400
      );
    } catch (error) {
      console.error('Error handling MCP request:', error);
      return c.json(
        this.createErrorResponse("Internal server error."),
        500
      );
    }
  }

  /**
   * Create a JSON-RPC error response
   */
  private createErrorResponse(message: string): JSONRPCError {
    return {
      jsonrpc: JSON_RPC,
      error: {
        code: -32000,
        message: message,
      },
      id: uuid(),
    };
  }

  /**
   * Check if the request is an initialize request
   */
  private isInitializeRequest(body: any): boolean {
    const isInitial = (data: any) => {
      const result = InitializeRequestSchema.safeParse(data);
      return result.success;
    };

    if (Array.isArray(body)) {
      return body.some(request => isInitial(request));
    }

    return isInitial(body);
  }
}

/**
 * Sets up a web server for the MCP server using StreamableHTTP transport
 * 
 * @param createServer Factory that returns a new MCP Server (one per connection)
 * @param port The port to listen on (default: 3031)
 * @returns The Hono app instance
 */
export async function setupStreamableHttpServer(createServer: McpServerFactory, port = 3031) {
  // Create Hono app
  const app = new Hono();

  // Enable CORS
  app.use('*', cors());

  // Create MCP handler (uses factory so each session gets its own Server instance)
  const mcpHandler = new MCPStreamableHttpServer(createServer);

  // Add a simple health check endpoint
  app.get('/health', (c) => {
    return c.json({ status: 'OK', server: SERVER_NAME, version: SERVER_VERSION });
  });

  // Main MCP endpoint supporting both GET and POST
  app.get("/mcp", (c) => mcpHandler.handleGetRequest(c));
  app.post("/mcp", (c) => mcpHandler.handlePostRequest(c));

  // Static files for the web client (if any)
  app.get('/*', async (c) => {
    const filePath = c.req.path === '/' ? '/index.html' : c.req.path;
    try {
      // Use Node.js fs to serve static files
      const fs = await import('fs');
      const path = await import('path');
      const { fileURLToPath } = await import('url');

      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const publicPath = path.join(__dirname, '..', '..', 'public');
      const fullPath = path.join(publicPath, filePath);

      // Simple security check to prevent directory traversal
      if (!fullPath.startsWith(publicPath)) {
        return c.text('Forbidden', 403);
      }

      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          const content = fs.readFileSync(fullPath);

          // Set content type based on file extension
          const ext = path.extname(fullPath).toLowerCase();
          let contentType = 'text/plain';

          switch (ext) {
            case '.html': contentType = 'text/html'; break;
            case '.css': contentType = 'text/css'; break;
            case '.js': contentType = 'text/javascript'; break;
            case '.json': contentType = 'application/json'; break;
            case '.png': contentType = 'image/png'; break;
            case '.jpg': contentType = 'image/jpeg'; break;
            case '.svg': contentType = 'image/svg+xml'; break;
          }

          return new Response(content, {
            headers: { 'Content-Type': contentType }
          });
        }
      } catch (err) {
        // File not found or other error
        return c.text('Not Found', 404);
      }
    } catch (err) {
      console.error('Error serving static file:', err);
      return c.text('Internal Server Error', 500);
    }

    return c.text('Not Found', 404);
  });

  // Start the server (hostname 0.0.0.0 so it accepts connections from proxy/other hosts)
  serve({
    fetch: app.fetch,
    port,
    hostname: '0.0.0.0'
  }, (info) => {
    console.error(`MCP StreamableHTTP Server running at http://0.0.0.0:${info.port}`);
    console.error(`- MCP Endpoint: http://<host>:${info.port}/mcp`);
    console.error(`- Health Check: http://<host>:${info.port}/health`);
  });

  return app;
}
