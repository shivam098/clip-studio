import { run } from './process.mjs';
import { dirname, join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';

export function supportedUrl(value, live = false) {
  const url = new URL(value);
  const hosts = live ? ['youtube.com', 'www.youtube.com', 'youtu.be', 'twitch.tv', 'www.twitch.tv']
    : ['youtube.com', 'www.youtube.com', 'youtu.be', 'vimeo.com', 'www.vimeo.com', 'twitch.tv', 'www.twitch.tv'];
  if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.username || url.password || url.port) {
    throw new Error(`Use an HTTPS ${live ? 'YouTube or Twitch' : 'YouTube, Vimeo or Twitch'} URL without credentials`);
  }
  return url.href;
}

export async function download(url, folder, config, signal) {
  await run(config.python, ['-m', 'yt_dlp', '--ignore-config', '--no-playlist', '--no-progress',
    '--restrict-filenames', '--max-filesize', '2G', '--socket-timeout', '30',
    '--ffmpeg-location', dirname(config.ffmpeg), '-f', 'bv*[height<=1080]+ba/b[height<=1080]',
    '--merge-output-format', 'mp4', '-o', join(folder, 'source.%(ext)s'), '--', supportedUrl(url)], { signal });
  const files = (await readdir(folder)).filter(f => /^source\.(mp4|mkv|webm|mov)$/.test(f));
  if (files.length !== 1) throw new Error('Downloader did not produce one supported video');
  const output = join(folder, files[0]);
  if ((await stat(output)).size > 2 * 1024 ** 3) throw new Error('Downloaded media exceeds 2 GiB limit');
  return output;
}

export async function liveUrl(url, config, signal) {
  const { stdout } = await run(config.python, ['-m', 'yt_dlp', '--ignore-config', '--no-playlist',
    '--socket-timeout', '30', '-f', 'best[protocol=m3u8_native]/best[protocol=m3u8]', '-g', '--', supportedUrl(url, true)], { signal });
  const urls = stdout.trim().split(/\r?\n/);
  if (urls.length !== 1 || new URL(urls[0]).protocol !== 'https:') throw new Error('This live source does not expose a supported combined HTTPS HLS stream');
  return urls[0];
}
