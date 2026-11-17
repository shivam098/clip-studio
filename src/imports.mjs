import { run } from './process.mjs';
import { dirname, join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';

export function downloaderArgs() {
  return ['-m', 'yt_dlp', '--ignore-config', '--no-playlist', '--socket-timeout', '30',
    '--no-js-runtimes', '--js-runtimes', `node:${process.execPath}`, '--no-remote-components'];
}

async function runDownloader(args, config, signal, execute) {
  try {
    return await execute(config.python, args, {
      signal, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (/sign in to confirm (?:you.?re|you are) not a bot/i.test(error.message)) {
      throw new Error('YouTube requires sign-in / anti-bot verification for this request. Clip Studio cannot complete that verification. No browser cookies were read and no automatic retry was made. Use Upload with a video file you are authorized to download.', { cause: error });
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
  await runDownloader([...downloaderArgs(), '--no-progress',
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
  const { stdout } = await runDownloader([...downloaderArgs(),
    '-f', 'best[protocol=m3u8_native]/best[protocol=m3u8]', '-g', '--', supportedUrl(url, true)], config, signal, execute);
  const urls = stdout.trim().split(/\r?\n/);
  if (urls.length !== 1 || new URL(urls[0]).protocol !== 'https:') throw new Error('This live source does not expose a supported combined HTTPS HLS stream');
  return urls[0];
}
