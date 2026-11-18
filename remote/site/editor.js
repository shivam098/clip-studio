const $ = id => document.getElementById(id);
const video = $('source'), canvas = $('frame'), ctx = canvas.getContext('2d', { alpha: false });
const canExport = Boolean(ctx && window.VideoEncoder && window.VideoDecoder);
const maxBytes = 256 * 1024 * 1024, maxExport = 32 * 1024 * 1024;
let ready = false, revision = 0, sourceUrl, resultUrl, active = null, clip = null;

function message(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}
function clearResult() {
  $('download').hidden = true;
  $('download').removeAttribute('href');
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = null;
}
function readCut() {
  const start = $('start').valueAsNumber, end = $('end').valueAsNumber, length = end - start;
  if (!(start >= 0 && end <= video.duration && length >= .25 && length <= 60)) {
    throw new Error('Choose a cut between 0.25 and 60 seconds, within the source video.');
  }
  const cues = [];
  for (const [i, line] of $('captions').value.split('\n').entries()) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(.+?)\s*$/.exec(line);
    if (!match || +match[1] < (cues.at(-1)?.to ?? 0) || +match[2] <= +match[1] ||
        +match[2] > length + 1e-6 || match[3].length > 120 || cues.length >= 30) {
      throw new Error(`Caption line ${i + 1}: use ordered, non-overlapping times within the cut (up to 30 captions, 120 characters each).`);
    }
    cues.push({ from: +match[1], to: +match[2], text: match[3] });
  }
  return { start, end, title: $('title').value.trim(), cues };
}
function controls() {
  $('timeline').disabled = $('edit').disabled = !ready || !!active;
  $('file').disabled = !!active;
  $('preview').disabled = !clip || !!active;
  $('export').disabled = !clip || !canExport || !!active;
  $('transport').hidden = !active;
  if (active) $('progress').textContent = active.exporting ? 'Exporting this cut…' : 'Previewing this cut…';
}
function update() {
  clearResult();
  clip = null;
  $('validation').textContent = '';
  if (ready) {
    try { clip = readCut(); } catch (error) { $('validation').textContent = error.message; }
    message('Changes stay in this tab.');
  }
  controls();
  draw();
}
function overlay(text, y, size) {
  ctx.font = `bold ${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const max = canvas.width * .88;
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && ctx.measureText(`${line} ${word}`).width > max) { lines.push(line); line = ''; }
    line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  const step = size * 1.2;
  const height = lines.length * step;
  const top = Math.min(canvas.height - height - size * .5, Math.max(size * .5, y - height / 2));
  ctx.fillStyle = 'rgba(0, 0, 0, .74)';
  ctx.fillRect(0, top - size * .2, canvas.width, height + size * .4);
  ctx.fillStyle = '#fff';
  lines.forEach((value, i) => ctx.fillText(value, canvas.width / 2, top + (i + .5) * step, max));
}
function drawText(t) {
  if (!clip || t < 0 || t >= clip.end - clip.start) return;
  const edge = Math.min(canvas.width, canvas.height);
  if (clip.title && t < 4) overlay(clip.title, canvas.height * .16, Math.max(12, Math.round(edge * .07)));
  const cue = clip.cues.find(cue => cue.from <= t && t < cue.to);
  if (cue) overlay(cue.text, canvas.height * .83, Math.max(11, Math.round(edge * .055)));
}
function draw() {
  if (active?.exporting || !ready || video.readyState < 2) return;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  $('scrub').value = video.currentTime;
  $('time').textContent = `${video.currentTime.toFixed(2)} / ${video.duration.toFixed(2)} s`;
  if (clip) drawText(video.currentTime - clip.start);
}
function discardSource() {
  ready = false;
  clip = null;
  video.pause();
  video.removeAttribute('src');
  video.load();
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  sourceUrl = null;
  clearResult();
  ctx?.clearRect(0, 0, canvas.width, canvas.height);
  $('empty').hidden = false;
  $('time').textContent = '0.00 / 0.00 s';
  $('scrub').value = 0;
  $('title').value = $('captions').value = '';
  $('validation').textContent = '';
  controls();
}
$('file').onchange = async () => {
  const id = ++revision, file = $('file').files[0];
  discardSource();
  try {
    if (!file) return message('No video selected.');
    if (!ctx || !file.slice(0, 12).arrayBuffer) throw new Error('This browser cannot load local video. Try a current Safari, Chrome, Edge or Firefox.');
    if (!file.size || file.size > maxBytes) throw new Error('Choose a non-empty source no larger than 256 MiB.');
    message('Reading video on this device…');
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (id !== revision) return;
    const box = String.fromCharCode(...head.slice(4, 8)), brand = String.fromCharCode(...head.slice(8, 12));
    const type = box === 'ftyp' ? (brand === 'qt  ' ? 'video/quicktime' : 'video/mp4') :
      (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3 ? 'video/webm' : null);
    if (!type) throw new Error('Choose a standalone MP4, MOV or WebM video file, not a playlist or link.');
    sourceUrl = URL.createObjectURL(file.slice(0, file.size, type));
    video.src = sourceUrl;
    video.load();
  } catch (error) { if (id === revision) message(error.message, true); }
};
video.onloadedmetadata = () => {
  if (!sourceUrl || video.currentSrc !== sourceUrl) return;
  if (!(Number.isFinite(video.duration) && video.duration >= .25 && video.duration <= 7200 && video.videoWidth && video.videoHeight)) {
    discardSource();
    return message('The browser needs a seekable video from 0.25 seconds to 2 hours long. Try an H.264 MP4.', true);
  }
  const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.max(2, 2 * Math.round(video.videoWidth * scale / 2));
  canvas.height = Math.max(2, 2 * Math.round(video.videoHeight * scale / 2));
  $('scrub').max = video.duration;
  $('start').value = 0;
  $('end').value = Math.floor(Math.min(15, video.duration) * 100) / 100;
  $('empty').hidden = true;
  ready = true;
  update();
  message('Source ready. Scrub or set start and end in seconds.');
};
video.onloadeddata = video.onseeked = draw;
$('scrub').oninput = () => { video.currentTime = $('scrub').valueAsNumber; };
for (const [id, input] of [['mark-in', 'start'], ['mark-out', 'end']]) {
  $(id).onclick = () => { $(input).value = Math.floor(video.currentTime * 100) / 100; update(); };
}
$('edit').oninput = update;

function release(job) {
  if (active !== job) return;
  clearTimeout(job.watchdog);
  cancelAnimationFrame(job.frame);
  video.pause();
  active = null;
  controls();
}
function stop(reason) {
  const job = active;
  if (!job || job.reason) return;
  job.reason = reason;
  if (job.exporting) {
    if (job.conversion) job.conversion.cancel().catch(() => message('The encoder failed to cancel cleanly. Reload the tab.', true));
  } else release(job);
  message(reason, true);
}
function begin(exporting, limit) {
  const job = active = { exporting };
  controls();
  canvas.scrollIntoView({ block: 'center' });
  job.watchdog = setTimeout(() => stop('Operation took too long. Try a shorter cut or a different browser.'), limit);
  return job;
}
$('preview').onclick = async () => {
  if (!clip || active) return;
  const job = begin(false, (clip.end - clip.start + 8) * 1000);
  message('Playing your cut…');
  try {
    video.currentTime = clip.start;
    await video.play();
    function frame() {
      if (active !== job) return;
      if (video.currentTime >= clip.end || video.ended) {
        release(job);
        return message('Preview complete.');
      }
      draw();
      job.frame = requestAnimationFrame(frame);
    }
    frame();
  } catch { if (active === job) stop('Playback could not start. Tap Preview again or choose a supported video.'); }
};
$('export').onclick = async () => {
  if (!clip || active || !canExport) return;
  const job = begin(true, 180000);
  clearResult();
  message('Exporting on this device. Keep the tab visible…');
  let input;
  try {
    const m = await import('/mediabunny.js');
    input = new m.Input({ formats: [m.MP4, m.QTFF, m.WEBM], source: new m.BlobSource($('file').files[0]) });
    const audio = await input.getPrimaryAudioTrack();
    const videoConfig = { width: canvas.width, height: canvas.height, frameRate: 30, quality: new m.Quality({ bitrate: 2500000 }) };
    const sound = { numberOfChannels: audio ? Math.min(2, await audio.getNumberOfChannels()) : 1,
      sampleRate: 48000, quality: new m.Quality({ bitrate: 128000 }) };
    for (const [ext, vCodec, aCodec, Format] of [
      ['mp4', 'avc', 'aac', m.Mp4OutputFormat], ['webm', 'vp8', 'opus', m.WebMOutputFormat],
    ]) {
      if (job.reason) return;
      if (!await m.canEncodeVideo(vCodec, videoConfig) || (audio && !await m.canEncodeAudio(aCodec, sound))) continue;
      const target = new m.BufferTarget();
      const output = new m.Output({ format: new Format(), target });
      const conversion = await m.Conversion.init({
        input, output, tracks: 'primary', tags: {}, copy: false, trim: { start: clip.start, end: clip.end },
        video: { ...videoConfig, codec: vCodec, fit: 'contain', allowTransformationMetadata: false,
          process(sample) {
            sample.draw(ctx, 0, 0, canvas.width, canvas.height);
            drawText(sample.timestamp);
            return canvas;
          } },
        audio: { ...sound, codec: aCodec },
      });
      if (job.reason) return;
      if (!conversion.isValid || conversion.discardedTracks.length) continue;
      job.conversion = conversion;
      conversion.onProgress = p => { $('progress').textContent = `Exporting · ${Math.round(p * 100)}%`; };
      target.on('write', ({ end }) => { if (end > maxExport) stop('Export exceeded 32 MiB. Try a shorter cut.'); });
      await conversion.execute();
      if (job.reason) return;
      if (!target.buffer?.byteLength || target.buffer.byteLength > maxExport) return message('No bounded output file was produced. Try a shorter cut.', true);
      resultUrl = URL.createObjectURL(new Blob([target.buffer], { type: `video/${ext}` }));
      $('download').href = resultUrl;
      $('download').download = `clip.${ext}`;
      $('download').textContent = `Save ${ext.toUpperCase()} clip`;
      $('download').hidden = false;
      message('Export ready. Save the clip to keep it.');
      $('download').scrollIntoView({ block: 'nearest' });
      return;
    }
    message('This browser cannot encode this video and its audio. Try an H.264 MP4 in current Chrome, Edge or Safari.', true);
  } catch {
    message(job.reason || 'The browser could not decode or export this cut. Try an H.264 MP4 or a different browser.', true);
  } finally {
    input?.dispose();
    release(job);
  }
};
$('cancel').onclick = () => stop('Stopped. Your edit is still here.');
video.onerror = () => {
  if (!sourceUrl || !video.error) return;
  stop('The browser could not decode this video.');
  discardSource();
  message('This browser cannot decode the video or its codec. Try an H.264 MP4.', true);
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stop('Stopped when the tab was hidden. Keep it visible during export.');
});
if (!canExport) $('compat').textContent = 'Preview only in this browser: export needs WebCodecs video decoding and encoding. Try current Chrome, Edge or Safari.';
