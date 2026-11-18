import { randomUUID } from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { COLLECTION } from './firebaseAdmin';

/**
 * Agent analysis history: an append-only, INTERNAL-ONLY log of what the
 * automated Meta Ads analysis pipeline found / suggested / decided, so the
 * next run has continuity ("have we already proposed this? was it approved?").
 *
 * Storage: a Firestore SUBCOLLECTION of the client's doc --
 *   clientPortal/client:<clientId>/analysisHistory/<entryId>
 *
 * Why a subcollection and not a field on the client doc:
 *  - The public client view (index.html?view=client) reads the whole
 *    `client:<id>` doc straight from the browser, and the security rules
 *    open `/clientPortal/{docId}` to everyone. A field on that doc would be
 *    downloadable by the client even if the UI never rendered it. Rules for
 *    `/clientPortal/{docId}` do NOT cover subcollections, so web clients get
 *    default-deny here while the Admin SDK (this server) bypasses rules.
 *  - The admin UI's saveClient() overwrites the entire client doc with
 *    set({value}); an embedded array would be clobbered by it.
 *  - One doc per entry makes appends atomic/race-free (no read-modify-write)
 *    and lets status updates touch exactly one field of one doc.
 */
export const HISTORY_SUBCOLLECTION = 'analysisHistory';

export const ENTRY_TYPES = ['finding', 'suggestion', 'decision'] as const;
export const ENTRY_STATUSES = ['proposed', 'approved', 'rejected', 'implemented', 'superseded'] as const;

export type EntryType = (typeof ENTRY_TYPES)[number];
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export type HistoryEntryInput = {
  campaignName: string;
  adName?: string;
  role: string;
  type: EntryType;
  summary: string;
  status: EntryStatus;
  relatedMetrics?: Record<string, unknown>;
};

export type HistoryEntry = HistoryEntryInput & { id: string; timestamp: string };

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 200;

function norm(s: string | undefined): string {
  return (s || '').trim().toLowerCase();
}

export function historyCollection(db: Firestore, clientId: string) {
  return db.collection(COLLECTION).doc('client:' + clientId).collection(HISTORY_SUBCOLLECTION);
}

/**
 * Turn raw input entries into storable entries: server-generated id +
 * timestamp, and campaignName resolved (case-insensitive, trimmed -- same rule
 * as sync_campaigns) to the campaign's canonical name. Entries whose
 * campaignName matches no existing campaign are reported in `unmatched`
 * rather than silently stored, so the log can't drift from real campaigns.
 *
 * Timestamps within one batch are spaced 1ms apart so newest-first ordering
 * is stable and deterministic for entries written in a single call.
 */
export function buildEntries(
  input: HistoryEntryInput[],
  campaigns: Array<{ name: string }>,
  now: Date = new Date()
): { entries: HistoryEntry[]; unmatched: string[] } {
  const byName = new Map<string, string>();
  for (const c of campaigns || []) byName.set(norm(c.name), c.name);

  const entries: HistoryEntry[] = [];
  const unmatched: string[] = [];
  const base = now.getTime();

  input.forEach((e, i) => {
    const canonical = byName.get(norm(e.campaignName));
    if (!canonical) {
      if (!unmatched.includes(e.campaignName)) unmatched.push(e.campaignName);
      return;
    }
    const entry: HistoryEntry = {
      id: 'h' + randomUUID().replace(/-/g, '').slice(0, 16),
      timestamp: new Date(base + i).toISOString(),
      campaignName: canonical,
      role: e.role,
      type: e.type,
      summary: e.summary,
      status: e.status,
    };
    // Firestore rejects `undefined` values, so only set optional fields when present.
    if (e.adName !== undefined && e.adName !== '') entry.adName = e.adName;
    if (e.relatedMetrics !== undefined) entry.relatedMetrics = e.relatedMetrics;
    entries.push(entry);
  });

  return { entries, unmatched };
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT);
}

/**
 * Newest-first entries, optionally narrowed to one campaign and/or to entries
 * at or after `since`.
 *
 * Ordering/`since` use only the single `timestamp` field (auto-indexed). The
 * campaignName filter is applied in memory on purpose: combining a campaign
 * equality filter with orderBy(timestamp) would need a composite Firestore
 * index that has to be created by hand, and per-client history is small.
 */
export async function queryHistory(
  db: Firestore,
  clientId: string,
  opts: { campaignName?: string; limit?: number; since?: string }
): Promise<HistoryEntry[]> {
  const limit = clampLimit(opts.limit);
  let q: FirebaseFirestore.Query = historyCollection(db, clientId).orderBy('timestamp', 'desc');
  if (opts.since) q = q.where('timestamp', '>=', opts.since);

  if (!opts.campaignName) {
    const snap = await q.limit(limit).get();
    return snap.docs.map(d => d.data() as HistoryEntry);
  }

  const wanted = norm(opts.campaignName);
  const snap = await q.get();
  return snap.docs
    .map(d => d.data() as HistoryEntry)
    .filter(e => norm(e.campaignName) === wanted)
    .slice(0, limit);
}
