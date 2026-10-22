// One Google SERP purchase example. Default: free preview, no wallet needed.
import { openSync, closeSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { createx402MCPClient } from '@x402/mcp';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export function paymentGuard({ network, asset, merchant, amount, resource, onAuthorize }) {
  let used = false;
  return async ({ selectedRequirements: r, paymentRequired }) => {
    if (used || r.scheme !== 'exact' || r.network !== network ||
        r.asset.toLowerCase() !== asset.toLowerCase() ||
        r.payTo.toLowerCase() !== merchant.toLowerCase() || r.amount !== amount ||
        paymentRequired.resource?.url !== resource) throw Error('Payment terms changed or repeated authorization');
    used = true;
    onAuthorize();
  };
}

export async function runBuyer(options = {}) {
  const baseUrl = options.baseUrl ?? 'https://agent.chiemgaufilms.com';
  const network = options.network ?? 'eip155:8453';
  const asset = options.asset ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const merchant = options.merchant ?? process.env.MERCHANT_ADDRESS;
  const approval = options.approval ?? process.env.APPROVE_USDC ?? '0';
  const protocol = options.protocol ?? (process.argv.includes('--mcp') ? 'mcp' : 'rest');
  const journal = options.journal ?? 'agent-api-purchase.json';
  const fetchImpl = options.fetchImpl ?? fetch;
  const request = { keyword: 'running shoes', location_code: 2840, language_code: 'en' };
  const post = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), redirect: 'error' };
  const get = async (path, init) => {
    const response = await fetchImpl(baseUrl + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(150000) });
    const body = await response.json();
    if (!response.ok) throw Error('Free catalog or preflight unavailable');
    return body;
  };
  const catalog = await get('/api/v1/services');
  const service = catalog.services.find(s => s.id === 'google-serp' && s.enabled);
  if (!service || catalog.network !== network || catalog.data_source !== 'live' ||
      catalog.payments !== (network === 'eip155:8453' ? 'mainnet' : 'testnet')) throw Error('Unexpected server mode');
  const preflight = await get('/api/v1/preflight/google-serp', post);
  if (!preflight.ok || preflight.price_usdc !== service.price_usdc) throw Error('Input or quote changed');
  const preview = { service: service.id, price_usdc: service.price_usdc, network, input: request, protocol };
  if (approval === '0') return { preview, paid: false };
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(approval) ||
      parseUnits(service.price_usdc, 6) > parseUnits(approval, 6) ||
      !/^0x[0-9a-fA-F]{40}$/.test(merchant ?? '')) throw Error('Missing or insufficient explicit approval / merchant address');
  const key = options.key ?? process.env.BUYER_PRIVATE_KEY;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw Error('Set the buyer key locally');
  const signer = privateKeyToAccount(key);
  closeSync(openSync(journal, 'wx', 0o600)); // Existing attempts must be resolved, never silently bought again.
  let state = { status: 'prepared', ...preview };
  const save = () => writeFileSync(journal, JSON.stringify(state, null, 2), { mode: 0o600 });
  save();
  const guard = paymentGuard({ network, asset, merchant, amount: parseUnits(service.price_usdc, 6).toString(),
    resource: options.resourceUrl ?? (protocol === 'mcp' ? 'mcp://tool/google_serp' : baseUrl + service.path),
    onAuthorize: () => { state.status = 'authorization_started'; save(); } });
  try {
    let result;
    if (protocol === 'mcp') {
      const client = createx402MCPClient({ name: 'single-purchase-example', version: '1.0.0',
        schemes: [{ network, client: new ExactEvmScheme(signer) }],
        spendControls: { maxAmountPerPayment: '$' + approval }, autoPayment: true });
      client.paymentClient.onBeforePaymentCreation(guard);
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl + '/mcp'), { requestInit: { redirect: 'error' } }));
        const out = await client.callTool('google_serp', request);
        result = { isError: out.isError ?? false, content: out.content, paymentResponse: out.paymentResponse };
      } finally { await client.close().catch(() => {}); }
    } else {
      const client = new x402Client().register(network, new ExactEvmScheme(signer));
      client.setSpendControls({ maxAmountPerPayment: '$' + approval });
      client.onBeforePaymentCreation(guard);
      let sent = false;
      const dispatch = async (input, init) => {
        const req = new Request(input, init);
        if (req.url !== baseUrl + service.path || req.method !== 'POST' || await req.clone().text() !== post.body) throw Error('Unexpected request');
        if (req.headers.has('payment-signature')) {
          if (sent) throw Error('Repeated signed dispatch');
          sent = true;
        }
        return fetchImpl(req, { redirect: 'error', signal: AbortSignal.timeout(150000) });
      };
      const response = await wrapFetchWithPayment(dispatch, client)(baseUrl + service.path, post);
      result = { http_status: response.status, body: await response.json() };
    }
    const body = protocol === 'mcp' ? (() => { try { return JSON.parse(result.content[0].text); } catch { return null; } })() : result.body;
    const delivered = body?.data_source === 'live' && typeof body?.request_id === 'string' && (protocol === 'mcp' ? !result.isError && result.paymentResponse?.success === true : result.http_status === 200);
    state = { ...state, status: delivered ? 'delivered' : 'response_requires_review', result }; save();
    return { saved_to: journal, status: state.status }; // Result tokens remain in the private file.
  } catch {
    state.status = 'stopped_check_payment_before_retry'; save();
    throw Error('Stopped. Inspect the saved attempt and payment before any new purchase.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBuyer().then(out => console.log(JSON.stringify(out, null, 2))).catch(() => {
    console.error('Stopped without automatic retry. Check agent-api-purchase.json if it exists.');
    process.exitCode = 1;
  });
}
