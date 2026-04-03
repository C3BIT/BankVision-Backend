# Backend API Dockerfile
# Multi-stage build for smaller image size

FROM node:20-alpine AS base
WORKDIR /app

# Copy package files
COPY package*.json ./

# Production dependencies stage
FROM base AS dependencies
RUN npm ci --only=production && npm cache clean --force

# Build stage
FROM base AS build
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

# Production stage
FROM node:20-alpine
WORKDIR /app

# Set production environment variables
ENV NODE_ENV=production
ENV PORT=5094

# Copy production dependencies and application
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/package.json ./
# Create uploads directory
RUN mkdir -p /app/uploads

# Expose port
EXPOSE 5094

# Health check (using node instead of wget — no external packages needed)
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://localhost:5094/api/dev/health').then(r=>{if(!r.ok)throw r;process.exit(0)}).catch(()=>process.exit(1))"

# Start application
CMD ["node", "src/index.js"]
