// Runs every .sql file in supabase/migrations, in filename order, against
// DATABASE_URL. Usage: node --env-file=.env.local scripts/run-migrations.mjs
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set (expected in .env.local).");
    process.exit(1);
  }

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.error(`No .sql files found in ${MIGRATIONS_DIR}`);
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });

  console.log(`Connecting to ${redactUrl(databaseUrl)} ...`);
  await client.connect();
  console.log("Connected.");

  try {
    for (const file of files) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
      console.log(`\nApplying ${file} ...`);
      await client.query(sql);
      console.log(`  OK`);
    }

    console.log("\nVerifying tables...");
    const { rows } = await client.query(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name in ('listings', 'sync_status', 'favourites')
       order by table_name`
    );
    console.log("Tables present:", rows.map((r) => r.table_name).join(", ") || "(none found)");
  } finally {
    await client.end();
  }
}

function redactUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = "****";
    return u.toString();
  } catch {
    return "(unparseable connection string)";
  }
}

main().catch((err) => {
  console.error("\nMigration failed:", err.message);
  process.exit(1);
});
