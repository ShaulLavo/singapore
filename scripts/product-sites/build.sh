#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
output=${1:?Usage: build.sh OUTPUT_DIRECTORY}

if [[ -e "$output" ]]; then
  echo "Output directory already exists: $output" >&2
  exit 1
fi

mkdir "$output"
output=$(cd "$output" && pwd)
cd "$root"

bun run build -- --filter=singapore-editor-site --filter=@singapore-editor/example-app
SITE_ORIGIN=https://singapore.shaulavo.dev bun run --cwd site build --base /
VITE_BASE_PATH=/demo/ bun run --cwd examples/app build

cp -R site/dist/. "$output/"
mkdir -p "$output/demo"
cp -R examples/app/dist/. "$output/demo/"
cp scripts/product-sites/_headers "$output/_headers"
