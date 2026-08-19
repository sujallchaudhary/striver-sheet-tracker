# syntax=docker/dockerfile:1

# --- build stage -------------------------------------------------------------
# better-sqlite3 is a native addon with no musl prebuilds, so it is compiled
# here and only the resulting node_modules is carried into the runtime image.
FROM node:22-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# --- runtime stage -----------------------------------------------------------
FROM node:22-alpine

LABEL org.opencontainers.image.title="DSA Tracker"
LABEL org.opencontainers.image.description="Multi-user Striver A2Z DSA problem tracker"

# Create a non-root user for security
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./

# Copy application source
COPY lib/        ./lib/
COPY routes/     ./routes/
COPY public/     ./public/
COPY scripts/    ./scripts/
COPY server.js   ./
COPY striver_a2z_complete_sheet.csv ./

# The data/ directory is mounted as a volume at runtime so that:
#   - dsa.db (accounts and progress) persists across container restarts
#   - API keys are never baked into the image
RUN mkdir -p /data && chown app:app /data

# Use the mounted volume for data
ENV DSA_DATA_DIR=/data

USER app

EXPOSE 3210

# /api/auth/me responds without a session, so it works as a liveness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3210/api/auth/me > /dev/null || exit 1

CMD ["node", "server.js"]
