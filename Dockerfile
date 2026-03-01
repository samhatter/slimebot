FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json ./tsconfig.json
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY --from=builder /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules

RUN mkdir -p /var/lib/slimebot/workspace /var/lib/slimebot/codex
VOLUME ["/var/lib/slimebot/workspace", "/var/lib/slimebot/codex"]

CMD ["node", "dist/index.js"]
