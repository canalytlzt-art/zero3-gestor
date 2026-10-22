---
name: Vite React dependency cache
description: Handling stale React versions in Vite's optimized dependency cache after package upgrades.
---

After upgrading React and React DOM in a pnpm workspace, Vite can continue serving optimized bundles that reference the previous versions even when the installed package links match.

**Why:** restarting alone did not remove the mismatch; the optimizer cache retained old dependency paths.

**How to apply:** compare installed package versions with Vite's dependency metadata and clear the artifact's generated Vite cache before restarting when they disagree.
