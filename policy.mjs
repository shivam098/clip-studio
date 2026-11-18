export const pagesOrigin = 'https://shivam098.github.io';
export const pagesUrl = pagesOrigin + '/clip-studio/';
export const beacon = '/.well-known/clip-studio';
export const service = 'clip-studio-full-v1';
export const leaseMs = 6 * 60 * 60 * 1000;
export const offline = Object.freeze({ version: 2, status: 'offline' });
export const isInstance = s => typeof s === 'string' && /^[a-f0-9]{32}$/.test(s);
export const isQuickOrigin = s => typeof s === 'string' &&
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/.test(s);

export function destination(record, now = Date.now()) {
  if (record?.version !== 2) throw new Error('Unrecognized full-studio launcher record.');
  if (record.status === 'offline') return null;
  if (record.status !== 'online' || !isQuickOrigin(record.origin) || !isInstance(record.instance) ||
      !Number.isSafeInteger(record.issuedAt) || !Number.isSafeInteger(record.expiresAt) ||
      record.issuedAt > now + 60_000 || record.expiresAt <= now || record.expiresAt <= record.issuedAt ||
      record.expiresAt - record.issuedAt > leaseMs) throw new Error('Invalid or expired full-studio address.');
  return record.origin;
}

export async function verifyBeacon(origin, instance, fetcher = fetch) {
  if (!isQuickOrigin(origin) || !isInstance(instance)) throw new Error('Invalid remote binding.');
  const res = await fetcher(`${origin}${beacon}?t=${Date.now()}`, { credentials: 'omit', cache: 'no-store',
    referrerPolicy: 'no-referrer', redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (res.status !== 200 || !res.headers.get('content-type')?.startsWith('application/json')) {
    await res.body?.cancel(); throw new Error('The studio is not reachable.');
  }
  const reader = res.body.getReader(), chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 512) { await reader.cancel(); throw new Error('Unexpected availability response.'); }
    chunks.push(...value);
  }
  const record = JSON.parse(new TextDecoder().decode(new Uint8Array(chunks)));
  if (record.service !== service || record.instance !== instance) throw new Error('The address does not match this full studio.');
}
