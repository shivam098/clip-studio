# Clip Studio

An independently written, local-first clipping application. Bring a video into a browser workspace, transcribe it offline, find review windows, edit captions, and render downloadable vertical clips. No reference-project code, assets, prompts, tests, or documentation were used. This is not a formal clean-room certification.

**Trial URL:** `http://localhost:4318`. The server binds to `127.0.0.1` only. It is not a multi-user service and must not be exposed through a tunnel or reverse proxy.

## What works, and what is not verified

| Workflow | Status |
|---|---|
| Creator/workspace organization, video upload, range-based playback | Implemented; synthetic HTTP/media smoke exercised |
| Offline CPU speech transcription | faster-whisper with a preinstalled model; Windows synthetic speech exercised |
| Moment selection without a key | Honest text/punctuation heuristic, or evenly spaced windows without speech; **not AI** |
| Configured AI selection | OpenAI-compatible local or remote endpoint; transcript-only, explicit configuration and per-run remote consent; mock-contract coverage, no live cloud call made |
| Manual clip edits, editable timed captions, opening title | Implemented; 720x1280 H.264/AAC MP4, fit or center crop, up to 180 seconds |
| YouTube/Vimeo/Twitch URL import | yt-dlp adapter; network access only on an explicit request; real provider download not verified in the synthetic-only trial |
| YouTube/Twitch HLS capture | Completed ~20-second buffers become library videos; synthetic live capture/clipping exercised; actual provider streams not verified |
| Live analysis and manual clipping | Analyze/transcribe completed buffers on demand while capture continues; manual selection does not wait for AI. No continuous automatic live-posting loop |
| YouTube publishing | Resumable session + byte upload + status reconciliation; requires an authorized token; provider-contract tests only |
| Instagram Reels publishing | Facebook Login, resumable local-file upload, container processing and publish; no public hosting required; provider-contract tests only |
| TikTok Direct Post | Creator privacy/duration check, persisted publish ID, single-chunk upload up to 64 MB and status check; provider-contract tests only |
| Scheduling | Durable approvals, disabled-by-default global/account switches, dispatch-time spacing/caps, unresolved-outcome blocking |

Real-account posting, platform app reviews, token expiry/permissions, provider outages and actual source-stream availability remain **unverified prerequisites**, not working mock integrations. No social posts were made during implementation. OAuth login and automatic token refresh are not included; use your own approved application and replace expiring tokens manually. TikTok approval of this client's UX is not claimed. There is no remote transcription, image/frame analysis, face tracking, speaker tracking, or universal exactly-once publication guarantee.

## Run on Windows

Requirements:

- Node.js **24+**, using built-in `node:sqlite`; the app has no npm runtime dependencies.
- FFmpeg and ffprobe with `libx264`, AAC and `libass`/`subtitles` support.
- Python 3.10+ and `faster-whisper` for offline speech; `yt-dlp` for supported network sources.

```powershell
python -m pip install -r requirements-transcription.txt -r requirements-download.txt
# Explicit one-time model download; no user video/audio is sent.
python -c "from faster_whisper import WhisperModel; WhisperModel('small.en', device='cpu', compute_type='int8')"
.\scripts\Start-ClipStudio.ps1
```

Open `http://localhost:4318`. **Create synthetic demo** generates test-pattern video with Windows local synthesized speech. On other platforms it generates tones, clearly not a speech-transcription fixture.

If dependencies are not on PATH, create `%LOCALAPPDATA%\ClipStudio\data\config.json` (outside the repository):

```json
{
  "ffmpeg": "C:\\path\\to\\ffmpeg.exe",
  "ffprobe": "C:\\path\\to\\ffprobe.exe",
  "python": "C:\\path\\to\\python.exe",
  "model": "small.en"
}
```

`model` can be a faster-whisper model name already cached locally or an absolute model directory. Transcription always uses `local_files_only=True` and offline environment settings; a missing model fails explicitly rather than downloading or uploading anything. `CLIP_FFMPEG`, `CLIP_FFPROBE`, `CLIP_PYTHON`, `CLIP_WHISPER_MODEL`, `CLIP_STUDIO_DATA` and `PORT` override defaults. Privacy & setup includes dependency diagnostics.

The downloader explicitly uses the same Node executable as Clip Studio, rather than relying on yt-dlp's Deno-only default. `requirements-download.txt` includes yt-dlp's matching `yt-dlp-ejs` scripts through its `default` dependency group. Runtime downloading of extra JavaScript components is disabled. Install requirements with the Python interpreter configured above (prefer an app-specific virtual environment).

If YouTube requires verification, **Source library** in the importing workspace shows three choices. **Open on YouTube** opens that video in a new tab to watch or sign in on YouTube; it does not authorize or retry the download in Clip Studio. **Choose a video file** adds an authorized local copy to the original workspace through the regular upload flow. Cancelling the file picker leaves everything unchanged. **Dismiss** hides the prompt for that import, including after reload. Only the video ID is needed for the watch link; older failures without a retained ID offer the file and dismiss choices instead. Clip Studio never requests your YouTube credentials or browser cookies.

Stop gracefully in another terminal:

```powershell
.\scripts\Stop-ClipStudio.ps1
```

Ctrl+C also stops a foreground server. Restart after reboot; this is not an installed Windows service. Scheduling and capture only run while the server is alive. Local time in the scheduling form is converted to an absolute UTC instant; account caps use a rolling 24-hour window.

For a durable trial outside a disposable worktree, commit the source then run:

```powershell
.\scripts\Install-LocalTrial.ps1
& "$env:LOCALAPPDATA\ClipStudio\app\scripts\Start-ClipStudio.ps1"
```

The installer archives **committed tracked files only** into a new destination and refuses to overwrite an existing one. Code is separate from `%LOCALAPPDATA%\ClipStudio\data`, the installed FFmpeg tools, and the Hugging Face model cache. Stop the running server before upgrading. No license granting rights to this application's code has been selected; public visibility is not an open-source license. Independently installed dependencies retain their own licenses (including the selected FFmpeg build).

## Trial walkthrough

1. Create a synthetic demo or upload one video you have permission to use. Click its library card.
2. Select **Transcribe locally**, then **Find moments (non-AI)**. Speech recognition may be imperfect; edit the transcript and review the timing.
3. Choose a suggested window, or enter your own start/end. Set fit/crop, an optional opening title, and timed caption rows in `start | end | text` format. Caption times refer to the source video.
4. Save the draft, select **Render 9:16** on its clip card, review the rendered video, and download the MP4. Rendering never queues a social post.
5. In Live capture, try the synthetic feed. Completed buffers enter the library while capture continues; select one and clip it normally. Explicit cleanup retains buffers referenced by clips or active analyses/renders.

Source transcript edits do not silently replace captions in existing clips. Editing a clip invalidates its displayed render; already-approved publications retain the immutable render path and metadata that were approved. Background source transcription refuses to overwrite a transcript edited while it ran. A newer render attempt owns its clip; an older result cannot attach afterward.

Source playback depends on the browser's codec support (H.264/AAC MP4 is recommended). Other FFmpeg-readable formats can still be trimmed by timestamps and rendered to the browser-compatible output format.

## Provider setup and approval

Tokens are entered into password controls in the local UI. Windows stores them encrypted with **current-user DPAPI** in `credentials.json`; other operating systems use an owner-readable file (0600), not encrypted storage. The UI never returns saved tokens. API keys do not belong in repository files or messages.

- **YouTube:** an OAuth access token for the destination channel with `youtube.upload` and `youtube.readonly` (account verification); projects may need Google's verification/audit, and unverified projects can be private-only. Choose visibility explicitly; made-for-kids is a separate choice. This adapter creates and saves a resumable session before sending video bytes.
- **Instagram:** a professional account, Facebook Login access token with required Instagram publishing permissions (including `instagram_basic`, `instagram_content_publish`, `pages_read_engagement`, and additional business permissions when applicable), professional account ID and a supported Graph API version. Complete Page Publishing Authorization where required. This implementation uses `graph.facebook.com` and `rupload.facebook.com`, not Instagram Login or automatic public hosting.
- **TikTok:** a Content Posting API application, `video.publish` and `user.info.basic` authorization (account verification), and platform app review/audit as applicable. Unaudited apps have visibility/user restrictions. Direct Post checks the current creator's permitted visibility and duration, disables comments/duet/stitch, and rejects files over 64 MB. A processing response is **not** reported as a successful post; use **Check provider status**. This client has not passed TikTok's UX/application audit.

Save an account (initially disabled), explicitly verify it against the provider, check the returned destination name/ID, then enable it. Duplicate bindings to the same provider account are rejected so account caps cannot be split across local labels. Token replacement disables the account until the same identity is verified again; existing approvals cannot be retargeted to a different identity. Select a rendered clip and verified destination, choose visibility/time, and explicitly approve that one post. The authenticated identity is checked again immediately before upload. Enable global dispatch only when ready. Pause stops future dispatches, not a network request already in flight; cancelling an in-flight post marks it unresolved because bytes may already have reached the provider.

No automatic retry follows an uncertain response. The outbox retains provider session/container/publish IDs and blocks later posts on the same account. **Check provider status** only performs the documented status operation; it never creates another upload/publish. YouTube incomplete sessions and Instagram unconfirmed publish outcomes remain unresolved. If no identifier was received, inspect the provider dashboard, then record a manual outcome with evidence. A failed manual resolution does not retry the item; deliberately approve a new post only after establishing that it will not duplicate an existing one.

Protocol references used independently:

- [YouTube resumable upload protocol](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol)
- [Instagram content publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing)
- [TikTok Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post)

## Data flow and safety boundaries

| Operation | Local data | External data |
|---|---|---|
| Upload/manual editing/render | Source file, transcript edits, caption files, render | None |
| Offline speech | Audio decoding and model inference on CPU | None; preinstall models separately |
| Heuristic moments | Transcript rules or evenly spaced windows | None |
| Configured model | Saved endpoint/configuration | Transcript text to that endpoint only after explicit request; remote consent required per run |
| URL import/live capture | Downloaded media/buffers | Requested source URL and network address visible to source platforms/CDNs |
| Publishing/reconciliation | Durable approval, attempt, limits, provider IDs | Selected rendered video, metadata and authorized credentials to the selected platform; reconciliation queries its status |

No frame images are sent, no telemetry is collected, and no personal media directory is scanned. Provider retention/training rules are provider-specific; the application does not promise zero retention by an external endpoint. A browser page's same-origin token and Host/Origin checks guard mutations; this is **not** authentication against other software/users already on the machine. Keep the data directory private. The SQLite database includes transcripts and sensitive resumable-session URLs. Protect backups accordingly.

Data is retained by default. Remove unused live buffers with the explicit UI command; it refuses to delete in-use sources. Other source/render retention is manual: stop the server and back up or remove your dedicated application data directory intentionally. Cancelled or stale attempt files may remain for diagnosis; no cancelled result is attached or published. Crash-interrupted leases remain conservatively retained, because an orphaned encoder could still be using them; stop any old encoders before doing manual data cleanup.

## Durability and ownership design

- SQLite WAL with `synchronous=FULL` and short `BEGIN IMMEDIATE` transactions. A per-data-directory server lock prevents two local schedulers using the same store. An active/uncertain/processing publication blocks the account.
- The publication state, unique attempt and quota reservation commit **before** any provider side effect. IDs are checkpointed before subsequent requests, including when a late identifier arrives after cancellation. Restart changes in-flight publications to `uncertain`, never back to scheduled.
- Spacing and rolling daily caps are rechecked transactionally at dispatch, including paused/restarted backlogs. Uncertain and failed dispatches conservatively consume quota. Completion/reconciliation time also delays later dispatches so a slow upload does not collapse the gap between posts.
- Render cancellation/timeout invalidates ownership before aborting the subprocess tree. Late results cannot commit. Rendering and publishing are separate workflows: there is no publish callback attached to render completion.
- Each running live analysis has its own buffer leases. An old task cannot clear the current task's ownership or a newer lease. Timeouts retain leases until the underlying task settles. Transcription and analysis have bounded concurrency and never hold a global manual-edit lock.
- Capture restarts are explicit; interrupted jobs are not silently resumed. Current provider integration contracts are tested with fakes, not claimed as live-provider evidence.

## Verification

```powershell
npm run check
npm test
npm run smoke
# Windows offline speech + real synthetic capture:
$env:CLIP_SMOKE_SPEECH = '1'
$env:CLIP_SMOKE_LIVE = '1'
npm run smoke
```

Tests cover late render results, actual subprocess-tree cancellation, attempt replacement, overlapping/timed-out live leases, committed publication intent, ambiguous responses, restart recovery, late provider IDs, dispatch spacing/caps, no-network fallback, provider request contracts, Host/Origin/token boundaries and the actual HTTP app. `smoke` creates synthetic media, uploads it through HTTP, edits captions, renders using real FFmpeg, checks dimensions/duration/audio and downloads the result. Optional Windows speech/live checks exercise their real local runtimes. No cloud API or social account is used by tests.

CI runs the checked-in application tests on Windows and Linux and the real FFmpeg/HTTP smoke on Linux. Browser interaction is verified separately during the Windows trial; CI does not claim a browser E2E or real platform upload.
