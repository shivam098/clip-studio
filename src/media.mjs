import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './process.mjs';

const speechScript = fileURLToPath(new URL('../scripts/transcribe.py', import.meta.url));

export async function probe(path, config, signal) {
  const { stdout } = await run(config.ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path], { signal });
  const info = JSON.parse(stdout);
  const video = info.streams?.find(s => s.codec_type === 'video');
  const duration = Number(info.format?.duration);
  if (!video || !Number.isFinite(duration) || duration <= 0) throw new Error('A finite video with a known duration is required');
  return { duration, width: video.width, height: video.height, audio: Number(info.streams.some(s => s.codec_type === 'audio')) };
}

export async function transcribe(path, config, signal) {
  const { stdout } = await run(config.python, [speechScript, path, config.model], { signal, maxOutput: 12_000_000,
    env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONUTF8: '1' } });
  return JSON.parse(stdout);
}

export function validateSegments(segments, duration) {
  if (!Array.isArray(segments) || segments.length > 20000) throw new Error('Expected at most 20,000 caption segments');
  let previous = 0;
  return segments.map(segment => {
    const start = Number(segment.start), end = Number(segment.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < previous || start < 0 ||
      end <= start || end > duration + 0.05 || typeof segment.text !== 'string' || segment.text.length > 1000) {
      throw new Error('Captions require ordered, valid start/end seconds within the video and text of at most 1000 characters');
    }
    previous = start;
    return { start, end, text: segment.text.trim() };
  });
}

export function selectMoments(segments, duration) {
  if (!segments.length) {
    return Array.from({ length: Math.min(5, Math.ceil(duration / 30)) }, (_, i) => ({
      start: i * 30, end: Math.min(duration, i * 30 + 30),
      title: `Review window ${i + 1}`, reason: 'Evenly spaced windows; no speech or AI judgment.',
    }));
  }
  const candidates = segments.map((segment, i) => {
    const end = Math.min(duration, segment.start + 40);
    const text = segments.slice(i).filter(s => s.start < end).map(s => s.text).join(' ');
    const score = (text.match(/[?!]/g)?.length ?? 0) * 3 +
      (text.match(/\b(why|how|mistake|learn|save|because|instead|secret)\b/gi)?.length ?? 0) * 2 +
      Math.min(text.length / 100, 8);
    return { start: segment.start, end, title: text.slice(0, 80), score,
      reason: 'Local text heuristic: punctuation and explanatory words, not an AI quality score.' };
  }).filter(c => c.end - c.start >= Math.min(10, duration));
  const chosen = [];
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    if (chosen.every(c => candidate.start >= c.end || candidate.end <= c.start)) chosen.push(candidate);
    if (chosen.length === 5) break;
  }
  return chosen.sort((a, b) => a.start - b.start);
}

const assTime = seconds => {
  const cs = Math.max(0, Math.round(seconds * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
const assText = text => text.replace(/\\/g, '\uFF3C').replace(/{/g, '\uFF5B').replace(/}/g, '\uFF5D').replace(/\r?\n/g, '\\N');

export function subtitles(clip) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1280
WrapStyle: 0
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Arial,42,&H00FFFFFF,&H00FFFFFF,&H00000000,&H90000000,-1,0,0,0,100,100,0,0,1,3,1,2,48,48,150,1
Style: Hook,Arial,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H90000000,-1,0,0,0,100,100,0,0,1,3,1,8,48,48,110,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = clip.captions.filter(s => s.end > clip.start && s.start < clip.end).map(s =>
    `Dialogue: 0,${assTime(Math.max(0, s.start - clip.start))},${assTime(Math.min(clip.end, s.end) - clip.start)},Caption,,0,0,0,,${assText(s.text)}`);
  if (clip.hook) lines.push(`Dialogue: 1,0:00:00.00,${assTime(Math.min(4, clip.end - clip.start))},Hook,,0,0,0,,${assText(clip.hook)}`);
  return header + lines.join('\n') + '\n';
}

export async function render(asset, clip, folder, config, signal) {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'captions.ass'), subtitles(clip), 'utf8');
  const frame = clip.framing === 'crop'
    ? 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280'
    : 'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=0x111827';
  const output = join(folder, 'clip.mp4');
  await run(config.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-ss', String(clip.start), '-i', asset.path,
    '-t', String(clip.end - clip.start), '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `${frame},setsar=1,subtitles=captions.ass`, '-c:v', 'libx264', '-preset', 'veryfast',
    '-crf', '22', '-pix_fmt', 'yuv420p', '-r', '30', '-threads', '2',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', output], { signal, cwd: folder });
  const info = await probe(output, config, signal);
  if (info.width !== 720 || info.height !== 1280 || Math.abs(info.duration - (clip.end - clip.start)) > 0.3) {
    throw new Error('Rendered video failed dimensions/duration verification');
  }
  return { output, ...info };
}
