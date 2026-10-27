---
name: Workers API root routing
description: Static Assets routing behavior for the exact API prefix and nested API paths.
---

Configure Workers Static Assets to run the Worker for both the exact API prefix `/api` and nested paths `/api/*`. Do not assume the wildcard also matches the prefix without a trailing slash.

**Why:** With SPA fallback enabled, a local Wrangler runtime served the app's `index.html` with HTTP 200 for bare `/api`, while `/api/healthz` correctly reached the Worker. The exact root was swallowed by asset routing.

**How to apply:** When the Worker owns an API prefix, smoke-test both `/api` and a nested `/api/...` route in local Wrangler. Use `--local` and a temporary persistence directory when the config also declares D1.
