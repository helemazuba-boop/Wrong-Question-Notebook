# syntax=docker/dockerfile:1.7

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ARG http_proxy
ARG https_proxy
ARG no_proxy
# ============================================================
# Stage 1: Dependencies
# ============================================================
ARG BASE_NODE_IMAGE=node:24-alpine
FROM ${BASE_NODE_IMAGE} AS deps
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ARG http_proxy
ARG https_proxy
ARG no_proxy
ENV HTTP_PROXY=${HTTP_PROXY}
ENV HTTPS_PROXY=${HTTPS_PROXY}
ENV NO_PROXY=${NO_PROXY}
ENV http_proxy=${http_proxy}
ENV https_proxy=${https_proxy}
ENV no_proxy=${no_proxy}

RUN apk add --no-cache libc6-compat

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm ci --ignore-scripts

# ============================================================
# Stage 2: Build
# ============================================================
FROM ${BASE_NODE_IMAGE} AS builder
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ARG http_proxy
ARG https_proxy
ARG no_proxy
ENV HTTP_PROXY=${HTTP_PROXY}
ENV HTTPS_PROXY=${HTTPS_PROXY}
ENV NO_PROXY=${NO_PROXY}
ENV http_proxy=${http_proxy}
ENV https_proxy=${https_proxy}
ENV no_proxy=${no_proxy}

# Only public values may be passed as build arguments. Server credentials are
# runtime-only and must never be recorded in an image layer or build history.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY
ARG WQN_SUPABASE_EXPECTED_HOST
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
ENV WQN_SUPABASE_EXPECTED_HOST=${WQN_SUPABASE_EXPECTED_HOST}
ENV SITE_URL=${SITE_URL}
ENV NEXT_TELEMETRY_DISABLED=${NEXT_TELEMETRY_DISABLED}
ENV NODE_ENV=production

# Next.js requires this value at build time and embeds it in server-only build
# output. A BuildKit secret keeps it out of ARG/ENV metadata and build layers.
RUN --mount=type=secret,id=next_server_actions_encryption_key,required=true \
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$(cat /run/secrets/next_server_actions_encryption_key)" \
    npm run build

# ============================================================
# Stage 3: Production runtime
# ============================================================
FROM ${BASE_NODE_IMAGE} AS runner
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ARG http_proxy
ARG https_proxy
ARG no_proxy
ENV HTTP_PROXY=${HTTP_PROXY}
ENV HTTPS_PROXY=${HTTPS_PROXY}
ENV NO_PROXY=${NO_PROXY}
ENV http_proxy=${http_proxy}
ENV https_proxy=${https_proxy}
ENV no_proxy=${no_proxy}

# Public values are embedded in the Next.js client bundle at build time.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY
ARG WQN_SUPABASE_EXPECTED_HOST
ARG SITE_URL

WORKDIR /app

# Runtime environment variables.
# NEXT_PUBLIC_ vars must be present so the client bundle (built in stage 2)
# sees them; they are embedded at build time and cannot change at runtime.
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}
ENV NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY=${NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY}
ENV WQN_SUPABASE_EXPECTED_HOST=${WQN_SUPABASE_EXPECTED_HOST}
ENV SITE_URL=${SITE_URL}
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Set proper permissions for Next.js standalone output
RUN mkdir .next && chown nextjs:nodejs .next

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# sharp's native runtime: Next's file tracing copies the .node addon
# (@img/sharp-linuxmusl-x64) into standalone, but NOT the libvips shared
# library it dlopens via rpath (@img/sharp-libvips-linuxmusl-x64) -- the
# dynamic-linker dependency is invisible to require() tracing, so the runtime
# died with ERR_DLOPEN_FAILED on libvips-cpp.so. Copy the whole @img scope
# (musl-x64 variants only in this image) over the traced node_modules.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@img ./node_modules/@img
COPY --from=builder --chown=nextjs:nodejs /app/docker-entrypoint.mjs ./docker-entrypoint.mjs

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "docker-entrypoint.mjs"]
