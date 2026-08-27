import { randomUUID } from 'crypto';

export type Targeting = {
  age?: string;
  gender?: string;
  location?: string;
  placement?: string;
  interests?: string;
};

export type AdInput = {
  name: string;
  spendHKD?: number;
  reach?: number;
  clicks?: number;
  results?: number;
  notes?: string;
};

export type AdSetInput = {
  name: string;
  startDate?: string;
  endDate?: string;
  budgetHKD?: number;
  targeting?: Targeting;
  // Only meaningful when the parent campaign's objective is 'Leads': Meta's Leads
  // objective can collect leads via an Instant Form ('form', the default) or via a
  // Messenger/WhatsApp/IG conversation ('messages') -- same objective, different
  // result metric (名單數/cost-per-lead vs 對話開始次數/cost-per-conversation-started).
  resultType?: 'form' | 'messages';
  ads?: AdInput[];
};

export type CampaignInput = {
  name: string;
  objective?: 'Awareness' | 'Traffic' | 'Engagement' | 'Leads' | 'Sales' | 'AppPromotion';
  notes?: string;
  adsets?: AdSetInput[];
};

function uid(): string {
  return 'c' + randomUUID().replace(/-/g, '').slice(0, 12);
}

function norm(s: string | undefined): string {
  return (s || '').trim().toLowerCase();
}

function emptyTargeting(): Targeting {
  return { age: '', gender: '不限', location: '', interests: '', placement: '' };
}

function splitInterests(s: string | undefined): string[] {
  return (s || '').split(/[,，、]/).map(x => x.trim()).filter(Boolean);
}

const TARGETING_FIELD_LABELS: Record<string, string> = { age: '年齡層', gender: '性別', location: '地區', placement: '版位' };

/**
 * Mirrors index.html's diffTargeting() so ad set targeting changes made via
 * this MCP server (e.g. a Claude Cowork scheduled sync) get the same
 * auto-logged changeLog entry as an edit made through the admin UI --
 * previously this function didn't exist here at all, so syncing a targeting
 * change (e.g. a narrowed age range) silently overwrote it with no record.
 */
function diffTargeting(oldTg: Targeting, newTg: Targeting): any[] {
  const changes: any[] = [];
  for (const field of Object.keys(TARGETING_FIELD_LABELS)) {
    const from = ((oldTg as any)[field] || '').trim();
    const to = ((newTg as any)[field] || '').trim();
    if (from !== to) changes.push({ field, label: TARGETING_FIELD_LABELS[field], from: from || '—', to: to || '—' });
  }
  const oldInt = splitInterests(oldTg.interests), newInt = splitInterests(newTg.interests);
  if (oldInt.join('|') !== newInt.join('|')) {
    const added = newInt.filter(x => !oldInt.includes(x));
    const removed = oldInt.filter(x => !newInt.includes(x));
    if (added.length || removed.length) changes.push({ field: 'interests', label: '興趣', added, removed });
    else changes.push({ field: 'interests', label: '興趣', from: oldTg.interests || '—', to: newTg.interests || '—' });
  }
  return changes;
}

/**
 * Upsert campaigns/ad sets/ads into an existing campaigns array, matched by
 * name (case-insensitive, trimmed). Matched entries have their fields
 * updated in place; unmatched incoming names are appended as new entries.
 * Never deletes anything already present — mirrors the portal's own
 * migrateClientData()/save flow so Firestore data stays in the exact shape
 * index.html expects.
 */
export function mergeCampaigns(existing: any[], incoming: CampaignInput[]): any[] {
  const campaigns = Array.isArray(existing) ? existing.map(c => ({ ...c })) : [];

  for (const inC of incoming) {
    let camp = campaigns.find(c => norm(c.name) === norm(inC.name));
    if (!camp) {
      camp = { id: uid(), name: inC.name, objective: inC.objective || 'Traffic', notes: inC.notes || '', adsets: [] };
      campaigns.push(camp);
    } else {
      if (inC.objective) camp.objective = inC.objective;
      if (inC.notes !== undefined) camp.notes = inC.notes;
      camp.adsets = Array.isArray(camp.adsets) ? camp.adsets : [];
    }

    for (const inAs of inC.adsets || []) {
      let as = camp.adsets.find((a: any) => norm(a.name) === norm(inAs.name));
      if (!as) {
        as = {
          id: uid(),
          name: inAs.name,
          startDate: inAs.startDate || '',
          endDate: inAs.endDate || '',
          budgetHKD: +(inAs.budgetHKD || 0),
          targeting: { ...emptyTargeting(), ...(inAs.targeting || {}) },
          resultType: inAs.resultType || 'form',
          ads: [],
        };
        camp.adsets.push(as);
      } else {
        if (inAs.startDate !== undefined) as.startDate = inAs.startDate;
        if (inAs.endDate !== undefined) as.endDate = inAs.endDate;
        if (inAs.budgetHKD !== undefined) as.budgetHKD = +inAs.budgetHKD || 0;
        if (inAs.targeting) {
          const oldTargeting = as.targeting || emptyTargeting();
          const mergedTargeting = { ...oldTargeting, ...inAs.targeting };
          const changes = diffTargeting(oldTargeting, mergedTargeting);
          if (changes.length) {
            as.changeLog = Array.isArray(as.changeLog) ? as.changeLog : [];
            as.changeLog.push({ id: uid(), date: new Date().toISOString().slice(0, 10), changes });
          }
          as.targeting = mergedTargeting;
        }
        if (inAs.resultType !== undefined) as.resultType = inAs.resultType;
        as.ads = Array.isArray(as.ads) ? as.ads : [];
      }

      for (const inAd of inAs.ads || []) {
        let ad = as.ads.find((a: any) => norm(a.name) === norm(inAd.name));
        if (!ad) {
          ad = { id: uid(), name: inAd.name, spendHKD: 0, reach: 0, clicks: 0, results: 0, notes: '' };
          as.ads.push(ad);
        }
        if (inAd.spendHKD !== undefined) ad.spendHKD = +inAd.spendHKD || 0;
        if (inAd.reach !== undefined) ad.reach = +inAd.reach || 0;
        if (inAd.clicks !== undefined) ad.clicks = +inAd.clicks || 0;
        if (inAd.results !== undefined) ad.results = +inAd.results || 0;
        if (inAd.notes !== undefined) ad.notes = inAd.notes;
      }
    }
  }

  return campaigns;
}
