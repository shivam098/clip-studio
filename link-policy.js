export const pagesOrigin = 'https://shivam098.github.io';
export const healthPath = '/health';
export const signature = Object.freeze({ service: 'clip-studio-public-editor-v1', mode: 'browser-only' });
export const leaseMs = 6 * 60 * 60 * 1000;

export function isQuickOrigin(value) {
  if (typeof value !== 'string' || value.length > 100) return false;
  const match = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/.exec(value);
  return match !== null && match[0] === value;
}

function hasKeys(object, keys) {
  return object !== null && typeof object === 'object' && !Array.isArray(object) &&
    Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
}

export function isEditor(value) {
  return hasKeys(value, ['service', 'mode']) && value.service === signature.service && value.mode === signature.mode;
}

export function destination(pointer, now = Date.now()) {
  if (hasKeys(pointer, ['version', 'status']) && pointer.version === 1 && pointer.status === 'offline') return null;
  if (!hasKeys(pointer, ['version', 'status', 'origin', 'issuedAt', 'expiresAt']) ||
      pointer.version !== 1 || pointer.status !== 'online' || !isQuickOrigin(pointer.origin)) {
    throw new Error('Unrecognized launcher record.');
  }
  const { issuedAt, expiresAt } = pointer;
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) ||
      issuedAt > now || expiresAt <= now || expiresAt - issuedAt > leaseMs) {
    throw new Error('The launcher record is stale or not valid yet.');
  }
  return pointer.origin;
}

export async function readSmallJson(url, { signal, headers, acceptHeaders } = {}) {
  const limit = 1024;
  const response = await fetch(url, {
    method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error',
    referrerPolicy: 'no-referrer', signal, headers,
  });
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '') ||
      Number(response.headers.get('content-length')) > limit || !response.body?.getReader ||
      (acceptHeaders && !acceptHeaders(response.headers))) {
    await response.body?.cancel();
    throw new Error('Expected a small JSON document.');
  }
  const reader = response.body.getReader();
  const buffer = new Uint8Array(limit);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > limit) {
        await reader.cancel();
        throw new Error('Document too large.');
      }
      buffer.set(value, length);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
}
