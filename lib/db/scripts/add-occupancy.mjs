import { readFile } from "node:fs/promises";
import pg from "pg";

if (!process.env.DATABASE_URL || process.env.NODE_ENV === "production") {
  throw new Error("Execute a migração aditiva somente no banco de desenvolvimento configurado.");
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  await client.query("BEGIN");
  await client.query(await readFile(new URL("./occupancy-schema.sql", import.meta.url), "utf8"));
  await client.query("COMMIT");
  console.info("Estruturas de ocupação criadas. Nenhuma tabela financeira foi alterada.");
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await client.end();
}
