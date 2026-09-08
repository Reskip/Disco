#!/bin/sh
set -e

echo "🚀 Starting Disco production environment..."

# Create the state root if it is not a read-only mount. Never recursively chown
# it: config.yaml may be an operator-owned read-only ConfigMap/secret mount.
mkdir -p /home/disco/.disco
sudo -n chown disco:disco /home/disco/.disco 2>/dev/null || true

# Initialize database and create config only when absent
# --skip-if-exists: Idempotent, won't overwrite existing database
echo "📦 Initializing Disco environment..."
disco init \
  --skip-if-exists \
  --non-interactive \
  --agentic-tools "${DISCO_AGENTIC_TOOLS:-none}" \
  --daemon-port "${DAEMON_PORT:-3030}" \
  --daemon-host "${DAEMON_HOST:-0.0.0.0}"

# Run schema migrations before daemon startup. The production entrypoint creates
# /home/disco/.disco before `disco init`, so init is intentionally idempotent and
# may skip DB creation; this migration step replaces the old create-admin side
# effect that used to run migrations.
echo "🔄 Running database migrations..."
disco db migrate --yes

# Do NOT create a fixed default admin here.
#
# On first daemon start, the daemon's first-run bootstrap creates the initial
# superadmin only when the users table is empty:
#   - If DISCO_ADMIN_PASSWORD is set, that operator-provided password is used
#     and is never echoed back to logs.
#   - Otherwise, a random password is written to
#     /home/disco/.disco/admin-credentials with mode 0600, and logs only point
#     at that file path.
#
# This keeps production images idempotent without shipping a takeover-grade
# admin@disco.live/admin credential in every fresh deployment.
echo "👤 Admin bootstrap will be handled by daemon first-run setup."

# Start daemon in foreground (this keeps container alive)
echo "🚀 Starting daemon on port ${DAEMON_PORT:-3030}..."
exec disco-daemon
