// Free MCP connection check. No wallet, payment SDK or paid tool is used.
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function readResult(result) {
  if (result.isError) throw new Error('Free MCP tool returned an error');
  if (result.structuredContent) return result.structuredContent;
  const item = result.content?.find(block => block.type === 'text');
  if (!item) throw new Error('Missing MCP tool result');
  return JSON.parse(item.text);
}

export async function checkConnection(endpoint = 'https://agent.chiemgaufilms.com/mcp', { fetchImpl = fetch } = {}) {
  const url = new URL(endpoint);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/mcp') {
    throw new Error('Use an HTTPS /mcp URL without credentials or query; HTTP is allowed only on localhost');
  }
  const deadline = AbortSignal.timeout(20000);
  const guardedFetch = (input, init = {}) => fetchImpl(input, {
    ...init,
    redirect: 'error',
    signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
  });
  const client = new Client({ name: 'agent-api-free-check', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { fetch: guardedFetch }));
    const { tools } = await client.listTools();
    for (const name of ['list_services', 'preflight']) {
      if (!tools.some(tool => tool.name === name)) throw new Error('Required free MCP tools are missing');
    }
    const catalog = readResult(await client.callTool({ name: 'list_services', arguments: {} }));
    const service = catalog.services?.find(item => item.id === 'google-serp' && item.enabled);
    if (!service) throw new Error('Google SERP is unavailable; stop before any purchase');
    const preflight = readResult(await client.callTool({
      name: 'preflight',
      arguments: { service: 'google-serp', input: { keyword: 'running shoes', location_code: 2840, language_code: 'en' } },
    }));
    if (preflight.ok !== true || preflight.service !== service.id || preflight.price_usdc !== service.price_usdc) {
      throw new Error('Free preflight failed or price changed');
    }
    return {
      connected: true,
      tools: tools.length,
      services: catalog.services.length,
      network: catalog.network,
      data_source: catalog.data_source,
      preflight: { ok: true, service: service.id, price_usdc: preflight.price_usdc },
      paid: false,
    };
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await checkConnection(process.argv[2]), null, 2));
  } catch {
    console.error('MCP check failed. Verify the URL, network, server status and free tool availability. No payment was attempted.');
    process.exitCode = 1;
  }
}
