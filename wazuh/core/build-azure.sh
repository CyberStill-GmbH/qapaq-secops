#!/usr/bin/env bash
# Azure release variant: use the runner's maintained public CA trust store for Azure Database for
# PostgreSQL. The AWS build remains the default in build.sh and continues to pin the RDS CA bundle.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export QAPAQ_CORE_CA_MODE=system
exec bash "$HERE/build.sh" "$@"
