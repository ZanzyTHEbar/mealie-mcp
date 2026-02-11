# mealie-mcp: MCP server for Mealie API (StreamableHTTP)
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci 2>/dev/null || npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Production image
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
# Override at runtime if needed: -e PORT=3032 -p 3032:3032
ENV PORT=3031

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY --from=builder /app/build ./build
COPY public ./public

# Container listens on $PORT; expose default (override with -p when using different PORT)
EXPOSE 3031

CMD ["node", "build/index.js", "--transport=streamable-http"]
