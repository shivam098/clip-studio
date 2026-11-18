import { run } from './process.mjs';
import { dirname, join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';

const verificationMessage = 'YouTube asked for a signed-in account before downloading. Add a YouTube sign-in (cookies file) in Privacy & setup and import again, or upload the video file.';
const refusedSigninMessage = 'YouTube did not accept the saved YouTube sign-in; its cookies may have expired. Add a fresh cookies file in Privacy & setup and import again, or upload the video file.';
// Jobs that failed before YouTube sign-in support stored this explanation.
const legacyVerificationMessage = 'YouTube requires sign-in / anti-bot verification for this request. Clip Studio cannot complete that verification. No browser cookies were read and no automatic retry was made. Use Upload with a video file you are authorized to download.';
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(value);
const youtubeHost = host => ['www.youtube.com', 'youtube.com', 'youtu.be'].includes(host);

function videoId(url) {
  const path = url.pathname;
  const value = url.hostname === 'youtu.be' ? /^\/([^/]+)\/?$/.exec(path)?.[1]
    : path === '/watch' && url.searchParams.getAll('v').length === 1 ? url.searchParams.get('v')
    : /^\/(?:shorts|embed|live)\/([^/]+)\/?$/.exec(path)?.[1];
  return validId(value) ? value : null;
}

export class YouTubeVerificationRequired extends Error {
  constructor(url, cause, signedIn = false) {
    super(signedIn ? refusedSigninMessage : verificationMessage, { cause });
    this.videoId = videoId(url);
    this.signedIn = signedIn;
  }
}

export function importRecovery(job, result) {
  if (job?.type !== 'import' || job.state !== 'failed') return null;
  let id, signedIn = false;
  if (result?.reason === 'youtube-verification') { id = result.videoId; signedIn = result.signedIn === true; }
  else if (result == null) {
    // Older jobs retained either the extractor's video ID or just our fixed explanation.
    const matches = [...(job.error ?? '').matchAll(/\bERROR: \[youtube\] ([A-Za-z0-9_-]{11}): Sign in to confirm (?:you['\u2019\uFFFD]re|you are) not a bot\b/gi)];
    if (!matches.length && ![verificationMessage, refusedSigninMessage, legacyVerificationMessage].includes(job.error)) return null;
    if (new Set(matches.map(match => match[1])).size === 1) id = matches[0][1];
  } else return null;
  return { watchUrl: validId(id) ? `https://www.youtube.com/watch?v=${id}` : null, ...(signedIn ? { signedIn } : {}) };
}

export function downloaderArgs(cookieFile = null) {
  return ['-m', 'yt_dlp', '--ignore-config', '--no-playlist', '--socket-timeout', '30',
    '--no-js-runtimes', '--js-runtimes', `node:${process.execPath}`, '--no-remote-components',
    ...(cookieFile ? ['--cookies', cookieFile] : [])];
}

async function runDownloader(args, config, signal, execute) {
  try {
    return await execute(config.python, args, {
      signal, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const source = new URL(args.at(-1)); // already passed supportedUrl
    if (youtubeHost(source.hostname) && /(?:^|\bERROR:\s+)(?:\[youtube\]\s+[\w-]+:\s+)?Sign in to confirm (?:you['\u2019\uFFFD]re|you are) not a bot\b/i.test(error.message)) {
      throw new YouTubeVerificationRequired(source, error, !!config.cookieFile);
    }
    if (/no supported javascript runtime|ejs.*(?:not found|not installed|missing)|(?:not found|not installed|missing).*ejs/i.test(error.message)) {
      throw new Error('The downloader JavaScript runtime or its matching yt-dlp-ejs dependency is unavailable. Check dependencies in Privacy & setup and install requirements-download.txt with the configured Python interpreter.', { cause: error });
    }
    throw error;
  }
}

export function supportedUrl(value, live = false) {
  const url = new URL(value);
  const hosts = live ? ['youtube.com', 'www.youtube.com', 'youtu.be', 'twitch.tv', 'www.twitch.tv']
    : ['youtube.com', 'www.youtube.com', 'youtu.be', 'vimeo.com', 'www.vimeo.com', 'twitch.tv', 'www.twitch.tv'];
  if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.username || url.password || url.port) {
    throw new Error(`Use an HTTPS ${live ? 'YouTube or Twitch' : 'YouTube, Vimeo or Twitch'} URL without credentials`);
  }
  return url.href;
}

export async function download(url, folder, config, signal, execute = run) {
  await runDownloader([...downloaderArgs(config.cookieFile), '--no-progress',
    '--restrict-filenames', '--max-filesize', '2G',
    '--ffmpeg-location', dirname(config.ffmpeg), '-f', 'bv*[height<=1080]+ba/b[height<=1080]',
    '--merge-output-format', 'mp4', '-o', join(folder, 'source.%(ext)s'), '--', supportedUrl(url)], config, signal, execute);
  const files = (await readdir(folder)).filter(f => /^source\.(mp4|mkv|webm|mov)$/.test(f));
  if (files.length !== 1) throw new Error('Downloader did not produce one supported video');
  const output = join(folder, files[0]);
  if ((await stat(output)).size > 2 * 1024 ** 3) throw new Error('Downloaded media exceeds 2 GiB limit');
  return output;
}

export async function liveUrl(url, config, signal, execute = run) {
  const { stdout } = await runDownloader([...downloaderArgs(config.cookieFile),
    '-f', 'best[protocol=m3u8_native]/best[protocol=m3u8]', '-g', '--', supportedUrl(url, true)], config, signal, execute);
  const urls = stdout.trim().split(/\r?\n/);
  if (urls.length !== 1 || new URL(urls[0]).protocol !== 'https:') throw new Error('This live source does not expose a supported combined HTTPS HLS stream');
  return urls[0];
}
