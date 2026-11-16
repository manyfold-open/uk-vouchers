/**
 * The D1 schema, applied on the first request of each Worker instance.
 * Evolve it only with CREATE … IF NOT EXISTS, and keep semicolons out of statement
 * bodies: schemaStatements() splits on them.
 */

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS vouchers (
  id                 TEXT PRIMARY KEY,
  identity_key       TEXT NOT NULL,
  retailer_domain    TEXT NOT NULL,
  status             TEXT NOT NULL,
  verification_level TEXT,
  data_json          TEXT NOT NULL,
  source_url         TEXT NOT NULL,
  evidence           TEXT NOT NULL,
  quote_found        INTEGER,
  expires_on         TEXT,
  submitted_by       TEXT NOT NULL,
  flagged            INTEGER NOT NULL DEFAULT 0,
  verified_at        TEXT,
  next_check_at      TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS vouchers_identity ON vouchers (identity_key) WHERE status IN ('pending', 'verified');
CREATE INDEX IF NOT EXISTS vouchers_public ON vouchers (status, verified_at);
CREATE INDEX IF NOT EXISTS vouchers_retailer ON vouchers (retailer_domain, status);
CREATE INDEX IF NOT EXISTS vouchers_submitter ON vouchers (submitted_by, status);
CREATE INDEX IF NOT EXISTS vouchers_due ON vouchers (status, next_check_at);
CREATE INDEX IF NOT EXISTS vouchers_expiry ON vouchers (status, expires_on);

CREATE TABLE IF NOT EXISTS revisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_id  TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT NOT NULL,
  reason      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS revisions_voucher ON revisions (voucher_id, id);
CREATE INDEX IF NOT EXISTS revisions_actor ON revisions (actor, created_at);

CREATE TABLE IF NOT EXISTS tokens (
  id           TEXT PRIMARY KEY,
  secret_hash  TEXT NOT NULL UNIQUE,
  role         TEXT NOT NULL,
  label        TEXT NOT NULL,
  status       TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  voucher_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL,
  leased_by    TEXT,
  lease_until  TEXT,
  skip_tokens  TEXT NOT NULL DEFAULT '[]',
  note         TEXT,
  created_at   TEXT NOT NULL,
  done_at      TEXT
);
CREATE INDEX IF NOT EXISTS tasks_open ON tasks (status, created_at);
CREATE INDEX IF NOT EXISTS tasks_voucher ON tasks (voucher_id, status);

CREATE TABLE IF NOT EXISTS join_log (
  ip         TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS join_log_ip ON join_log (ip, created_at);
`;

export const schemaStatements = (): string[] =>
  SCHEMA.split(';').map((s) => s.trim()).filter(Boolean);

let applied = new WeakSet<D1Database>();

export async function ensureSchema(db: D1Database): Promise<void> {
  if (applied.has(db)) return;
  await db.batch(schemaStatements().map((sql) => db.prepare(sql)));
  applied.add(db);
}

/** Tests make a fresh database each time. */
export const resetSchemaCache = () => {
  applied = new WeakSet();
};
