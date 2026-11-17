import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const youtubeApi = 'https://www.googleapis.com';
const tiktokApi = 'https://open.tiktokapis.com';

function providerUrl(value, hosts) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('Provider returned an unexpected upload host');
  }
  return url.href;
}

export class Providers {
  constructor({ fetcher = fetch, wait = sleep } = {}) { this.fetch = fetcher; this.wait = wait; }
  async request(url, options = {}, signal) {
    const response = await this.fetch(url, { ...options, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000) });
    // Error bodies and signed URLs can contain credentials. Do not copy them into job logs.
    if (!response.ok && response.status !== 308) throw new Error(`Provider HTTP ${response.status}; inspect account/provider status before retrying`);
    return response;
  }
  async json(url, token, body, signal, method = 'POST') {
    const response = await this.request(url, { method, headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, signal);
    const result = await response.json();
    if (result.error && result.error.code !== 'ok') throw new Error('Provider rejected the operation; inspect account permissions and provider status');
    return result;
  }
  async identify(account, token, signal) {
    let remoteId, displayName;
    if (account.platform === 'youtube') {
      const result = await this.json(`${youtubeApi}/youtube/v3/channels?part=id,snippet&mine=true`, token, undefined, signal, 'GET');
      if (result.items?.length !== 1) throw new Error('Expected exactly one authorized YouTube channel');
      remoteId = result.items[0].id; displayName = result.items[0].snippet?.title;
    } else if (account.platform === 'instagram') {
      const result = await this.json(`https://graph.facebook.com/${account.config.version}/${account.config.userId}?fields=id,username`,
        token, undefined, signal, 'GET');
      if (result.id !== account.config.userId) throw new Error('Instagram account identity did not match the configured destination');
      remoteId = result.id; displayName = result.username;
    } else if (account.platform === 'tiktok') {
      const result = await this.json(`${tiktokApi}/v2/user/info/?fields=open_id,display_name`, token, undefined, signal, 'GET');
      remoteId = result.data?.user?.open_id; displayName = result.data?.user?.display_name;
    } else throw new Error('Unsupported publishing provider');
    if (typeof remoteId !== 'string' || !remoteId || typeof displayName !== 'string' || !displayName) throw new Error('Provider did not return a verifiable account identity');
    return { id: remoteId, displayName };
  }
  async upload(publication, account, token, checkpoint, signal) {
    const size = (await stat(publication.output)).size;
    const meta = publication.metadata;
    if (account.platform === 'youtube') {
      const response = await this.request(`${youtubeApi}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
          'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': 'video/mp4' },
        body: JSON.stringify({ snippet: { title: meta.title, description: meta.description, categoryId: '22' },
          status: { privacyStatus: meta.privacy, selfDeclaredMadeForKids: meta.madeForKids === true } }),
      }, signal);
      const session = providerUrl(response.headers.get('location'), ['www.googleapis.com']);
      checkpoint({ session, size, phase: 'session_created' });
      const uploaded = await this.request(session, { method: 'PUT', headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'video/mp4', 'Content-Length': String(size),
      }, body: createReadStream(publication.output), duplex: 'half' }, signal);
      if (uploaded.status === 308) throw new Error('Upload incomplete; reconcile the persisted session, do not start a new upload');
      const result = await uploaded.json();
      if (!result.id) throw new Error('Upload response missing video ID');
      checkpoint({ session, size, phase: 'uploaded', videoId: result.id });
      return { state: 'succeeded', id: result.id, url: `https://www.youtube.com/watch?v=${encodeURIComponent(result.id)}` };
    }
    if (account.platform === 'instagram') {
      const version = account.config.version;
      const base = `https://graph.facebook.com/${version}`;
      const user = account.config.userId;
      const container = await this.json(`${base}/${user}/media`, token, {
        media_type: 'REELS', upload_type: 'resumable', caption: `${meta.title}\n${meta.description}`,
      }, signal);
      if (!container.id || !/^\d+$/.test(container.id)) throw new Error('Provider response missing container ID');
      checkpoint({ containerId: container.id, phase: 'container_created' });
      const upload = await this.request(`https://rupload.facebook.com/ig-api-upload/${version}/${container.id}`, {
        method: 'POST', headers: { Authorization: `OAuth ${token}`, offset: '0',
          file_size: String(size), 'Content-Length': String(size), 'Content-Type': 'application/octet-stream' },
        body: createReadStream(publication.output), duplex: 'half',
      }, signal);
      if ((await upload.json()).success !== true) throw new Error('Instagram did not confirm media upload');
      checkpoint({ containerId: container.id, phase: 'processing' });
      let ready = false;
      for (let count = 0; count < 60; count++) {
        const status = await this.json(`${base}/${container.id}?fields=status_code`, token, undefined, signal, 'GET');
        if (status.status_code === 'FINISHED') { ready = true; break; }
        if (['ERROR', 'EXPIRED'].includes(status.status_code)) throw new Error(`Instagram container ${status.status_code}`);
        await this.wait(5000, undefined, { signal });
      }
      if (!ready) throw new Error('Instagram container not ready; reconcile before further action');
      checkpoint({ containerId: container.id, phase: 'publishing' });
      const result = await this.json(`${base}/${user}/media_publish`, token, { creation_id: container.id }, signal);
      if (!result.id) throw new Error('Publish response missing media ID');
      checkpoint({ containerId: container.id, mediaId: result.id, phase: 'published' });
      return { state: 'succeeded', id: result.id };
    }
    if (account.platform === 'tiktok') {
      // Keep one bounded upload chunk. Larger files need a separate, tested multi-chunk implementation.
      if (size > 64_000_000) throw new Error('TikTok adapter supports files up to 64 MB; render a shorter clip');
      const creator = await this.json(`${tiktokApi}/v2/post/publish/creator_info/query/`, token, {}, signal);
      if (!creator.data?.privacy_level_options?.includes(meta.privacy)) throw new Error('Chosen privacy is not allowed by this TikTok account');
      if (meta.duration > creator.data.max_video_post_duration_sec) throw new Error('Clip exceeds this TikTok account duration limit');
      const result = await this.json(`${tiktokApi}/v2/post/publish/video/init/`, token, {
        post_info: { title: meta.title, privacy_level: meta.privacy,
          disable_duet: true, disable_comment: true, disable_stitch: true },
        source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: size, total_chunk_count: 1 },
      }, signal);
      const publishId = result.data?.publish_id;
      if (!publishId) throw new Error('Provider response missing publish ID');
      const uploadUrl = providerUrl(result.data.upload_url, ['open-upload.tiktokapis.com', 'upload.us.tiktokapis.com']);
      checkpoint({ publishId, phase: 'initialized' });
      await this.request(uploadUrl, { method: 'PUT', headers: {
        'Content-Type': 'video/mp4', 'Content-Length': String(size), 'Content-Range': `bytes 0-${size - 1}/${size}`,
      }, body: createReadStream(publication.output), duplex: 'half' }, signal);
      checkpoint({ publishId, phase: 'processing' });
      return { state: 'processing', id: publishId };
    }
    throw new Error('Unsupported publishing provider');
  }
  async reconcile(publication, account, token, signal) {
    const ref = publication.provider_ref;
    if (account.platform === 'youtube' && ref.session) {
      const response = await this.request(providerUrl(ref.session, ['www.googleapis.com']), {
        method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Length': '0',
          'Content-Range': `bytes */${ref.size}` },
      }, signal);
      if (response.status === 308) return { state: 'uncertain', message: 'Session is incomplete. No new upload was attempted.' };
      const result = await response.json();
      if (!result.id) throw new Error('Reconciliation response missing video ID');
      return { state: 'succeeded', id: result.id, url: `https://www.youtube.com/watch?v=${encodeURIComponent(result.id)}` };
    }
    if (account.platform === 'instagram' && ref.containerId) {
      const result = await this.json(`https://graph.facebook.com/${account.config.version}/${ref.containerId}?fields=status_code`,
        token, undefined, signal, 'GET');
      if (result.status_code === 'PUBLISHED') return { state: 'succeeded', id: ref.mediaId ?? ref.containerId, message: 'Container reports PUBLISHED' };
      if (['ERROR', 'EXPIRED'].includes(result.status_code)) return { state: 'failed', message: `Container reports ${result.status_code}` };
      return { state: 'uncertain', message: `Container reports ${result.status_code}; no publish request was repeated.` };
    }
    if (account.platform === 'tiktok' && ref.publishId) {
      const result = await this.json(`${tiktokApi}/v2/post/publish/status/fetch/`, token, { publish_id: ref.publishId }, signal);
      const status = result.data?.status;
      if (status === 'PUBLISH_COMPLETE') return { state: 'succeeded', id: ref.publishId, message: status };
      if (status === 'FAILED') return { state: 'failed', message: 'TikTok reports FAILED; check provider dashboard' };
      return { state: 'processing', id: ref.publishId, message: status ?? 'Status not supplied' };
    }
    return { state: 'uncertain', message: 'No provider identifier was received. Inspect the provider account manually; no automatic retry is safe.' };
  }
}
