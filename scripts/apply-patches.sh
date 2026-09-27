#!/bin/sh
# Applies unified diffs in patches/ to node_modules.
# patch-package can't be used because it doesn't recognize ant.lockb,
# so patches are stored as plain diffs (git apply -p1 format, applied from
# inside the package directory). Idempotent: already-applied patches skip.
set -e
cd "$(dirname "$0")/.."

for patchfile in patches/*.patch; do
  [ -f "$patchfile" ] || continue
  # aedes+1.2.0.patch -> node_modules/aedes
  # @scope+name+1.2.0.patch -> node_modules/@scope/name
  pkg=$(basename "$patchfile" .patch | sed -E 's/\+[^+]*$//; s/^(@[^+]+)\+(.+)/\1\/\2/')
  dir="node_modules/$pkg"
  if [ ! -d "$dir" ]; then
    echo "skip $patchfile: $dir not installed" >&2
    continue
  fi
  if git -C "$dir" apply --check "../../$patchfile" 2>/dev/null; then
    git -C "$dir" apply "../../$patchfile"
    echo "applied $patchfile"
  elif git -C "$dir" apply -R --check "../../$patchfile" 2>/dev/null; then
    echo "skip $patchfile: already applied"
  else
    echo "skip $patchfile: does not apply cleanly" >&2
  fi
done
