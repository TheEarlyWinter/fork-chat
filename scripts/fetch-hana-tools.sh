#!/usr/bin/env bash
# Extract official author tools, never install or start the desktop application.
set -euo pipefail
cache="${1:?Usage: bash scripts/fetch-hana-tools.sh CACHE_DIRECTORY}"
mkdir -p "$cache"
cache="$(cd "$cache" && pwd)"
name='HanaAgent-1.1.111-beta-Linux-amd64.deb'
url="https://github.com/liliMozi/openhanako/releases/download/v1.1.111-beta/$name"
sha='5e3d6c554e9b6ed360b5bafd7e0e3fabc0024dddf60907453f9145b7303865a2'
archive="$cache/$name"
if [[ ! -f "$archive" ]]; then
  partial="$(mktemp "$cache/download.XXXXXXXX")"
  trap 'rm -f "$partial"' EXIT
  curl --fail --location --retry 3 --output "$partial" "$url" >&2
  printf '%s  %s\n' "$sha" "$partial" | sha256sum --check - >&2
  mv "$partial" "$archive"
  trap - EXIT
fi
printf '%s  %s\n' "$sha" "$archive" | sha256sum --check - >&2
# A unique extraction directory prevents a previous extraction from masquerading
# as a verified toolchain. The pinned package is only unpacked, not dpkg-installed.
payload="$(mktemp -d "$cache/extracted.XXXXXXXX")"
dpkg-deb --extract "$archive" "$payload"
mapfile -d '' tools < <(find "$payload" -type f -path '*/scripts/extension-pack.mjs' -print0)
if (( ${#tools[@]} == 0 )); then
  # Desktop installers may carry the Server as a seed tarball rather than files.
  mapfile -d '' seeds < <(find "$payload" -type f \( -name '*server*.tar.gz' -o -name '*server*.tgz' \) -print0)
  if (( ${#seeds[@]} != 1 )); then
    echo "Official installer has no unique Server seed; update the reviewed toolchain pin/layout." >&2
    exit 1
  fi
  server="$(mktemp -d "$cache/server.XXXXXXXX")"
  tar --extract --gzip --file="${seeds[0]}" --directory="$server"
  mapfile -d '' tools < <(find "$server" -type f -path '*/scripts/extension-pack.mjs' -print0)
fi
if (( ${#tools[@]} != 1 )); then
  echo "Expected exactly one official extension-pack.mjs, found ${#tools[@]}." >&2
  exit 1
fi
root="$(dirname "$(dirname "${tools[0]}")")"
test -f "$root/scripts/validate-app.mjs"
test -f "$root/APPS.md"
printf '%s\n' "$root"
