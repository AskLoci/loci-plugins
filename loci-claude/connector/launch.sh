#!/bin/sh
# Use an existing Node installation. Never install or download executable code.
set -eu
case "$0" in
  */*) script_dir=${0%/*} ;;
  *) script_dir=. ;;
esac
try_node() {
  runtime=$1
  shift
  if "$runtime" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
    exec "$runtime" "$script_dir/stdio.mjs" "$@"
  fi
  return 1
}
if command -v node >/dev/null 2>&1; then
  try_node node "$@" || :
fi
for runtime in /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -x "$runtime" ]; then
    try_node "$runtime" "$@" || :
  fi
done
printf '%s\n' 'Loci requires Node.js 22 or later. Install an LTS version from https://nodejs.org and restart Claude Code.' >&2
exit 1
