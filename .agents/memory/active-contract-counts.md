---
name: Monthly active-contract balances
description: The user's agreed meaning and update cadence for active-contract counts in ZERO3 PRO.
---

In ZERO3 PRO, active contracts are a monthly balance entry, not a value derived from sales. Users choose a month or date and enter the total active contracts for that period. The value may change and should support monthly balancing.

**Why:** the user specified this entry model because active contract totals can change and need monthly updates.

**How to apply:** persist explicit monthly snapshots with an editable total; keep them separate from sales, and do not infer a zero for periods without a saved balance.
