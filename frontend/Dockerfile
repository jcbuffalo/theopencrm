# Frontend Dockerfile for Cloud Run
# Build React app and serve with Node/Express

# Stage 1: Build React app
FROM node:18-alpine AS builder
WORKDIR /app
# package-lock.json is generated with npm 10 to match this image's npm
# (node:18-alpine), so `npm ci` validates cleanly. If you regenerate the lock,
# use npm 10 (`npx npm@10 install`) — a newer npm resolves CRA's transitive
# tree differently and `npm ci` will fail the strict sync check here.
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Runtime
FROM node:18-alpine
WORKDIR /app

# Install only production dependencies for server
RUN npm install --omit=dev express compression

# Copy built React app from builder
COPY --from=builder /app/build ./build
COPY server.js routeManifest.cjs ./

# Create non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
USER nodejs

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 8080) + '/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

EXPOSE ${PORT:-8080}
CMD ["node", "server.js"]
