/**
 * Apply db/schema.sql to the Neon database in DATABASE_URL.
 *
 * Idempotent — every statement is CREATE ... IF NOT EXISTS or an upsert, so
 * re-running it is safe.
 *
 *   npm run db:migrate
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { neon } from '@neondatabase/serverless';

import { ROOT, databaseUrl, splitStatements } from './db.mjs';

const sql = neon(databaseUrl());
const script = readFileSync(resolve(ROOT, 'db/schema.sql'), 'utf8');
const statements = splitStatements(script);

console.log(`Applying ${statements.length} statement(s) from db/schema.sql...`);

for (const [index, statement] of statements.entries()) {
  const label = statement.split('\n')[0].slice(0, 60);
  try {
    await sql.query(statement);
    console.log(`  ${index + 1}/${statements.length}  ${label}`);
  } catch (error) {
    console.error(`\nFailed on statement ${index + 1}:\n${statement}\n`);
    throw error;
  }
}

const [{ count }] = await sql`
  SELECT count(*)::int AS count
  FROM information_schema.tables
  WHERE table_schema = 'public'
`;
console.log(`\nMigration complete — ${count} table(s) in the public schema.`);
