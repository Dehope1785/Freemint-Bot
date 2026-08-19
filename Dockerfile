# ---- Build stage ----
FROM node:20-slim AS builder

WORKDIR /app

# Install OpenSSL (required by Prisma SQLite engine)
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

# Copy dependency manifests
COPY package.json package-lock.json* ./
COPY prisma ./prisma

# Install ALL dependencies (including devDependencies) for building
RUN npm install

# Generate Prisma client
RUN npx prisma generate

# Copy source and TypeScript config, then compile
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ---- Production stage ----
FROM node:20-slim

WORKDIR /app

# Install OpenSSL (required by Prisma SQLite engine) and curl for healthchecks
RUN apt-get update && apt-get install -y --no-install-recommends openssl curl && rm -rf /var/lib/apt/lists/*

# Copy dependency manifests
COPY package.json package-lock.json* ./

# Install only production dependencies
RUN npm install --omit=dev

# Copy Prisma schema and generate client in production stage
COPY prisma ./prisma
RUN npx prisma generate

# Copy compiled output from build stage
COPY --from=builder /app/dist ./dist

# Ensure DB directory exists
RUN mkdir -p /app/data

ENV DATABASE_URL="file:/app/data/bot.db"

EXPOSE 3000

CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/main.js"]
