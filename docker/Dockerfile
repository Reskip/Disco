# Multi-Stage Dockerfile for Disco
# Use build targets to create dev and prod images from shared base
#
# Build commands:
#   Development: docker build --target development -t disco:dev -f docker/Dockerfile .
#   Production:  docker build --target production -t disco:prod -f docker/Dockerfile .
#
# Or use docker-compose which automatically selects the right target

# ============================================================================
# Stage 1: Shared Base (dev and prod both use this)
# ============================================================================
FROM node:22-slim AS base

# Install system dependencies (including git for repo cloning)
RUN apt-get update && apt-get install -y \
  sqlite3 \
  git \
  curl \
  sudo \
  vim \
  procps \
  htop \
  lsof \
  net-tools \
  iputils-ping \
  wget \
  jq \
  less \
  tree \
  openssh-server \
  acl \
  ripgrep \
  bubblewrap \
  && rm -rf /var/lib/apt/lists/*
# bubblewrap: filesystem-only executor sandbox. See context/explorations/executor-sandboxing.md.

# Configure SSH server for multi-user testing (used in postgres profile)
RUN mkdir -p /run/sshd && \
  # Enable password authentication
  sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config && \
  # Disable root login
  sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin no/' /etc/ssh/sshd_config && \
  # Allow all users to login
  echo 'AllowUsers disco alice bob' >> /etc/ssh/sshd_config

# Install Zellij (terminal multiplexer)
# Pinned to v0.43.1 for reproducibility
RUN ZELLIJ_VERSION=0.43.1 && \
  curl -L "https://github.com/zellij-org/zellij/releases/download/v${ZELLIJ_VERSION}/zellij-x86_64-unknown-linux-musl.tar.gz" | \
  tar -xz -C /usr/local/bin && \
  chmod +x /usr/local/bin/zellij && \
  zellij --version

# Install GitHub CLI (gh) - download pre-built binary
RUN curl -fsSL "$(curl -s https://api.github.com/repos/cli/cli/releases/latest | grep 'browser_download_url.*linux_amd64.tar.gz"' | cut -d'"' -f4)" | \
  tar -xz -C /tmp && \
  mv /tmp/gh_*/bin/gh /usr/local/bin/ && \
  rm -rf /tmp/gh_*

# Install only the workspace package manager in the shared image. Agentic-tool
# runtimes are not part of production unless explicitly installed through Disco.
RUN npm install -g pnpm@11.17.0

# Arguments for matching host user UID/GID (default to 1000)
ARG UID=1000
ARG GID=1000

# Rename existing 'node' user to 'disco' and switch UID/GID to match host.
# This is critical for bind mount permissions on Linux.
#
# The GID may already be taken by another group in the base image (e.g. a
# macOS host GID of 20 collides with the base image's 'dialout' group). When
# that happens, rename the existing group to 'disco' instead of failing —
# everything downstream (and the entrypoint) chowns against the 'disco' name.
RUN set -eux; \
    usermod -l disco -d /home/disco -m -u "${UID}" node; \
    if getent group "${GID}" >/dev/null; then \
      groupmod -n disco "$(getent group "${GID}" | cut -d: -f1)"; \
    else \
      groupmod -n disco -g "${GID}" node; \
    fi; \
    usermod -g disco disco; \
    # Development image only: allow the entrypoint to repair bind-mount ownership.
    echo "disco ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/disco; \
    chmod 0440 /etc/sudoers.d/disco; \
    # Create .disco directory for database and config (will be mounted as volume)
    mkdir -p /home/disco/.disco; \
    chown -R disco:disco /home/disco

# Copy Zellij config for the daemon user.
COPY docker/zellij-config.kdl /tmp/zellij-config.kdl
RUN mkdir -p /home/disco/.config/zellij && \
    cp /tmp/zellij-config.kdl /home/disco/.config/zellij/config.kdl && \
    chown -R disco:disco /home/disco/.config && \
    rm /tmp/zellij-config.kdl

# Set working directory
WORKDIR /app

# Switch to disco user
USER disco

# ============================================================================
# Stage 2: Development (hot-reload for daemon and UI)
# ============================================================================
FROM base AS development

# Source mode resolves OpenCode from PATH; keep its exact development runtime
# out of the shared production base.
RUN sudo npm install -g opencode-ai@1.14.33

# Copy package files for dependency installation (as root, then chown)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/disco-daemon/package.json ./apps/disco-daemon/
COPY apps/disco-cli/package.json ./apps/disco-cli/
COPY apps/disco-ui/package.json ./apps/disco-ui/
COPY packages/git/package.json ./packages/git/
COPY packages/core/package.json ./packages/core/
COPY packages/agentic-tool-opencode/package.json ./packages/agentic-tool-opencode/
COPY packages/agentic-tools/package.json ./packages/agentic-tools/
COPY packages/executor/package.json ./packages/executor/
COPY packages/client/package.json ./packages/client/
COPY patches/streamdown@2.5.0.patch ./patches/streamdown@2.5.0.patch

# Install dependencies as disco user (cached in Docker layer)
# This creates node_modules with correct platform binaries for container
# An anonymous volume at /app/node_modules shadows the bind mount, preserving these deps
RUN sudo chown -R disco:disco /app && \
    pnpm install --frozen-lockfile

# Copy entrypoint scripts
COPY docker/docker-entrypoint.sh /usr/local/bin/
COPY docker/docker-entrypoint-postgres.sh /usr/local/bin/
RUN sudo chmod +x /usr/local/bin/docker-entrypoint.sh && \
    sudo chmod +x /usr/local/bin/docker-entrypoint-postgres.sh && \
    sudo chown disco:disco /usr/local/bin/docker-entrypoint.sh && \
    sudo chown disco:disco /usr/local/bin/docker-entrypoint-postgres.sh

# Expose UI port only (daemon is internal)
EXPOSE ${VITE_PORT:-5173}

# Use entrypoint script to start both processes
ENTRYPOINT ["docker-entrypoint.sh"]

# ============================================================================
# Stage 3: Production (installs disco-live from npm)
# ============================================================================
FROM base AS production

# Switch back to root to install global npm packages
USER root

# Install disco-live globally from npm.
# This installs both the CLI and daemon binaries
RUN npm install -g disco-live@latest

# Switch back to disco user
USER disco

# Copy production entrypoint script
COPY docker/docker-entrypoint-prod.sh /usr/local/bin/
RUN sudo chmod +x /usr/local/bin/docker-entrypoint-prod.sh && \
    sudo chown disco:disco /usr/local/bin/docker-entrypoint-prod.sh

# Expose daemon port (UI will be served via static files by daemon)
EXPOSE ${DAEMON_PORT:-3030}

# Use production entrypoint script
ENTRYPOINT ["docker-entrypoint-prod.sh"]

# ============================================================================
# Stage 4a: Source builder (heavy; discarded — never shipped)
# ============================================================================
# Builds disco-live from THIS checkout via packages/disco-live/build.sh (turbo
# build → copies each package's dist/ into disco-live/dist/{core,git,cli,daemon,
# executor,ui} — the exact layout the npm package ships), then produces a
# immutable release tarballs, then installs those tarballs into an isolated
# global prefix with lifecycle scripts disabled. The runtime therefore uses the
# same scriptless artifact that npm users and release CI exercise.
FROM base AS source-builder

USER root
WORKDIR /app

# Full monorepo source. .dockerignore keeps node_modules/, dist/ and .git out.
COPY . .

# Real commit SHA for the in-app build banner. .git is dockerignored, so the
# daemon's stamp-build-info.mjs can't run `git rev-parse` — it reads
# DISCO_BUILD_SHA instead and writes dist/.build-info, which loadBuildInfo()
# surfaces at startup. CI passes --build-arg DISCO_BUILD_SHA=<github.sha>; left
# empty (local builds) the stamp falls back to the 'dev' sentinel.
ARG DISCO_BUILD_SHA=""
ENV DISCO_BUILD_SHA=${DISCO_BUILD_SHA}

# Install workspace deps (dev deps needed for the turbo build), build the exact
# release artifacts, then perform a script-disabled install. Supplying the
# locally packed client alongside disco-live keeps this pre-publication build
# independent of registry publication order.
RUN pnpm install --frozen-lockfile \
  && bash packages/disco-live/build.sh --skip-install \
  && npm install -g --prefix /opt/disco-runtime --ignore-scripts --no-audit --no-fund \
       packages/disco-live/release/disco-live-client-*.tgz \
       packages/disco-live/release/disco-live-[0-9]*.tgz \
  && test -d /opt/disco-runtime/lib/node_modules/disco-live/node_modules/@disco/core \
  && test -d /opt/disco-runtime/lib/node_modules/disco-live/node_modules/@disco/git

# ============================================================================
# Stage 4b: Production from source (slim runtime — pinned to its git SHA)
# ============================================================================
# Same runtime shape as `production` (inherits the shared base with Zellij and
# gh, but no agentic-tool runtimes), while shipping disco-live built from source
# instead of `npm install -g disco-live@latest`. Only the deployed artifact is
# copied in — the multi-GB builder (source + dev deps + store) is left behind.
#
#   docker build --target production-source -t disco:<sha> -f docker/Dockerfile .
FROM base AS production-source

USER root

# The one thing we keep from the builder: the isolated global npm prefix.
COPY --chown=disco:disco --from=source-builder /opt/disco-runtime /opt/disco-runtime

# Put the npm-generated global bins on PATH. They resolve dependencies and the
# bundled internal modules entirely within /opt/disco-runtime.
RUN ln -sf /opt/disco-runtime/bin/disco /usr/local/bin/disco \
  && ln -sf /opt/disco-runtime/bin/disco-daemon /usr/local/bin/disco-daemon \
  && chmod a+rx \
       /opt/disco-runtime/lib/node_modules/disco-live/bin/disco.js \
       /opt/disco-runtime/lib/node_modules/disco-live/bin/disco-daemon.js

# Reuse the production entrypoint (disco init → db migrate → exec disco-daemon).
COPY docker/docker-entrypoint-prod.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint-prod.sh

# Drop back to the unprivileged runtime user.
USER disco

EXPOSE ${DAEMON_PORT:-3030}
ENTRYPOINT ["docker-entrypoint-prod.sh"]

# ============================================================================
# Stage 4c: Production-from-source HA smoke runtime
# ============================================================================
# Branch worktrees can be protected by host ACLs that the container's `disco`
# user cannot read through a bind mount. Bake the non-secret HA configuration
# into the image instead, then materialize it atomically into the shared Disco
# home at container startup. Secrets remain runtime environment variables.
FROM production-source AS production-source-ha

USER root
COPY docker/ha/config.yaml /tmp/disco-ha-config.yaml
COPY docker/ha/docker-entrypoint.sh /tmp/disco-ha-entrypoint
# COPY can preserve restrictive worktree ACLs, including on an implicitly
# created parent directory. `install` creates clean files and permissions.
RUN install -d -o root -g root -m 0755 /etc/disco \
  && install -o root -g root -m 0444 /tmp/disco-ha-config.yaml /etc/disco/ha-config.yaml \
  && install -o root -g root -m 0555 /tmp/disco-ha-entrypoint /usr/local/bin/disco-ha-entrypoint \
  && rm /tmp/disco-ha-config.yaml /tmp/disco-ha-entrypoint
USER disco

ENTRYPOINT ["/usr/local/bin/disco-ha-entrypoint"]
