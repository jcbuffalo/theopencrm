# Dockerfile for Cloud Run deployment
# Multi-stage build for optimized image size

# Stage 1: Build stage
FROM node:22-alpine AS builder
WORKDIR /app
# isolated-vm (plugin runtime sandbox) is a native module that needs
# python3 + a C++ toolchain to build. Alpine ships without these.
RUN apk add --no-cache python3 make g++ libc6-compat
COPY package*.json ./
RUN npm ci --omit=dev

# Stage 2: Runtime stage
FROM node:22-alpine
WORKDIR /app

# Install curl for health checks + libstdc++ to load the native isolated-vm
# binary at runtime. libc6-compat is also needed because node-gyp links
# against glibc.
RUN apk add --no-cache curl libstdc++ libc6-compat

# Copy built dependencies from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application code
COPY . .

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
USER nodejs

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:${PORT:-5001}/health || exit 1

# Expose port
EXPOSE ${PORT:-5001}

# Start server
CMD ["node", "index.js"]
