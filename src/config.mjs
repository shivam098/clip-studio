import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const dataDir = resolve(process.env.CLIP_STUDIO_DATA ?? join(
  process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'ClipStudio', 'data'));

export function readConfig(root = dataDir) {
  const file = join(root, 'config.json');
  const local = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {};
  return {
    ...local,
    ffmpeg: process.env.CLIP_FFMPEG ?? local.ffmpeg ?? 'ffmpeg',
    ffprobe: process.env.CLIP_FFPROBE ?? local.ffprobe ?? 'ffprobe',
    python: process.env.CLIP_PYTHON ?? local.python ?? 'python',
    model: process.env.CLIP_WHISPER_MODEL ?? local.model ?? 'small.en',
    ytDlp: process.env.CLIP_YTDLP ?? local.ytDlp ?? 'yt-dlp',
  };
}

export function writeJsonAtomic(file, value) {
  mkdirSync(resolve(file, '..'), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}
