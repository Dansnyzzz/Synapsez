import { relayAnswer } from '../server/finance/relay.js';

/**
 * The one function that runs in Singapore (vercel.json: regions sin1): it asks Vietcap
 * — which turns away US addresses — for the app's functions in iad1. Nothing else: the
 * rules are in server/finance/relay.js.
 */
export default async function handler(req, res) {
  const url = new URL(req.url || '/', 'http://relay.local').searchParams.get('url') || '';
  const answer = await relayAnswer({ method: req.method, url, authorization: req.headers.authorization, ua: req.headers['x-relay-ua'] });
  res.statusCode = answer.status;
  for (const [name, value] of Object.entries(answer.headers)) res.setHeader(name, value);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Relay-Region', process.env.VERCEL_REGION || 'local');
  res.end(answer.body);
}
