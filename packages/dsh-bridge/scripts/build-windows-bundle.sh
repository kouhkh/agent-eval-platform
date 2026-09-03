#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
service_root=$(cd "$script_dir/.." && pwd)
dsh_source_root=${DSH_SOURCE_ROOT:-/Users/ltc/CursorProject/deepseek-harness/deepseek-ai/deepseek-harness}
output_root=${1:-/Users/ltc/CodexProject/中交机电局项目/artifacts/dsh-agent-windows}

if [[ ! -d "$dsh_source_root/.git" ]]; then
  echo "DSH source repository not found: $dsh_source_root" >&2
  exit 1
fi

dsh_revision=$(git -C "$dsh_source_root" rev-parse HEAD)
dsh_short_revision=${dsh_revision:0:12}
bundle_staging=$(mktemp -d)
trap 'rm -rf -- "$bundle_staging"' EXIT

mkdir -p "$bundle_staging/deepseek-harness" "$bundle_staging/agent-service" "$output_root"
git -C "$dsh_source_root" archive HEAD | tar -x -C "$bundle_staging/deepseek-harness"
rsync -a --exclude 'artifacts/' --exclude 'public/' --exclude 'schemas/' "$service_root/" "$bundle_staging/agent-service/"
printf '%s\n' "$dsh_revision" > "$bundle_staging/DSH_REVISION.txt"

bundle_path="$output_root/agent-eval-dsh-bridge-windows-$dsh_short_revision.zip"
(
  cd "$bundle_staging"
  zip -q -r -X "$bundle_path" .
)

shasum -a 256 "$bundle_path"
