import { Pool } from "pg";

export function createPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: Number.parseInt(process.env.CONTROL_DB_POOL_SIZE ?? "10", 10),
    idleTimeoutMillis: 30_000
  });
}
