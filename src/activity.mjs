const routes = new Map(Object.entries({
  'GET /': 'Opened studio',
  'GET /api/diagnostics': 'Checked dependencies',
  'GET /api/assets/:id/transcript': 'Read transcript',
  'GET /api/assets/:id/video': 'Requested source video',
  'GET /api/clips/:id/video': 'Requested clip preview',
  'POST /api/workspaces': 'Created workspace',
  'POST /api/upload': 'Uploaded video',
  'POST /api/uploads': 'Started video upload',
  'POST /api/uploads/:id/finish': 'Finished video upload',
  'POST /api/uploads/:id/cancel': 'Cancelled video upload',
  'POST /api/demo': 'Requested synthetic demo',
  'POST /api/import': 'Requested URL import',
  'POST /api/assets/:id/transcript': 'Edited transcript',
  'POST /api/assets/:id/transcribe': 'Requested transcription',
  'POST /api/assets/:id/analyze': 'Requested moment selection',
  'POST /api/clips': 'Created clip draft',
  'POST /api/clips/:id': 'Edited clip draft',
  'POST /api/clips/:id/render': 'Requested clip render',
  'POST /api/jobs/:id/cancel': 'Cancelled job',
  'POST /api/jobs/:id/dismiss-recovery': 'Dismissed import prompt',
  'POST /api/live': 'Started live capture',
  'POST /api/live/:id/stop': 'Stopped live capture',
  'POST /api/live/:id/cleanup': 'Cleaned up live buffers',
  'POST /api/settings': 'Changed studio settings',
  'POST /api/youtube-signin': 'Saved YouTube sign-in',
  'POST /api/youtube-signin/remove': 'Removed YouTube sign-in',
  'POST /api/youtube-signin/start': 'Opened YouTube sign-in window',
  'POST /api/youtube-signin/cancel': 'Cancelled YouTube sign-in window',
  'POST /api/accounts': 'Added publishing account',
  'POST /api/accounts/:id': 'Changed publishing account',
  'POST /api/accounts/:id/verify': 'Verified publishing account',
  'POST /api/publications': 'Queued publication',
  'POST /api/publications/:id/cancel': 'Cancelled publication',
  'POST /api/publications/:id/reconcile': 'Checked publication status',
  'POST /api/publications/:id/resolve': 'Recorded publication outcome',
  'POST /api/shutdown': 'Requested studio shutdown',
  'POST /api/remote/control': 'Changed remote sharing',
}));
export const isResourceId = s => typeof s === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(s);
export function auditRequest(method, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const resource = isResourceId(parts[2]) ? parts[2] : null;
  const path = '/' + parts.map((p, i) => i === 2 && resource ? ':id' : p).join('/');
  // Polls, static assets and chunk transport aren't separate user actions. No request bodies,
  // arbitrary URLs, query strings, filenames, secrets or response bodies go into Activity.
  if (method === 'POST' && path === '/api/uploads/:id/piece') return null;
  const action = method === 'GET' && path === '/api/clips/:id/video' && url.searchParams.has('download')
    ? 'Requested clip download' : routes.get(`${method} ${path}`) ?? (method === 'POST' ? 'Other studio request' : null);
  return action ? { action, resource } : null;
}
