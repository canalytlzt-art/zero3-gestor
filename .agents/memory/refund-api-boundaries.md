---
name: API date and database boundaries
description: Calendar-date coercion and database dependency injection pitfalls in generated API routes.
---

Validate calendar-date strings from the original JSON request when exact `YYYY-MM-DD` validity matters. Generated OpenAPI Zod validators coerce `format: date` values into JavaScript `Date` objects, which lose the original calendar-date representation and can normalize impossible dates. In browser UI, normalize API date strings to their first 10 characters before using date-only inputs or comparisons.

**Why:** Invalid dates such as the 31st day of a short month can normalize into a different valid day, and serialized response dates may include a time suffix.

**How to apply:** Keep the generated schema validation, then pass the raw request-body date string through the calendar-date validator. Treat response values as date strings that may be ISO timestamps when displaying or comparing dates.

Route handlers created with an injected database dependency must use that injected connection for all reads and writes, not the module-level default database.

**Why:** Endpoints that bypassed the injected database could read and write outside the isolated test schema, hiding failures and breaking integration tests.

**How to apply:** Use the router factory's captured database for route queries and transactions, including refund list, candidate, and mutation endpoints.

When a router accepts an injected user resolver, mutation handlers must use the captured `getUserId(req)` for the actor instead of calling Clerk's `getAuth(req)` directly.

**Why:** Direct Clerk context access can fail in injected-router environments even after the route's access check succeeds, preventing backup restoration from being tested or reused with alternate auth adapters.

**How to apply:** Resolve the actor once through the router dependency after access is verified, and use that ID for audit records and restore operations.
