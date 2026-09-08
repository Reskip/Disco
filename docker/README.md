# Docker Setup for Disco

Disco provides both **development** and **production** Docker configurations with a shared base image to keep things DRY and maintainable.

## Architecture

```
docker/
├── Dockerfile.dev               # Dev build (multi-stage: base + dev dependencies)
├── Dockerfile.prod              # Prod build (multi-stage: base + npm disco-live)
├── docker-entrypoint.sh         # Dev startup (pnpm dev for daemon + UI)
├── docker-entrypoint-prod.sh    # Prod startup (disco daemon only)
└── .env.prod.example            # Production environment template
```

Both Dockerfiles use multi-stage builds with a shared base stage:

- **Base stage**: System deps, Node 22, pnpm, AI CLIs, user setup (~500MB)
- **Dev stage**: Copies monorepo source, installs dev dependencies (~1.5GB)
- **Prod stage**: Installs `disco-live` from npm globally (~600MB)

## Quick Start

### Development Mode

```bash
# Build and start (daemon + UI with hot-reload)
docker compose up

# Access UI
open http://localhost:5173

# Access daemon API
curl http://localhost:3030/health
```

### Production Mode

```bash
# Build and start (daemon only, installs from npm)
docker compose -f docker-compose.prod.yml up

# Access UI (served by daemon)
open http://localhost:3030

# Access API
curl http://localhost:3030/health
```

## Configuration

### Development Environment Variables

Create a `.env` file:

```bash
# Daemon configuration
DAEMON_PORT=3030
CORS_ORIGIN=*

# UI configuration
UI_PORT=5173

# Seed test data (optional)
SEED=false

# API keys (optional)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...
```

### Production Environment Variables

Create a `.env.prod` file:

```bash
# Daemon configuration
DAEMON_PORT=3030
DAEMON_HOST=0.0.0.0
CORS_ORIGIN=*

# API keys (required for agent features)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...
```

Then run:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up
```

## Data Persistence

Both dev and prod use Docker volumes for data persistence:

```bash
# List volumes
docker volume ls | grep disco

# Inspect volume
docker volume inspect disco_disco-home

# Backup volume
docker run --rm -v disco_disco-home:/data -v $(pwd):/backup \
  alpine tar czf /backup/disco-backup.tar.gz -C /data .

# Restore volume
docker run --rm -v disco_disco-home:/data -v $(pwd):/backup \
  alpine tar xzf /backup/disco-backup.tar.gz -C /data
```

## First-Run Admin Bootstrap (Production)

Production images do **not** create a fixed default password.

On first startup with an empty users table, the daemon creates
`admin@disco.live` as the bootstrap superadmin using one of these paths:

1. Set `DISCO_ADMIN_PASSWORD` in the container environment. Disco uses that
   operator-provided password and does not print it.
2. Leave `DISCO_ADMIN_PASSWORD` unset. Disco generates a random password and
   writes it to `/home/disco/.disco/admin-credentials` with mode `0600`; logs
   only point at that file path.

The bootstrap admin is forced to change its password on first login.
`DISCO_ADMIN_PASSWORD` is only used while the users table is empty. If you
forget to set it before first startup, read the generated credentials file and
change the password after logging in; setting `DISCO_ADMIN_PASSWORD` on a later
restart will not reset an existing user's password.

```bash
# Retrieve generated credentials from inside the container when
# DISCO_ADMIN_PASSWORD was not provided.
docker compose -f docker-compose.prod.yml exec disco-prod \
  cat /home/disco/.disco/admin-credentials
```

## Building Images

### Build Base Image Only

```bash
docker compose build disco-base
```

### Build Development Image

```bash
docker compose build disco-dev
```

### Build Production Image

```bash
docker compose -f docker-compose.prod.yml build disco-prod
```

### Build All Images

```bash
# Build base first, then dev
docker compose build

# Build base first, then prod
docker compose -f docker-compose.prod.yml build
```

## Advanced Usage

### Multiple Branches (Dev)

Each git branch can run its own isolated Docker environment with:

- **A shared development image** (`disco-dev:latest`)
- **Separate volumes** (node_modules, database, config)
- **Separate ports** (using unique_id offset)
- **Prebuilt dependencies** from the image

This is configured in `.disco.yml`:

```yaml
environment:
  start: DAEMON_PORT={{add 3000 branch.unique_id}} UI_PORT={{add 5000 branch.unique_id}} docker compose -p disco-{{branch.name}} up -d --build
  stop: docker compose -p disco-{{branch.name}} down
```

Manual example:

```bash
# Branch 1 (postgres-support branch)
cd ~/.disco/worktrees/preset-io/disco/postgres-support
DAEMON_PORT=3001 UI_PORT=5001 docker compose -p disco-postgres-support up -d

# Branch 2 (main branch)
cd ~/.disco/worktrees/preset-io/disco/main
DAEMON_PORT=3002 UI_PORT=5002 docker compose -p disco-main up -d
```

**How it works:**

1. **Shared image**: all branch projects reuse `disco-dev:latest`; the managed `.disco.yml` workflow rebuilds it from the current checkout
2. **Volume isolation**: Docker Compose creates separate volumes per project (named volumes + anonymous volumes for node_modules)
3. **Prebuilt dependencies**: the image build runs `pnpm install`; startup uses those dependencies without reinstalling
4. **Non-interactive startup**: Compose and the entrypoint disable pnpm's workspace verification/purge prompts

**Benefits:**

- Work on multiple branches simultaneously
- Rebuild explicitly with `docker compose up --build` when the Dockerfile or lockfile changes
- Clean separation of databases and configs

### SSH Key Authentication (Dev)

Mount SSH keys for git operations:

```yaml
volumes:
  - ~/.ssh:/home/disco/.ssh:ro
```

This is already configured in `docker-compose.yml`.

### Host UID/GID Mapping (Linux)

On Linux, you can run the container as your host user to avoid permission issues entirely:

```bash
# Create .env file with your UID/GID
printf "UID=%s\nGID=%s\n" "$(id -u)" "$(id -g)" > .env

# Create docker-compose.override.yml
cat > docker-compose.override.yml <<'EOF'
services:
  disco-dev:
    user: "${UID:-1000}:${GID:-1000}"
EOF

# Start normally
docker compose up
```

**When to use this:**

- You're on Linux and want to avoid the automatic `chown` on startup
- You want container-created files to match your host user ownership

**Note:** On macOS/Windows, Docker Desktop handles UID mapping automatically - this override is unnecessary.

### Custom disco-live Version (Prod)

Pin to a specific version:

```dockerfile
# In docker/Dockerfile.prod, change:
RUN npm install -g disco-live@latest

# To:
RUN npm install -g disco-live@0.7.11
```

## Troubleshooting

### Port Already in Use

```bash
# Find process using port 3030
lsof -ti:3030 | xargs kill -9

# Or use different port
DAEMON_PORT=3031 docker compose up
```

### Volume Permission Issues

The entrypoint script automatically fixes permissions on bind-mounted directories during startup. This resolves issues where host-mounted files have different ownership than the container user.

**If you still see `EACCES: permission denied` errors:**

```bash
# Manually fix permissions (already runs automatically in entrypoint)
docker compose exec disco-dev sudo chown -R disco:disco /app

# Or restart container (permissions are fixed on startup)
docker compose restart disco-dev
```

**Note for Linux users:** On Linux, bind mounts preserve exact host UID/GID. If you prefer to avoid the automatic permission fix and match your host user, use the UID/GID override (see Advanced Usage below).

### Rebuild from Scratch

```bash
# Development
docker compose down -v
docker compose build --no-cache
docker compose up

# Production
docker compose -f docker-compose.prod.yml down -v
docker compose -f docker-compose.prod.yml build --no-cache
docker compose -f docker-compose.prod.yml up
```

### View Logs

```bash
# Development
docker compose logs -f disco-dev

# Production
docker compose -f docker-compose.prod.yml logs -f disco-prod
```

### Shell Access

```bash
# Development
docker compose exec disco-dev bash

# Production
docker compose -f docker-compose.prod.yml exec disco-prod bash
```

## Image Sizes

Expected image sizes:

- `disco-base`: ~500MB (Node 22 + system deps + AI CLIs)
- `disco-dev`: ~1.5GB (base + monorepo dependencies)
- `disco-prod`: ~600MB (base + npm disco-live package)

## Next Steps

- **Development**: Edit code in your editor, changes hot-reload automatically
- **Production**: Deploy to your server, configure reverse proxy (nginx/caddy)
- **Security**: Secure bootstrap credentials, configure HTTPS, set CORS_ORIGIN
- **Monitoring**: Check `/health` endpoint, monitor logs, set up alerts

## Architecture Notes

### Why Shared Base Image?

**Benefits:**

- DRY: System dependencies defined once
- Faster builds: Base layer cached and reused
- Consistency: Dev and prod use same base environment
- Maintainable: Update system deps in one place

### Why Separate Entrypoints?

**Development** (`docker-entrypoint.sh`):

- Installs dependencies from monorepo
- Builds `@disco/core`
- Runs `pnpm dev` for daemon + UI (hot-reload)
- Seeds test data (optional)

**Production** (`docker-entrypoint-prod.sh`):

- Installs `disco-live` from npm (global)
- Runs `disco init --skip-if-exists`
- Creates admin user
- Starts `disco-daemon` only (UI served as static files)

### Why npm Global Install for Production?

- **Simplicity**: Single package, single install
- **Official**: Uses published `disco-live` package
- **Tested**: Same package users install locally
- **No build step**: Pre-built binaries included

## References

- Main README: `README.md`
- Development docs: `CLAUDE.md`
- Context docs: `context/README.md`
