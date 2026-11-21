const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const seconds = value => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
let state, workspaceId, assetId, editingClip = null, lastSuggestions = '', transcriptSignature = '', refreshBusy = false;
let pendingRecovery = null, submittedImport = null;
const markup = new Map();
function setMarkup(selector, html) {
  if (markup.get(selector) !== html) { $(selector).innerHTML = html; markup.set(selector, html); }
}
function notify(message, error = false) {
  $('#notice').textContent = message;
  $('#notice').classList.toggle('error', error);
}
async function api(path, data, method = 'POST') {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Studio-Token': state?.token ?? '' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(data ?? {}) }) });
  if (response.status === 401 && state?.access?.remote) {
    location.replace('/'); throw new Error('Your sign-in expired.');
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
  return result;
}
function action(selector, operation, event = 'click') {
  $(selector).addEventListener(event, async e => {
    e.preventDefault();
    const target = e.submitter ?? e.currentTarget;
    if ('disabled' in target) target.disabled = true;
    try { await operation(e); await refresh(); }
    catch (error) { notify(error.message, true); }
    finally { if ('disabled' in target) target.disabled = false; }
  });
}
function captionText(segments) { return segments.map(s => `${s.start.toFixed(2)} | ${s.end.toFixed(2)} | ${s.text}`).join('\n'); }
function parseCaptions(value) {
  return value.split('\n').filter(line => line.trim()).map((line, index) => {
    const [start, end, ...text] = line.split('|');
    if (text.length === 0 || !Number.isFinite(Number(start)) || !Number.isFinite(Number(end))) throw new Error(`Caption line ${index + 1}: use start | end | text`);
    return { start: Number(start), end: Number(end), text: text.join('|').trim() };
  });
}
function selectOptions(selector, rows, label) {
  const element = $(selector), previous = element.value;
  setMarkup(selector, rows.map(row => `<option value="${escape(row.id)}">${escape(label(row))}</option>`).join(''));
  if (rows.some(row => row.id === previous)) element.value = previous;
}
function tab(name) {
  document.querySelectorAll('.page').forEach(page => page.classList.toggle('hidden', page.id !== name));
  document.querySelectorAll('.nav').forEach(button => button.classList.toggle('active', button.dataset.tab === name));
}
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => tab(button.dataset.tab)));
$('#source-preview').addEventListener('error', () => notify('The browser cannot play this source format. You can still select timestamps and render a browser-compatible H.264 MP4.', true));
async function selectAsset(selectedId) {
  assetId = selectedId; editingClip = null;
  const asset = state.assets.find(a => a.id === assetId);
  if (!asset) return;
  $('#editor').classList.remove('hidden');
  $('#source-preview').src = `/api/assets/${assetId}/video`;
  $('#source-name').textContent = asset.name;
  $('#source-info').textContent = `${asset.width} × ${asset.height} · ${seconds(asset.duration)}`;
  const transcript = await api(`/api/assets/${assetId}/transcript`, null, 'GET');
  if (assetId !== selectedId || workspaceId !== asset.workspace_id) return;
  $('#transcript').value = captionText(transcript.segments);
  $('#transcript-source').textContent = transcript.source;
  transcriptSignature = transcriptStamp();
  newDraft();
  lastSuggestions = '';
  draw();
}
function transcriptStamp() {
  return state.jobs.filter(j => j.resource_id === assetId && j.type === 'transcribe' && j.state === 'succeeded').map(j => j.id).join(',');
}
function newDraft() {
  const asset = state.assets.find(a => a.id === assetId);
  if (!asset) return;
  editingClip = null;
  $('#clip-mode').textContent = 'New clip';
  $('#clip-name').value = 'My first clip';
  $('#clip-start').value = 0;
  $('#clip-end').value = Math.min(30, asset.duration).toFixed(2);
  $('#clip-hook').value = '';
  $('#clip-framing').value = 'fit';
  $('#clip-captions').value = $('#transcript').value;
}
function privacyOptions() {
  const account = state.accounts.find(a => a.id === $('#publish-account').value);
  const options = account?.platform === 'youtube' ? ['private','unlisted','public']
    : account?.platform === 'instagram' ? ['public']
    : ['SELF_ONLY','PUBLIC_TO_EVERYONE','MUTUAL_FOLLOW_FRIENDS','FOLLOWER_OF_CREATOR'];
  setMarkup('#publish-privacy', '<option value="">Select visibility</option>' + options.map(option => `<option>${option}</option>`).join(''));
}
function draw() {
  $('#remote-session').classList.toggle('hidden', !state.access.remote);
  $('#session-email').textContent = state.access.email ?? '';
  selectOptions('#workspace', state.workspaces, w => w.name);
  $('#workspace').value = workspaceId;
  const recoveries = state.jobs.filter(job => job.resource_id === workspaceId && job.recovery);
  const workspaceName = state.workspaces.find(w => w.id === workspaceId)?.name;
  const youtubeSignin = state.settings.youtubeSignin, signinWindow = youtubeSignin.window ?? { state: 'idle' };
  const windowOpen = ['opening', 'waiting'].includes(signinWindow.state);
  setMarkup('#import-recoveries', recoveries.map(job => {
    const signedInSince = youtubeSignin.configured && youtubeSignin.updated > (job.finished ?? job.created);
    const advice = signedInSince ? (job.recovery.watchUrl ? 'You have signed in to YouTube since this import failed. Import the video again.'
      : 'You have signed in to YouTube since this import failed. Paste the link in Import from a link again.')
      : job.recovery.signedIn ? 'YouTube refused the saved sign-in; it may have expired. Sign in to YouTube again, then import the video again.'
      : 'YouTube refuses downloads from this cloud PC without a signed-in YouTube account. Sign in to YouTube, then import the video again.';
    const next = signedInSince ? (job.recovery.watchUrl ? `<button type="button" data-reimport="${escape(job.id)}">Import again</button>` : '')
      : `<button type="button" data-youtube-signin="1"${windowOpen ? ' disabled' : ''}>Sign in to YouTube</button>`;
    return `<article class="warning" aria-label="Blocked YouTube import">
    <h3>${signedInSince ? 'Ready to import again' : job.recovery.signedIn ? 'YouTube did not accept the saved sign-in' : 'YouTube needs a sign-in'}</h3>
    <p>Import into <strong>${escape(workspaceName)}</strong> at ${escape(new Date(job.created).toLocaleString())}.</p>
    <p>${advice}${windowOpen ? ` A ${escape(signinWindow.browser)} sign-in window is open on the studio PC's screen.` : ''}</p>
    <p>Or choose a local video file you have permission to use. It will be added to this workspace.</p>
    <div class="button-row">${next}
    <button type="button" class="secondary" data-recovery-file="${escape(job.id)}">Choose a video file</button>
    <button type="button" class="quiet" data-recovery-dismiss="${escape(job.id)}">Dismiss</button></div>
  </article>`;
  }).join(''));
  if (recoveries.some(job => job.id === submittedImport)) {
    submittedImport = null;
    notify('YouTube needs a sign-in for this import. See the options under Source library.');
  }
  $('#youtube-signin-start').classList.toggle('hidden', windowOpen);
  $('#youtube-signin-cancel').classList.toggle('hidden', !windowOpen);
  $('#youtube-signin-status').textContent = windowOpen
    ? `A ${signinWindow.browser} window is open on the studio PC's screen. Sign in to YouTube there; Clip Studio saves the sign-in and closes the window by itself.`
    : [['failed', 'cancelled', 'saved'].includes(signinWindow.state) ? signinWindow.message : '',
      youtubeSignin.configured ? `Signed in: ${youtubeSignin.cookies} youtube.com cookies saved ${new Date(youtubeSignin.updated).toLocaleString()}.`
        : 'Not signed in to YouTube.'].filter(Boolean).join(' ');
  const assets = state.assets.filter(a => a.workspace_id === workspaceId);
  const clips = state.clips.filter(c => assets.some(a => a.id === c.asset_id));
  setMarkup('#assets', assets.map(a => `<button class="asset ${a.id === assetId ? 'active' : ''}" data-asset="${a.id}"><span class="asset-icon">▶</span><strong>${escape(a.name)}</strong><small>${seconds(a.duration)} · ${a.width} × ${a.height}${a.audio ? ' · audio' : ' · silent'}</small></button>`).join(''));
  $('#empty-library').classList.toggle('hidden', assets.length > 0);
  setMarkup('#clips', clips.map(c => `<article class="panel clip-card">${c.rendered ? `<video controls preload="metadata" src="/api/clips/${c.id}/video"></video>` : '<div class="empty">Draft · not rendered</div>'}<h3>${escape(c.name)}</h3><p>${seconds(c.start)} → ${seconds(c.end)} · ${escape(c.framing)} · revision ${c.revision}</p><div class="button-row"><button class="secondary" data-edit="${c.id}">Edit</button><button data-render="${c.id}">Render 9:16</button>${c.rendered ? `<a href="/api/clips/${c.id}/video?download" download>Download MP4</a>` : ''}</div></article>`).join(''));
  const analysis = state.jobs.find(j => j.type === 'analyze' && j.resource_id === assetId && j.state === 'succeeded');
  if (analysis?.id !== lastSuggestions) {
    lastSuggestions = analysis?.id;
    setMarkup('#suggestions', analysis ? `<p class="muted">${escape(analysis.result.method)}</p>${analysis.result.moments.map((m, i) => `<div class="moment"><button class="secondary" data-moment="${i}" data-analysis="${analysis.id}">${seconds(m.start)}–${seconds(m.end)} · ${escape(m.title)}</button><p>${escape(m.reason)}</p></div>`).join('')}` : '');
  }
  setMarkup('#jobs', state.jobs.slice(0, 12).map(j => `<div class="list-row"><div><strong>${escape(j.type)} <span class="state ${escape(j.state)}">${escape(j.state)}</span></strong><p>${escape(j.actor ?? 'Attribution not recorded')} · ${escape(j.error ?? (j.state === 'running' ? 'Working locally; you can keep editing.' : new Date(j.created).toLocaleTimeString()))}</p></div>${['queued','running'].includes(j.state) ? `<button class="danger" data-cancel="${j.id}">Cancel</button>` : ''}</div>`).join('') || '<p class="muted">No jobs yet. Your next step is above.</p>');
  setMarkup('#activity', state.activity.map(a => `<div class="list-row"><div><strong>${escape(a.action)}</strong>
    <p>${escape(a.email ?? 'This PC')} · ${escape(new Date(a.created).toLocaleString())} · ${a.status == null ? 'In progress' : a.status === 0 ? 'Interrupted' : a.status >= 400 ? `Not completed (${a.status})` : 'OK'}${a.resource ? ` · ${escape(a.resource)}` : ''}</p>
    </div></div>`).join('') || '<p class="muted">No actions recorded yet.</p>');
  setMarkup('#live-list', state.live.filter(s => s.workspace_id === workspaceId).map(s => `<div class="list-row"><div><strong>${escape(s.name)} <span class="state">${escape(s.state)}</span></strong><p>${state.segments.filter(segment => segment.session_id === s.id).length} completed buffers in library. ${escape(s.error ?? '')}</p></div><div class="buttons">${s.state === 'recording' ? `<button class="danger" data-live-stop="${s.id}">Stop capture</button>` : `<button class="secondary" data-cleanup="${s.id}">Delete unused buffers</button>`}<button class="secondary" data-latest="${s.id}">Review latest segment</button></div></div>`).join(''));
  $('#publishing-toggle').textContent = state.settings.publishingEnabled ? 'Pause dispatch' : 'Enable dispatch';
  setMarkup('#accounts', state.accounts.map(a => `<div class="list-row"><div><strong>${escape(a.name)} · ${escape(a.platform)}</strong><p>${a.verified ? `Verified: ${escape(a.display_name)} · ${escape(a.remote_id)}` : 'Identity not verified'}</p><p>${a.enabled ? 'Enabled' : 'Disabled'} · ${a.spacing / 60} min spacing · ${a.daily_cap} per rolling 24h · token ${a.credential ? 'saved' : 'missing'}</p></div><div class="buttons"><button class="secondary" data-account-verify="${a.id}">Verify account</button><button class="secondary" data-account-toggle="${a.id}">${a.enabled ? 'Disable' : 'Enable'}</button><button class="secondary" data-account-limits="${a.id}">Edit limits</button><button class="secondary" data-account-token="${a.id}">Replace token</button></div></div>`).join(''));
  selectOptions('#publish-clip', clips.filter(c => c.rendered), c => c.name);
  selectOptions('#publish-account', state.accounts.filter(a => a.verified), a => `${a.name} · ${a.display_name} (${a.remote_id}) · ${a.platform}`);
  privacyOptions();
  setMarkup('#publications', state.publications.map(p => `<div class="list-row"><div><strong>${escape(p.metadata.title)} <span class="state ${escape(p.state)}">${escape(p.state)}</span></strong><p>${escape(state.accounts.find(a => a.id === p.account_id)?.name)} · earliest ${new Date(p.scheduled).toLocaleString()} · ${escape(p.metadata.privacy)}</p><p>${escape(p.error ?? p.result?.message ?? '')}</p><p class="muted">Provider phase: ${escape(p.provider_ref.phase ?? 'not started')} ${p.provider_ref.id ? `· ID ${escape(p.provider_ref.id)}` : ''}${p.provider_ref.hasSession ? ' · resumable session saved privately' : ''}</p></div><div class="buttons">${['scheduled','dispatching'].includes(p.state) ? `<button class="danger" data-publish-cancel="${p.id}">Cancel</button>` : ''}${['uncertain','processing'].includes(p.state) ? `<button class="secondary" data-reconcile="${p.id}">Check provider status</button><button class="secondary" data-resolve="${p.id}">Record manual outcome</button>` : ''}</div></div>`).join(''));
  $('#runtime').textContent = `Storage: ${state.settings.storage}\nSpeech model: ${state.settings.model}\nCredentials: ${state.settings.secrets}`;
}
async function refresh() {
  if (refreshBusy) return;
  refreshBusy = true;
  try {
    state = await api('/api/state', null, 'GET');
    workspaceId ??= state.workspaces[0]?.id;
    draw();
    if (assetId && transcriptStamp() !== transcriptSignature) {
      const transcript = await api(`/api/assets/${assetId}/transcript`, null, 'GET');
      $('#transcript').value = captionText(transcript.segments);
      $('#transcript-source').textContent = transcript.source;
      if (!editingClip && !$('#clip-captions').value) $('#clip-captions').value = captionText(transcript.segments);
      transcriptSignature = transcriptStamp();
    }
    $('#connection').textContent = state.access.remote ? 'Studio PC connected' : 'Local server connected';
  } catch (error) { $('#connection').textContent = 'Disconnected'; notify(error.message, true); }
  finally { refreshBusy = false; }
}
action('#workspace', async () => {
  workspaceId = $('#workspace').value; assetId = null; editingClip = null;
  $('#editor').classList.add('hidden');
}, 'change');
action('#new-workspace', async () => $('#workspace-dialog').showModal());
action('#dismiss-workspace', async () => $('#workspace-dialog').close());
action('#workspace-form', async () => {
  const result = await api('/api/workspaces', { name: $('#workspace-name').value, creator: $('#creator-name').value });
  workspaceId = result.id; assetId = null; $('#editor').classList.add('hidden'); $('#workspace-dialog').close();
}, 'submit');
async function uploadFile(file, destination, recoveryId) {
  if (!file) throw new Error('Choose a video');
  notify('Uploading to your studio…');
  const params = new URLSearchParams({ workspace: destination, name: file.name });
  if (recoveryId) params.set('recovery', recoveryId);
  const headers = { 'X-Studio-Token': state.token, 'Content-Type': 'application/octet-stream' };
  let result;
  if (state.access.remote && file.size > 8 * 1024 ** 2) {
    const upload = await api('/api/uploads', { workspace: destination, name: file.name, size: file.size, recovery: recoveryId });
    const url = `/api/uploads/${upload.id}`;
    try {
      for (let offset = 0; offset < file.size;) {
        const end = Math.min(file.size, offset + upload.chunkSize);
        const response = await fetch(`${url}/piece?offset=${offset}`, { method: 'POST', headers, body: file.slice(offset,end) });
        const ack = await response.json();
        if (!response.ok || ack.offset !== end) throw new Error(ack.error ?? 'Upload piece was not acknowledged.');
        offset = end; notify(`Uploading to your studio: ${Math.floor(100 * end / file.size)}%`);
      }
      result = await api(`${url}/finish`);
    } catch (error) {
      try { await api(`${url}/cancel`); } catch { /* Already finalized, or unreachable; partials expire. */ }
      throw error;
    }
  } else {
    const response = await fetch(`/api/upload?${params}`, { method: 'POST', headers, body: file });
    result = await response.json();
    if (!response.ok) throw new Error(result.error);
  }
  await refresh();
  if (workspaceId === destination && state.assets.some(asset => asset.id === result.id)) await selectAsset(result.id);
  notify(`Video added to ${state.workspaces.find(w => w.id === destination)?.name ?? 'the original workspace'}.`);
}
action('#upload-form', () => uploadFile($('#video-file').files[0], workspaceId), 'submit');
action('#recovery-file', async event => {
  const job = pendingRecovery, file = event.target.files[0];
  pendingRecovery = null;
  if (job && file) await uploadFile(file, job.resource_id, job.id);
}, 'change');
$('#recovery-file').addEventListener('cancel', () => { pendingRecovery = null; });
action('#url-form', async () => {
  const result = await api('/api/import', { workspaceId, url: $('#source-url').value, networkConsent: $('#url-consent').checked });
  submittedImport = result.jobId;
  notify('Import queued. See Activity for the result.');
}, 'submit');
action('#demo', async () => { await api('/api/demo', { workspaceId }); notify('Creating synthetic video and local speech. It will appear in your library.'); });
action('#transcribe', async () => { await api(`/api/assets/${assetId}/transcribe`); notify('Offline transcription started. You can continue selecting clips.'); });
action('#heuristic', async () => { await api(`/api/assets/${assetId}/analyze`, { method: 'heuristic' }); notify('Selecting review windows with local text rules, not AI.'); });
action('#model-analysis', async () => { await api(`/api/assets/${assetId}/analyze`, { method: 'model', networkConsent: $('#model-consent').checked }); $('#model-consent').checked = false; notify('Model analysis started.'); });
action('#save-transcript', async () => { await api(`/api/assets/${assetId}/transcript`, { segments: parseCaptions($('#transcript').value) }); notify('Transcript saved. Existing clip captions are unchanged; copy edits into the clip if needed.'); });
action('#new-clip', async () => newDraft());
action('#set-start', async () => { $('#clip-start').value = $('#source-preview').currentTime.toFixed(2); });
action('#set-end', async () => { $('#clip-end').value = $('#source-preview').currentTime.toFixed(2); });
action('#clip-form', async () => {
  const result = await api(`/api/clips${editingClip ? `/${editingClip.id}` : ''}`, {
    assetId, revision: editingClip?.revision, name: $('#clip-name').value, start: Number($('#clip-start').value),
    end: Number($('#clip-end').value), hook: $('#clip-hook').value, framing: $('#clip-framing').value,
    captions: parseCaptions($('#clip-captions').value),
  });
  await refresh(); editingClip = state.clips.find(c => c.id === result.id);
  $('#clip-mode').textContent = `Editing: ${editingClip.name}`;
  notify('Clip draft saved. Choose Render 9:16 on the clip desk to create the MP4.');
}, 'submit');
action('#live-form', async () => { await api('/api/live', { workspaceId, name: $('#live-name').value, url: $('#live-url').value, networkConsent: $('#live-consent').checked }); notify('Capture started. Completed buffers will appear in the library.'); }, 'submit');
action('#synthetic-live', async () => { await api('/api/live', { workspaceId, name: 'Synthetic live test', synthetic: true }); notify('45-second synthetic feed started locally. No network source contacted.'); });
action('#publishing-toggle', async () => { await api('/api/settings', { publishingEnabled: !state.settings.publishingEnabled }); notify(state.settings.publishingEnabled ? 'Dispatch paused. Already-started operations require individual cancellation and reconciliation.' : 'Dispatch enabled for approved posts and enabled accounts.'); });
action('#account-platform', async () => $('#instagram-fields').classList.toggle('hidden', $('#account-platform').value !== 'instagram'), 'change');
action('#account-form', async () => {
  await api('/api/accounts', { platform: $('#account-platform').value, name: $('#account-name').value, token: $('#account-token').value,
    userId: $('#instagram-id').value, version: $('#instagram-version').value,
    spacing: Number($('#spacing').value) * 60, dailyCap: Number($('#daily-cap').value) });
  $('#account-token').value = ''; notify('Account saved disabled. Enable it only when ready for approved posts.');
}, 'submit');
action('#publish-account', async () => privacyOptions(), 'change');
action('#publish-form', async () => {
  await api('/api/publications', { clipId: $('#publish-clip').value, accountId: $('#publish-account').value,
    title: $('#publish-title').value, description: $('#publish-description').value, privacy: $('#publish-privacy').value,
    madeForKids: $('#made-for-kids').checked, scheduled: $('#publish-time').value ? new Date($('#publish-time').value).getTime() : null,
    approved: $('#publish-consent').checked });
  $('#publish-consent').checked = false; notify('Approval and immutable rendered-file selection saved before dispatch.');
}, 'submit');
action('#ai-form', async () => {
  await api('/api/settings', { ai: { endpoint: $('#ai-endpoint').value, model: $('#ai-model').value, token: $('#ai-token').value, enabled: $('#ai-enabled').checked },
    networkConsent: $('#ai-consent').checked });
  $('#ai-token').value = ''; notify('Model configuration saved. No transcript was sent.');
}, 'submit');
action('#diagnostics', async () => { $('#diagnostic-result').textContent = JSON.stringify(await api('/api/diagnostics', null, 'GET'), null, 2); });
action('#youtube-signin-form', async () => {
  const file = $('#youtube-cookies').files[0];
  if (!file) throw new Error('Choose the cookies.txt file you exported');
  if (file.size > 1_000_000) throw new Error('Choose a cookies.txt file of up to 1 MB');
  const result = await api('/api/youtube-signin', { cookies: await file.text() });
  $('#youtube-cookies').value = '';
  notify(`YouTube sign-in saved (${result.cookies} youtube.com cookies). Import your YouTube link again.`);
}, 'submit');
async function startYouTubeSignin() {
  const result = await api('/api/youtube-signin/start');
  if (result.state === 'failed') throw new Error(result.message);
  notify(`A ${result.browser} window is opening on the studio PC's screen. Sign in to YouTube there; Clip Studio saves the sign-in by itself.`);
}
action('#youtube-signin-start', startYouTubeSignin);
action('#youtube-signin-cancel', async () => {
  await api('/api/youtube-signin/cancel');
  notify('YouTube sign-in cancelled. The window was closed.');
});
action('#youtube-signin-remove', async () => {
  await api('/api/youtube-signin/remove');
  notify('YouTube sign-in removed. YouTube imports from this PC will ask for one again.');
});
action('#remote-logout', async () => { await api('/auth/logout'); location.replace('/'); });
document.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  const d = button.dataset;
  if (!Object.keys(d).length || d.tab) return;
  button.disabled = true;
  try {
    if (d.youtubeSignin) await startYouTubeSignin();
    if (d.reimport) {
      const job = state.jobs.find(j => j.id === d.reimport && j.recovery?.watchUrl);
      if (!job) throw new Error('This import is no longer available');
      const result = await api('/api/import', { workspaceId: job.resource_id, url: job.recovery.watchUrl, networkConsent: true });
      await api(`/api/jobs/${job.id}/dismiss-recovery`);
      submittedImport = result.jobId;
      notify('Importing again with your YouTube sign-in. See Activity for the result.');
    }
    if (d.recoveryFile) {
      const job = state.jobs.find(j => j.id === d.recoveryFile && j.resource_id === workspaceId && j.recovery);
      if (!job) throw new Error('This import is no longer waiting for a file');
      const picker = $('#recovery-file');
      if (picker.disabled) throw new Error('Another recovery upload is in progress');
      pendingRecovery = job;
      picker.value = '';
      picker.click();
      return;
    }
    if (d.recoveryDismiss) await api(`/api/jobs/${d.recoveryDismiss}/dismiss-recovery`);
    if (d.asset) await selectAsset(d.asset);
    if (d.edit) {
      const clip = state.clips.find(c => c.id === d.edit);
      await selectAsset(clip.asset_id); editingClip = clip;
      $('#clip-mode').textContent = `Editing: ${clip.name}`;
      $('#clip-name').value = clip.name; $('#clip-start').value = clip.start; $('#clip-end').value = clip.end;
      $('#clip-hook').value = clip.hook; $('#clip-framing').value = clip.framing; $('#clip-captions').value = captionText(clip.captions);
      $('#editor').scrollIntoView({ behavior: 'smooth' });
    }
    if (d.render) { await api(`/api/clips/${d.render}/render`); notify('Render started. No publication is scheduled by rendering.'); }
    if (d.cancel) { await api(`/api/jobs/${d.cancel}/cancel`); notify('Cancellation recorded. Underlying work is being stopped; late output is rejected.'); }
    if (d.moment != null) {
      const moment = state.jobs.find(j => j.id === d.analysis).result.moments[Number(d.moment)];
      newDraft(); $('#clip-name').value = moment.title.slice(0, 160); $('#clip-start').value = moment.start; $('#clip-end').value = moment.end;
      $('#source-preview').currentTime = moment.start;
    }
    if (d.liveStop) await api(`/api/live/${d.liveStop}/stop`);
    if (d.cleanup && confirm('Delete completed buffers that have no clips and no active analysis/render leases? This cannot be undone.')) {
      const result = await api(`/api/live/${d.cleanup}/cleanup`); notify(`Deleted ${result.deleted} buffers; retained ${result.retained} in use.`);
      if (!state.clips.some(c => c.asset_id === assetId)) { assetId = null; $('#editor').classList.add('hidden'); }
    }
    if (d.latest) {
      const segment = state.segments.filter(s => s.session_id === d.latest).at(-1);
      if (!segment) throw new Error('No completed segment yet');
      tab('studio'); await selectAsset(segment.asset_id); $('#editor').scrollIntoView();
    }
    if (d.accountToggle) {
      const account = state.accounts.find(a => a.id === d.accountToggle);
      await api(`/api/accounts/${account.id}`, { enabled: !account.enabled });
    }
    if (d.accountVerify && confirm('Contact this provider with the saved token to verify the destination identity? No video will be uploaded.')) {
      const result = await api(`/api/accounts/${d.accountVerify}/verify`, { networkConsent: true });
      notify(`Verified destination: ${result.displayName} (${result.id}). Review this identity before enabling or approving posts.`);
    }
    if (d.accountLimits) {
      const account = state.accounts.find(a => a.id === d.accountLimits);
      const spacing = prompt('Minimum spacing in minutes (1-1440)', account.spacing / 60);
      if (spacing != null) {
        const cap = prompt('Rolling 24-hour dispatch cap (1-100)', account.daily_cap);
        if (cap != null) await api(`/api/accounts/${account.id}`, { spacing: Number(spacing) * 60, dailyCap: Number(cap) });
      }
    }
    if (d.accountToken) {
      // Reuse a password control; never put tokens in prompt dialogs or status messages.
      $('#account-form').dataset.replace = d.accountToken;
      notify('Token replacement: enter the new token in the account form, then use the Replace saved token button.');
      let replacement = $('#replace-token');
      if (!replacement) {
        replacement = document.createElement('button'); replacement.type = 'button'; replacement.id = 'replace-token';
        replacement.textContent = 'Replace saved token'; $('#account-form').append(replacement);
        action('#replace-token', async () => {
          await api(`/api/accounts/${$('#account-form').dataset.replace}`, { token: $('#account-token').value });
          $('#account-token').value = ''; $('#replace-token').remove(); notify('Token replaced; account disabled until the same destination identity is reverified.');
        });
      }
      $('#account-token').focus();
    }
    if (d.publishCancel) await api(`/api/publications/${d.publishCancel}/cancel`);
    if (d.reconcile) { const result = await api(`/api/publications/${d.reconcile}/reconcile`); notify(`Provider status: ${result.state}. ${result.message ?? ''}`); }
    if (d.resolve) {
      const outcome = prompt('After checking the provider: type succeeded or failed. No upload will be retried.');
      if (outcome != null) {
        const note = prompt('Record the provider evidence / post ID confirming this outcome.');
        if (note != null) await api(`/api/publications/${d.resolve}/resolve`, { outcome, note, confirmed: true });
      }
    }
    await refresh();
  } catch (error) { notify(error.message, true); }
  finally { button.disabled = false; }
});
await refresh();
if (state?.settings.ai) {
  $('#ai-endpoint').value = state.settings.ai.endpoint;
  $('#ai-model').value = state.settings.ai.model;
  $('#ai-enabled').checked = state.settings.ai.enabled;
}
setInterval(refresh, 2500);
