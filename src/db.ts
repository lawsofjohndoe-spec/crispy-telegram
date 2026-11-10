import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )
  `);

  const migrationDir = path.resolve(process.cwd(), "migrations");
  const migrationNames = (await readdir(migrationDir))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/i.test(name))
    .sort();

  for (const name of migrationNames) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const alreadyApplied = await client.query(
        "SELECT 1 FROM schema_migrations WHERE name = $1",
        [name],
      );
      if (alreadyApplied.rowCount === 0) {
        const sql = await readFile(path.join(migrationDir, name), "utf8");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
