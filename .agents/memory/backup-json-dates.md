---
name: Backup JSON date validation
description: Generated API validation coerces JSON dates, affecting strict backup payload validation.
---

Validate the serialized backup format before date coercion. Generated API validators can turn date/date-time strings into JavaScript Date objects even though the backup format requires JSON strings.

**Why:** Strict second-stage backup validation rejected valid files when it received the already-coerced generated-parser result.

**How to apply:** Keep strict file-format checks on the original JSON payload; normalize dates separately for database comparisons. Do not weaken the backup file contract to accommodate internal coercion.
