#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push
node lib/db/scripts/add-occupancy.mjs
