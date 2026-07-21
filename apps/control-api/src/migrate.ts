import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadControlConfig } from "./config";
import { createPool } from "./db/pool";

const config = loadControlConfig();
const pool = createPool(config.databaseUrl);

try {
  const migrationPath = fileURLToPath(new URL("./db/migrations/001_initial.sql", import.meta.url));
  const sql = await readFile(migrationPath, "utf8");
  await pool.query(sql);
  console.info("Control API database migration completed");
} finally {
  await pool.end();
}
