import { destination, verifyBeacon } from './policy.mjs';
const state = document.querySelector('#state'), detail = document.querySelector('#detail');
const retry = document.querySelector('#retry'), open = document.querySelector('#open');
async function check() {
  retry.hidden = open.hidden = true;
  open.removeAttribute('href');
  state.textContent = 'Checking the studio…';
  try {
    const reply = await fetch(`./link.json?t=${Date.now()}`, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!reply.ok) throw new Error();
    const pointer = await reply.json(), origin = destination(pointer);
    if (!origin) {
      state.textContent = 'Studio offline';
      detail.textContent = 'Remote access is stopped. Start sharing on the studio PC, then check again.';
      retry.hidden = false; return;
    }
    await verifyBeacon(origin, pointer.instance);
    state.textContent = 'Opening Clip Studio';
    detail.textContent = 'Continuing to your full studio. Owner sign-in is required on a new device.';
    open.href = origin + '/'; open.hidden = false;
    location.replace(open.href);
  } catch {
    state.textContent = 'Studio not reachable';
    detail.textContent = 'The PC or tunnel may be offline, or its address has changed. No unverified address was opened.';
    retry.hidden = false;
  }
}
retry.addEventListener('click', check);
check();
