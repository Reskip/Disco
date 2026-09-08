#!/bin/bash
set -e

echo "🔒 Starting Disco PostgreSQL + RBAC Environment..."
echo ""
echo "This environment includes:"
echo "  - PostgreSQL database"
echo "  - RBAC + executor filesystem sandbox"
echo "  - Multi-user testing (alice, bob)"
echo ""

# Log the RBAC config the base entrypoint will apply. The public-facing
# DISCO_RBAC_ENABLED / DISCO_UNIX_USER_MODE → internal DISCO_SET_* translation is
# handled by the base entrypoint (docker-entrypoint.sh), so both the postgres
# and plain profiles use the same naming contract.
if [ -n "$DISCO_RBAC_ENABLED" ] || [ -n "$DISCO_UNIX_USER_MODE" ]; then
  echo "⚙️  RBAC settings from environment:"
  [ "$DISCO_RBAC_ENABLED" = "true" ] && echo "  execution.branch_rbac = true"
  [ -n "$DISCO_UNIX_USER_MODE" ] && echo "  execution.unix_user_mode = $DISCO_UNIX_USER_MODE"
  echo ""
fi

# Run base entrypoint to start daemon and UI
# This handles:
# - Building @disco/core
# - Database migrations
# - Creating admin user
# - Applying RBAC config (DISCO_RBAC_ENABLED / DISCO_UNIX_USER_MODE)
# - Starting daemon and UI
echo "🚀 Running base initialization..."
exec /usr/local/bin/docker-entrypoint.sh
