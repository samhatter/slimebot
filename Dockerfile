FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY --from=builder /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules

RUN mkdir -p /var/lib/slimebot/workspace
VOLUME ["/var/lib/slimebot/workspace"]

CMD ["node", "dist/index.js"]
