#!/bin/sh
set -eu

# The named Disco-home volume may outlive an image rebuild. Refresh the
# checked-in, non-secret HA configuration on every container start so the
# volume cannot retain an obsolete config. Atomic rename also makes concurrent
# migrate/daemon startup safe when they share the volume.
mkdir -p "$HOME/.disco"
config_tmp="$(mktemp "$HOME/.disco/.config.yaml.XXXXXX")"
trap 'rm -f "$config_tmp"' EXIT HUP INT TERM
cat /etc/disco/ha-config.yaml >"$config_tmp"
chmod 0444 "$config_tmp"
mv -f "$config_tmp" "$HOME/.disco/config.yaml"
trap - EXIT HUP INT TERM

exec "$@"
