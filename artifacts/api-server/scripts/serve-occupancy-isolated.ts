// Local-only real API harness for browser tests: never routes writes to public tables.
import { randomUUID } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import express from "express";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool } from "@workspace/db";
import * as schema from "@workspace/db/schema";
import { createOccupancyRouter } from "../src/routes/occupancy";

if (process.env.NODE_ENV === "production") throw new Error("Local development tests only.");
const schemaName = `occupancy_ui_${randomUUID().replaceAll("-", "")}`;
const PgPool = pool.constructor as new (options: typeof pool.options) => typeof pool;
await pool.query(`CREATE SCHEMA "${schemaName}"`);
const isolatedPool = new PgPool({ ...pool.options, options: `-c search_path=${schemaName}` });
try {
  await isolatedPool.query(await readFile(new URL("../../../lib/db/scripts/occupancy-schema.sql", import.meta.url), "utf8"));
} catch (error) {
  await isolatedPool.end();
  await pool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
  await pool.end();
  throw error;
}
const app = express();
app.use(express.json());
app.use("/api", createOccupancyRouter({
  database: drizzle(isolatedPool, { schema }),
  getUserId: () => "isolated-browser-test",
  isAuthorized: async () => true,
}));
const http = app.listen(0, "127.0.0.1", async () => {
  const port = (http.address() as AddressInfo).port;
  await writeFile("/tmp/zero3-occupancy-ui.json", JSON.stringify({ url: `http://127.0.0.1:${port}`, schema: schemaName }));
  console.info(`Isolated occupancy API ready on http://127.0.0.1:${port}; only private test schema.`);
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await new Promise<void>((resolve) => http.close(() => resolve()));
  await isolatedPool.end();
  await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  await pool.end();
  await unlink("/tmp/zero3-occupancy-ui.json").catch(() => {});
  console.info("Private occupancy browser test schema removed.");
  process.exit(0);
}
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
