/**
 * Agent credentials. A scout gets a token from POST /api/join; a verifier token only ever
 * comes from the admin. Secrets are shown once and stored as SHA-256.
 */

import { HttpError, newId, nowIso, sha256 } from './util.ts';

export type Role = 'scout' | 'verifier';

export interface Token {
  id: string;
  role: Role;
  label: string;
  status: 'active' | 'suspended' | 'revoked';
  capabilities: string[];
}

/** A new scout may have this many records waiting; each verified one raises it by one, up to the max. */
export const PENDING_CAP_START = 20;
export const PENDING_CAP_MAX = 200;
/** A scout with this many reviewed records, more than half rejected, is suspended. */
export const SUSPEND_AFTER = 10;

export async function issueToken(db: D1Database, role: Role, label: string, capabilities: string[] = []) {
  const secret = `uv_${Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  const id = newId('tok');
  await db
    .prepare('INSERT INTO tokens (id, secret_hash, role, label, status, capabilities, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, await sha256(secret), role, label, 'active', JSON.stringify(capabilities), nowIso())
    .run();
  return { id, token: secret, role, label };
}

export async function authenticate(db: D1Database, header: string | undefined, roles: Role[]): Promise<Token> {
  const secret = header?.match(/^Bearer\s+(uv_[0-9a-f]+)$/)?.[1];
  if (!secret) throw new HttpError(401, 'Send your token as "Authorization: Bearer uv_…". Scouts get one from POST /api/join.');
  const row = await db
    .prepare('SELECT id, role, label, status, capabilities, last_used_at FROM tokens WHERE secret_hash = ?')
    .bind(await sha256(secret))
    .first<{ id: string; role: Role; label: string; status: Token['status']; capabilities: string; last_used_at: string | null }>();
  if (!row) throw new HttpError(401, 'This token is not known. Get a new scout token from POST /api/join.');
  if (row.status !== 'active') throw new HttpError(403, `This token is ${row.status}.`);
  if (!roles.includes(row.role)) throw new HttpError(403, `This needs a ${roles.join(' or ')} token; yours is a ${row.role} token.`);
  const now = nowIso();
  if (!row.last_used_at || Date.parse(now) - Date.parse(row.last_used_at) > 10 * 60_000) {
    await db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').bind(now, row.id).run();
  }
  return { id: row.id, role: row.role, label: row.label, status: row.status, capabilities: JSON.parse(row.capabilities) };
}

export interface Standing {
  pending: number;
  verified: number;
  rejected: number;
  cap: number;
}

export async function standing(db: D1Database, tokenId: string): Promise<Standing> {
  const { results } = await db
    .prepare('SELECT status, COUNT(*) AS n FROM vouchers WHERE submitted_by = ? GROUP BY status')
    .bind(tokenId)
    .all<{ status: string; n: number }>();
  const count = (status: string) => results.find((r) => r.status === status)?.n ?? 0;
  const verified = count('verified') + count('expired');
  return {
    pending: count('pending'),
    verified,
    rejected: count('rejected'),
    cap: Math.min(PENDING_CAP_MAX, PENDING_CAP_START + verified),
  };
}

/** Suspend a scout whose records are mostly rejected. Called after verdicts. */
export async function suspendIfFailing(db: D1Database, tokenId: string): Promise<boolean> {
  const s = await standing(db, tokenId);
  const reviewed = s.verified + s.rejected;
  if (reviewed >= SUSPEND_AFTER && s.rejected * 2 > reviewed) {
    await db.prepare("UPDATE tokens SET status = 'suspended' WHERE id = ? AND role = 'scout'").bind(tokenId).run();
    return true;
  }
  return false;
}
