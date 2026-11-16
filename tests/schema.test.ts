import { describe, expect, it } from 'vitest';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { createD1 } from './d1.ts';

describe('ensureSchema', () => {
  it('upgrades a database created before quote_checked_at existed', async () => {
    resetSchemaCache();
    const db = createD1();
    // The vouchers table as the first deploy created it.
    await db.exec(`CREATE TABLE vouchers (id TEXT PRIMARY KEY, identity_key TEXT NOT NULL, retailer_domain TEXT NOT NULL,
      status TEXT NOT NULL, verification_level TEXT, data_json TEXT NOT NULL, source_url TEXT NOT NULL, evidence TEXT NOT NULL,
      quote_found INTEGER, expires_on TEXT, submitted_by TEXT NOT NULL, flagged INTEGER NOT NULL DEFAULT 0, verified_at TEXT,
      next_check_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    await ensureSchema(db);
    const { results } = await db.prepare("SELECT name FROM pragma_table_info('vouchers')").all<{ name: string }>();
    expect(results.map((r) => r.name)).toContain('quote_checked_at');
    // Running it again on a fresh instance changes nothing and does not fail.
    resetSchemaCache();
    await ensureSchema(db);
  });
});
