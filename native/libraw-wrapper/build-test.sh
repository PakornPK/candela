#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
cmake -B build-native
cmake --build build-native
ctest --test-dir build-native --output-on-failure
