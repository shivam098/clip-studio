import { destination, healthPath, isEditor, readSmallJson } from './link-policy.js';

const state = document.querySelector('#state'), detail = document.querySelector('#detail');
const open = document.querySelector('#open'), retry = document.querySelector('#retry');
let checking = false;

async function check(navigate = false) {
  if (checking) return;
  checking = true;
  open.hidden = retry.hidden = true;
  state.textContent = 'Checking availability…';
  detail.textContent = 'Looking for the current public editor.';
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 9000);
  try {
    const pointer = await readSmallJson(`./link.json?t=${Date.now()}`, { signal: abort.signal });
    const origin = destination(pointer);
    if (!origin) {
      state.textContent = 'Editor offline';
      detail.textContent = 'The public workspace is not sharing right now. Keep this bookmark and check again later.';
      return;
    }
    if (!isEditor(await readSmallJson(origin + healthPath, { signal: abort.signal })) || !destination(pointer)) {
      throw new Error('Editor unavailable.');
    }
    if (navigate) {
      location.assign(origin + '/');
      return;
    }
    state.textContent = 'Editor online';
    detail.textContent = 'The browser editing workspace is ready. Open it to choose a video on this device.';
    open.hidden = false;
  } catch {
    state.textContent = 'Editor unavailable';
    detail.textContent = 'The address expired, the editor could not be verified, or this browser cannot check it. No redirect was made. Try again in a current browser.';
  } finally {
    clearTimeout(timeout);
    checking = false;
    retry.hidden = !open.hidden;
  }
}
open.onclick = () => check(true);
retry.onclick = () => check();
window.addEventListener('pageshow', () => check());
