import { createMcpHandler } from 'mcp-handler';
import { z } from 'zod';
import { getDb, COLLECTION } from '../../../lib/firebaseAdmin';
import { mergeCampaigns } from '../../../lib/sync';

const OBJECTIVES = ['Awareness', 'Traffic', 'Engagement', 'Leads', 'Sales', 'AppPromotion'] as const;
const LEADS_RESULT_TYPES = ['form', 'messages'] as const;

const targetingSchema = z.object({
  age: z.string().optional(),
  gender: z.string().optional(),
  location: z.string().optional(),
  placement: z.string().optional(),
  interests: z.string().optional(),
});

const adSchema = z.object({
  name: z.string(),
  spendHKD: z.number().optional(),
  reach: z.number().optional(),
  clicks: z.number().optional(),
  results: z.number().optional(),
  notes: z.string().optional(),
});

const adsetSchema = z.object({
  name: z.string(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  budgetHKD: z.number().optional(),
  targeting: targetingSchema.optional(),
  resultType: z.enum(LEADS_RESULT_TYPES).optional(),
  ads: z.array(adSchema).optional(),
});

const campaignSchema = z.object({
  name: z.string(),
  objective: z.enum(OBJECTIVES).optional(),
  notes: z.string().optional(),
  adsets: z.array(adsetSchema).optional(),
});

async function loadClientDoc(clientId: string) {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc('client:' + clientId);
  const snap = await ref.get();
  return { ref, exists: snap.exists, data: snap.exists ? (snap.data() as any).value : null };
}

const mcpHandler = createMcpHandler((server) => {
  server.registerTool(
    'list_clients',
    {
      title: 'List clients',
      description:
        "List all client-portal clients with their id, name, and Meta Ad Account ID mapping (if set). Use this first to find a client's id before calling other tools.",
      inputSchema: z.object({}),
    },
    async () => {
      const db = getDb();
      const idxSnap = await db.collection(COLLECTION).doc('clients-index').get();
      const index: Array<{ id: string; name: string }> = idxSnap.exists ? (idxSnap.data() as any).value || [] : [];
      const clients = await Promise.all(
        index.map(async (c) => {
          const { data } = await loadClientDoc(c.id);
          return { id: c.id, name: c.name, metaAdAccountId: data?.metaAdAccountId || '' };
        })
      );
      return { content: [{ type: 'text', text: JSON.stringify(clients, null, 2) }] };
    }
  );

  server.registerTool(
    'get_client',
    {
      title: 'Get client',
      description: "Get a client's full portal data: quota, and its campaigns/ad sets/ads.",
      inputSchema: z.object({ clientId: z.string() }),
    },
    async ({ clientId }) => {
      const { exists, data } = await loadClientDoc(clientId);
      if (!exists) return { content: [{ type: 'text', text: '找唔到呢個client。' }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    'set_client_meta_account',
    {
      title: 'Set client Meta Ad Account ID',
      description:
        'Map a portal client to a Meta Ads Ad Account ID (e.g. act_1234567890), so automated syncs know which ad account belongs to which client.',
      inputSchema: z.object({ clientId: z.string(), metaAdAccountId: z.string() }),
    },
    async ({ clientId, metaAdAccountId }) => {
      const { ref, exists, data } = await loadClientDoc(clientId);
      if (!exists) return { content: [{ type: 'text', text: '找唔到呢個client。' }], isError: true };
      data.metaAdAccountId = metaAdAccountId;
      await ref.set({ value: data });
      return { content: [{ type: 'text', text: `已將「${data.name}」對應到 ${metaAdAccountId}` }] };
    }
  );

  server.registerTool(
    'sync_campaigns',
    {
      title: 'Sync campaigns into a client',
      description:
        'Upsert campaigns/ad sets/ads for a client, merged by name (case-insensitive, trimmed). Entries matched by name get their dates/budget/targeting/resultType/spend/reach/clicks/results updated in place; unmatched names are created as new campaigns/ad sets/ads. Never deletes existing data. Use this to push Meta Ads data (pulled via the Meta Ads MCP) into the portal — map objective to one of Awareness/Traffic/Engagement/Leads/Sales/AppPromotion, and set "results" to whatever the objective\'s primary metric is (leads or conversation starts, conversions, engagements, installs, link clicks...); leave results unset for Awareness campaigns since the portal derives CPM from reach directly. For a Leads-objective ad set, also set adset.resultType to "messages" when its Meta conversion destination/optimization goal is Messenger/WhatsApp/Instagram DM (lead gen via conversation) rather than an Instant Form or website lead event — this is still the Leads objective in Meta\'s own model, just a different result metric (對話開始次數/cost per conversation started instead of 名單數/cost per lead). Leave resultType unset (defaults to form-based leads) for Instant Form or website-lead ad sets.',
      inputSchema: z.object({ clientId: z.string(), campaigns: z.array(campaignSchema) }),
    },
    async ({ clientId, campaigns }) => {
      const { ref, exists, data } = await loadClientDoc(clientId);
      if (!exists) {
        return { content: [{ type: 'text', text: '找唔到呢個client，請先用list_clients確認clientId。' }], isError: true };
      }
      data.campaigns = mergeCampaigns(data.campaigns || [], campaigns);
      await ref.set({ value: data });
      return {
        content: [
          { type: 'text', text: `已更新「${data.name}」，而家有 ${data.campaigns.length} 個行銷活動。` },
        ],
      };
    }
  );

  server.registerTool(
    'update_quota',
    {
      title: 'Update post quota',
      description:
        "Update a client's post quota for static, carousel, or reels post types. \"signed\" is the total quota. \"usedBaseline\" is a baseline offset added to however many posts[] calendar entries of that type already exist for this client -- the portal computes the displayed \"used\" count as usedBaseline + count(posts of that type), it is never stored as a plain number. Set usedBaseline to 0 to reset a client's usage back to whatever their posts[] calendar log alone accounts for.",
      inputSchema: z.object({
        clientId: z.string(),
        type: z.enum(['static', 'carousel', 'reels']),
        signed: z.number().optional(),
        usedBaseline: z.number().optional(),
      }),
    },
    async ({ clientId, type, signed, usedBaseline }) => {
      const { ref, exists, data } = await loadClientDoc(clientId);
      if (!exists) return { content: [{ type: 'text', text: '找唔到呢個client。' }], isError: true };
      data.quota = data.quota || {};
      data.quota[type] = data.quota[type] || { signed: 0, usedBaseline: 0 };
      if (signed !== undefined) data.quota[type].signed = signed;
      if (usedBaseline !== undefined) data.quota[type].usedBaseline = usedBaseline;
      await ref.set({ value: data });
      return { content: [{ type: 'text', text: `已更新「${data.name}」嘅${type}名額。` }] };
    }
  );
}, {});

function isAuthorized(req: Request): boolean {
  // Deliberately NOT using mcp-handler's withMcpAuth here: it advertises
  // RFC 9728 protected-resource metadata, which makes spec-compliant MCP
  // clients (including claude.ai's connector UI) attempt a full OAuth
  // dynamic-client-registration flow -- which fails, since there's no real
  // OAuth authorization server behind this endpoint. claude.ai's "Add
  // custom connector" dialog only has a URL field plus optional OAuth
  // Client ID/Secret (no plain bearer-token field), so the token is
  // embedded directly in the connector's configured URL as ?token=... and
  // checked here with a plain 401, no OAuth challenge advertised.
  const url = new URL(req.url);
  const authHeader = req.headers.get('authorization');
  const headerToken = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
  const token = headerToken || url.searchParams.get('token') || undefined;
  return !!token && !!process.env.MCP_AUTH_TOKEN && token === process.env.MCP_AUTH_TOKEN;
}

async function handler(req: Request): Promise<Response> {
  if (!isAuthorized(req)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  return mcpHandler(req);
}

export { handler as GET, handler as POST };
