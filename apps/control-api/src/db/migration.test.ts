import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

const databases: PGlite[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("control database migration", () => {
  it("runs twice and creates the required control-plane tables and plans", async () => {
    const database = new PGlite();
    databases.push(database);
    const sql = await readFile(new URL("./migrations/001_initial.sql", import.meta.url), "utf8");

    await database.exec(sql);
    await database.exec(sql);

    const tables = await database.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
    const names = new Set(tables.rows.map((row) => row.table_name));
    for (const required of [
      "users", "user_identities", "devices", "tunnels", "domains",
      "subscriptions", "entitlements", "orders", "payments",
      "provisioning_jobs", "admin_users", "audit_logs", "system_configs"
    ]) {
      expect(names.has(required)).toBe(true);
    }

    const plans = await database.query<{ code: string }>("SELECT code FROM plans ORDER BY code");
    expect(plans.rows.map((row) => row.code)).toEqual(["formal", "free"]);
  }, 20_000);
});
