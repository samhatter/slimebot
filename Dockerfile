FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./package.json
COPY tsconfig.json ./tsconfig.json
COPY src ./src
RUN npm run build

FROM node:22-bookworm AS runner
ARG GOPLACES_VERSION=0.3.0
ARG TARGETARCH
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl gh ripgrep tar \
	&& rm -rf /var/lib/apt/lists/* \
	&& mkdir -p /var/lib/slimebot/workspace /var/lib/slimebot/codex /var/lib/slimebot/logs

RUN set -eux; \
	arch="${TARGETARCH:-amd64}"; \
	case "$arch" in amd64|arm64) ;; *) echo "Unsupported TARGETARCH: $arch" >&2; exit 1 ;; esac; \
	curl -fsSL "https://github.com/steipete/goplaces/releases/download/v${GOPLACES_VERSION}/goplaces_${GOPLACES_VERSION}_linux_${arch}.tar.gz" -o /tmp/goplaces.tar.gz; \
	tar -xzf /tmp/goplaces.tar.gz -C /usr/local/bin goplaces; \
	chmod +x /usr/local/bin/goplaces; \
	rm -f /tmp/goplaces.tar.gz

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY --from=builder /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules

RUN chown -R node:node /app /var/lib/slimebot

USER node
 
VOLUME ["/var/lib/slimebot/workspace", "/var/lib/slimebot/codex"]

CMD ["node", "dist/index.js"]
