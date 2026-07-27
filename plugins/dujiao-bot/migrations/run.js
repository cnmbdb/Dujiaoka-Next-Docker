const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function runMigrations() {
  const client = new Client({
    host: process.env.DB_HOST || 'dujiao-postgres',
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'dujiao_db',
    user: process.env.DB_USER || 'dujiao_user',
    password: process.env.DB_PASSWORD || undefined,
  });
  const migrationsDir = __dirname;
  const files = fs.readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS dujiao_bot_schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const result = await client.query('SELECT filename FROM dujiao_bot_schema_migrations');
    const applied = new Set(result.rows.map((row) => row.filename));

    for (const file of files) {
      if (applied.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
        await client.query(
          'INSERT INTO dujiao_bot_schema_migrations (filename) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
        console.log(`[migration] applied ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  runMigrations().catch((error) => {
    console.error('[migration] failed', error);
    process.exit(1);
  });
}

module.exports = { runMigrations };
