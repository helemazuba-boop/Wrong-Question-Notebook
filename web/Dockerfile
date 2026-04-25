# ============================================================
# Stage 1: Dependencies
# ============================================================
FROM node:24-alpine AS deps

RUN apk add --no-cache libc6-compat

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm ci --ignore-scripts

# ============================================================
# Stage 2: Build
# ============================================================
FROM node:24-alpine AS builder

# Build arguments — passed in via --build-arg from .env.production
# All are forwarded to ENV so Next.js can read them at build time.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY
ARG SUPABASE_SERVICE_ROLE_KEY
ARG GEMINI_API_KEY
ARG SITE_URL
ARG NEXT_TELEMETRY_DISABLED=1

RUN apk add --no-cache libc6-compat

WORKDIR /app

COPY package.json package-lock.json* ./
COPY --from=deps /app/node_modules ./node_modules

COPY . .

# Forward build arguments to environment variables.
# These are available during `npm run build`.
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}
ENV NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY=${NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY}
ENV SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}
ENV GEMINI_API_KEY=${GEMINI_API_KEY}
ENV SITE_URL=${SITE_URL}
ENV NEXT_TELEMETRY_DISABLED=${NEXT_TELEMETRY_DISABLED}
ENV NODE_ENV=production

RUN npm run build

# ============================================================
# Stage 3: Production runtime
# ============================================================
FROM node:24-alpine AS runner

# Runtime build arguments — injected at container start via --build-arg.
# CONTAINER_NODE_OPTIONS is passed with a different value per architecture:
#   ARM64 → --max-old-space-size=200
#   AMD64 → --max-old-space-size=512
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY
ARG SUPABASE_SERVICE_ROLE_KEY
ARG GEMINI_API_KEY
ARG SITE_URL
ARG CONTAINER_NODE_OPTIONS=--max-old-space-size=512

WORKDIR /app

# Runtime environment variables.
# NEXT_PUBLIC_ vars must be present so the client bundle (built in stage 2)
# sees them — they are embedded at build time and cannot change at runtime.
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}
ENV NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY=${NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY}
ENV SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}
ENV GEMINI_API_KEY=${GEMINI_API_KEY}
ENV SITE_URL=${SITE_URL}
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS=${CONTAINER_NODE_OPTIONS}

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Set proper permissions for Next.js standalone output
RUN mkdir .next && chown nextjs:nodejs .next

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
