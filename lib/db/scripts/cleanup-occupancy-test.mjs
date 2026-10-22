// Run after stopping the local isolated browser-test server.
import { readFile, unlink } from "node:fs/promises";
import pg from "pg";

if (!process.env.DATABASE_URL || process.env.NODE_ENV === "production") throw new Error("Limpeza restrita ao banco de desenvolvimento.");
const statePath = "/tmp/zero3-occupancy-ui.json";
const state = JSON.parse(await readFile(statePath, "utf8"));
if (typeof state.schema !== "string" || !/^occupancy_ui_[a-f0-9]{32}$/.test(state.schema)) {
  throw new Error("Recusada remoção de esquema que não é de teste isolado de ocupação.");
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${state.schema}" CASCADE`);
  await unlink(statePath);
  console.info("Esquema privado de teste removido. Tabelas compartilhadas preservadas.");
} finally {
  await client.end();
}
