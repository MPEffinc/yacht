FROM node:22-bookworm-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build

COPY tsconfig.json tsconfig.server.json tsconfig.client.json vite.config.ts vitest.config.ts ./
COPY src ./src
COPY client ./client
COPY tests ./tests

RUN npm test \
    && npm run build \
    && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist

USER node
EXPOSE 3000

CMD ["node", "dist/server/src/server.js"]
