const $ = id => document.getElementById(id);
const video = $('source'), canvas = $('frame'), ctx = canvas.getContext('2d', { alpha: false });
const Audio = window.AudioContext || window.webkitAudioContext;
const mime = window.MediaRecorder && ['video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp8,opus', 'video/mp4', 'video/webm']
  .find(type => MediaRecorder.isTypeSupported?.(type));
const canExport = Boolean(ctx && mime && canvas.captureStream && Audio?.prototype.createMediaStreamDestination);
const maxBytes = 256 * 1024 * 1024, maxExport = 32 * 1024 * 1024;
let ready = false, revision = 0, sourceUrl, resultUrl, audio, audioSource, active = null, clip = null;

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
  $('cancel').hidden = !active;
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
function draw() {
  if (!ready || video.readyState < 2) return;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  $('scrub').value = video.currentTime;
  $('time').textContent = `${video.currentTime.toFixed(2)} / ${video.duration.toFixed(2)} s`;
  if (!clip || video.currentTime < clip.start || video.currentTime >= clip.end) return;
  const t = video.currentTime - clip.start, edge = Math.min(canvas.width, canvas.height);
  if (clip.title && t < 4) overlay(clip.title, canvas.height * .16, Math.max(12, Math.round(edge * .07)));
  const cue = clip.cues.find(cue => cue.from <= t && t < cue.to);
  if (cue) overlay(cue.text, canvas.height * .83, Math.max(11, Math.round(edge * .055)));
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
  if (job.audioOut) audioSource.disconnect(job.audioOut);
  for (const track of [...(job.picture?.getTracks() ?? []), ...(job.audioOut?.stream.getTracks() ?? [])]) track.stop();
  active = null;
  controls();
  if (job.complete && job.exporting && job.bytes) {
    const type = job.rec.mimeType || mime, ext = type.startsWith('video/mp4') ? 'mp4' : 'webm';
    resultUrl = URL.createObjectURL(new Blob(job.chunks, { type }));
    $('download').href = resultUrl;
    $('download').download = `clip.${ext}`;
    $('download').textContent = `Save ${ext.toUpperCase()} clip`;
    $('download').hidden = false;
    message('Export ready. Save the clip to keep it.');
  } else if (job.complete && !job.exporting) {
    message('Preview complete.');
  } else {
    message(job.failure || 'Export did not finish. No partial file was offered.', true);
  }
}
function finish(job, complete, failure) {
  if (active !== job || job.ending) return;
  job.ending = true;
  job.complete = complete;
  job.failure = failure;
  cancelAnimationFrame(job.frame);
  clearTimeout(job.watchdog);
  video.pause();
  if (job.rec?.state === 'recording') job.rec.stop();
  else release(job);
}
function frame(job) {
  if (active !== job || job.ending) return;
  if (video.currentTime >= clip.end || video.ended) return finish(job, true);
  draw();
  job.frame = requestAnimationFrame(() => frame(job));
}
async function play(exporting) {
  if (!clip || active || (exporting && !canExport)) return;
  const job = active = { exporting, chunks: [], bytes: 0 };
  controls();
  if (exporting) clearResult();
  message(exporting ? 'Exporting on this device. Keep the tab visible…' : 'Playing your cut…');
  job.watchdog = setTimeout(() => finish(job, false, 'Playback took too long. Try a shorter cut or a different browser.'),
    (clip.end - clip.start + 8) * 1000);
  try {
    if (exporting && !audio) {
      audio = new Audio();
      audioSource = audio.createMediaElementSource(video);
      audioSource.connect(audio.destination);
    }
    video.currentTime = clip.start;
    await Promise.all([video.play(), audio?.resume()]);
    if (active !== job || job.ending) return;
    draw();
    if (exporting) {
      job.picture = canvas.captureStream(30);
      job.audioOut = audio.createMediaStreamDestination();
      audioSource.connect(job.audioOut);
      const stream = new MediaStream([...job.picture.getVideoTracks(), ...job.audioOut.stream.getAudioTracks()]);
      job.rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2500000, audioBitsPerSecond: 128000 });
      job.rec.ondataavailable = ({ data }) => {
        job.bytes += data.size;
        if (job.bytes > maxExport) {
          job.complete = false;
          job.failure = 'Export exceeded 32 MiB. Try a shorter cut.';
          finish(job, false, job.failure);
        } else if (data.size) job.chunks.push(data);
      };
      job.rec.onstop = () => release(job);
      job.rec.onerror = () => finish(job, false, 'This browser could not encode the clip. Try a shorter cut or another browser.');
      job.rec.start(250);
    }
    job.started = true;
    frame(job);
  } catch {
    finish(job, false, exporting
      ? 'Export could not start with this video and browser. Try an H.264 MP4 in current Safari or Chrome.'
      : 'Playback could not start. Tap Preview again or choose a supported video.');
  }
}
$('preview').onclick = () => play(false);
$('export').onclick = () => play(true);
$('cancel').onclick = () => { if (active) finish(active, false, 'Stopped. Your edit is still here.'); };
video.onended = () => { if (active) finish(active, !!active.started); };
video.onerror = () => {
  if (!sourceUrl || !video.error) return;
  if (active) finish(active, false, 'The browser could not decode this video.');
  discardSource();
  message('This browser cannot decode the video or its codec. Try an H.264 MP4.', true);
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden && active) finish(active, false, 'Playback stopped when the tab was hidden. Keep it visible during export.');
});
if (!canExport) $('compat').textContent = 'Preview only in this browser: export needs canvas recording, MediaRecorder, Web Audio and a supported encoder. Try a current Chrome, Edge or Safari.';
