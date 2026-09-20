/**
 * Shared helpers for the local database scripts.
 *
 * These run under Node (not in the Worker), so they read DATABASE_URL from the
 * environment or from .dev.vars — the same file `wrangler dev` uses, which
 * keeps one copy of the connection string for both.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Read DATABASE_URL from the environment, falling back to .dev.vars. */
export function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  try {
    const vars = readFileSync(resolve(ROOT, '.dev.vars'), 'utf8');
    for (const line of vars.split('\n')) {
      const match = line.match(/^\s*DATABASE_URL\s*=\s*(.*)$/);
      if (match) return match[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    // No .dev.vars — fall through to the error below.
  }

  throw new Error(
    'DATABASE_URL is not set.\n' +
      'Create a free Neon project at https://neon.tech, copy the pooled\n' +
      'connection string, then either:\n' +
      '  echo "DATABASE_URL=postgresql://..." > .dev.vars\n' +
      'or export it in your shell before running this script.'
  );
}

/**
 * Split a SQL script into individual statements.
 *
 * Tracks single quotes, double-quoted identifiers, dollar-quoted blocks and
 * both comment styles, so a semicolon inside any of them is not treated as a
 * statement boundary.
 */
export function splitStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const rest = sql.slice(i);

    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = sql.indexOf(ch, i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    const dollar = rest.match(/^\$[A-Za-z_]*\$/);
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}
