# syntax=docker/dockerfile:1
FROM node:22-alpine

LABEL org.opencontainers.image.title="DSA Tracker"
LABEL org.opencontainers.image.description="Personal Striver A2Z DSA problem tracker"

# Create a non-root user for security
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY lib/        ./lib/
COPY public/     ./public/
COPY server.js   ./
COPY striver_a2z_complete_sheet.csv ./

# The data/ directory is mounted as a volume at runtime so that:
#   - db.json persists across container restarts
#   - API keys are never baked into the image
RUN mkdir -p /data && chown app:app /data

# Use the mounted volume for data
ENV DSA_DATA_DIR=/data

USER app

EXPOSE 3210

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3210/api/dashboard > /dev/null || exit 1

CMD ["node", "server.js"]
