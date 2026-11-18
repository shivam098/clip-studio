# Clip Studio browser editor

Bookmark **https://shivam098.github.io/clip-studio/**. When an operator is sharing, tap **Open editor**, choose a video on **your own device**, set start/end, add an optional opening title and timed captions, then preview and export. Save the result before closing the tab. No email, PIN, microphone, shared library or upload is used.

The public editor is separate from the desktop app. The existing editor depends on local jobs, media paths, FFmpeg and accounts; none of those are connected here. Each tab holds its own media and edits **in memory only**. The public origin serves three in-memory assets and a health marker; no APIs, media files, directory listing, writes, redirects, proxy or subprocesses. No request logs. The editing page's CSP disallows network connections and permits playback only from local blob URLs. GitHub Pages and Cloudflare still see ordinary connection metadata, not your selected video.

**Limits:** standalone MP4/MOV/WebM up to 256 MiB and two hours, with a browser-decodable codec and a seekable duration. Cuts are 0.25–60 seconds. Output preserves aspect ratio, up to 960 pixels on the long edge, using canvas capture, Web Audio and MediaRecorder. MP4 or WebM depends on the device. Text is burned into the video. Export is real-time, not frame-accurate; keep the tab visible and screen awake. If encoding is unsupported, the editor explains preview-only mode. There is no server fallback, automatic transcription, source import by URL, desktop publishing or cross-device draft sync.

## Install and start locally (Windows)

Use Node 24+, then run `.\remote\Install-Editor.ps1` from a committed checkout. It installs **only the named browser-editor files** at `%LOCALAPPDATA%\ClipStudioRemote` and refuses to replace an existing directory. It does not install a service, task, tunnel or autorun. After reboot, or to restart:

```powershell
Set-Location "$env:LOCALAPPDATA\ClipStudioRemote"
.\Start-Editor.ps1
```

In another terminal, `Invoke-RestMethod http://127.0.0.1:4319/health` returns `{"service":"clip-studio-public-editor-v1","mode":"browser-only"}`. Use `127.0.0.1`, not a LAN address. The `X-Clip-Editor-Instance` header is a public, random per-run correlation ID, not a credential. A restart invalidates old hostname pins. The process has read permission for the editor assets, policy and exact pin file, no file-write/child-process permission, a minimal environment, and binds only IPv4 loopback. **Never tunnel the desktop app or change its Host, Origin or CSRF protections.**

## Explicit external activation (not part of install/start)

Use the installed `cloudflared.exe` and GitHub CLI. Only after approving **public anonymous access**, in the installed directory, start this foreground process:

```powershell
node .\operator.mjs tunnel
```

This checks the fixed editor signature, starts one Quick Tunnel to **127.0.0.1:4319 only**, with its own empty config and isolated environment, and pins only the exact HTTPS hostname from that process's new-URL banner. No Host rewrite or forwarded header trust. It emits the public origin, not raw Cloudflare logs. Wait for the printed `Pinned https://…` line. The direct URL is now public; the Pages pointer has **not** changed. Keep the process running. If the editor stops/restarts or the pin is revoked the supervisor stops its own tunnel. A failure to obtain or verify the hostname is not a reason to use another app's tunnel.

In a second terminal at the same installed directory, use the **exact printed origin**, without a trailing slash:

```powershell
node .\operator.mjs online <origin>
```

The command rechecks both loopback and HTTPS health, compares the public instance IDs and checks Pages CORS before writing. It uses only the stored `shivam098` login for `github.com`, without switching sign-in, and compare-and-swaps **`gh-pages:link.json` only**. No repository checkout is required. The online record has `version:1`, `status:"online"`, `origin`, and integer UTC Unix milliseconds `issuedAt` / `expiresAt`, at most six hours apart. Rerun `online` deliberately to renew. The launcher rejects unknown fields, expired/future records, noncanonical hosts, redirects, oversized documents and an incorrect health response. It rechecks on **Open editor**. Quick Tunnels are temporary; availability depends on this PC and network.

## Stop or rotate

1. Press **Ctrl+C** in this tunnel's own terminal. For a detached operator, the following `offline` command also revokes the pin and its supervisor exits. This affects no other tunnel.
2. From the installed directory run **`node .\operator.mjs offline`**. This clears the local pin first, even if GitHub is unreachable, and writes exactly `{"version":1,"status":"offline"}` to `gh-pages:link.json`. Verify `https://shivam098.github.io/clip-studio/link.json` after the Pages build. An expired/offline pointer is **not** a substitute for actually stopping a working direct tunnel.
3. If not keeping the local browser editor running, run **`.\Stop-Editor.ps1`**. It checks the loopback listener and the exact installed Node entry point before stopping its PID. To rotate, leave the editor up, wait for the old supervisor to exit, then repeat `tunnel` and `online` with the newly issued origin.

## Pages publication and scoped verification

Pages serves only the contents of `remote/pages/` at the root of the independent `gh-pages` branch (`/`, branch build, no CNAME). Do not publish the source tree, state, logs, a media directory, or the desktop app. The checked-in bootstrap pointer is always offline. Subsequent operator commands do not change Pages settings or any other file/branch.

```powershell
node --test .\remote\test\remote.test.mjs
# Optional browser/media check: install Python playwright and supply a Chromium binary and FFmpeg.
# $env:CLIP_BROWSER = <path to chrome.exe or msedge.exe>
# $env:CLIP_FFMPEG = <path to ffmpeg.exe with ffprobe.exe alongside>
python .\remote\test\browser_smoke.py
```

The browser smoke uses a fresh mobile-sized Chromium profile, a generated test pattern/tone in a temporary directory, and an ephemeral loopback editor. It decodes the saved export and checks the trim, sound, title and caption timing; it never opens a tunnel, accesses the desktop app, or uses existing media.
