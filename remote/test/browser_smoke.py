"""Optional: CLIP_BROWSER, CLIP_FFMPEG (ffprobe alongside), Python Playwright, Node 24+. No external service."""
import array
import json
import os
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
FF = Path(os.environ["CLIP_FFMPEG"])
PROBE = FF.with_name("ffprobe" + FF.suffix)


def command(*args):
    return subprocess.check_output(args, stderr=subprocess.PIPE)


def verify_export(path):
    info = json.loads(command(PROBE, "-v", "error", "-show_format", "-show_streams", "-of", "json", path))
    assert {s["codec_type"] for s in info["streams"]} == {"video", "audio"}
    if "duration" in info["format"]:
        assert 1.65 < float(info["format"]["duration"]) < 2.45, info["format"]["duration"]
    # Streaming containers sometimes omit duration; verify the decoded audio length and actual signal.
    pcm = array.array("h", command(FF, "-v", "error", "-i", path, "-vn", "-f", "s16le", "-ac", "1", "-ar", "8000", "-"))
    assert 1.65 < len(pcm) / 8000 < 2.45 and max(pcm) > 500, len(pcm) / 8000
    expected_title, expected_caption = [], []
    for timestamp in ["0.45", "1.45"]:
        pixels = command(FF, "-v", "error", "-ss", timestamp,
                         "-i", path, "-an", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-")
        assert len(pixels) == 320 * 180 * 3
        center = (90 * 320 + 160) * 3
        assert pixels[center + 2] > 170 and pixels[center] < 60  # Kept blue section, not black opening.
        white = [i // 3 // 320 for i in range(0, len(pixels), 3) if min(pixels[i:i+3]) > 200]
        expected_title.append(sum(y < 75 for y in white))
        expected_caption.append(sum(y > 105 for y in white))
    assert min(expected_title) > 10 and expected_caption[0] > 10 and expected_caption[1] == 0, (expected_title, expected_caption)
    return f"{len(pcm) / 8000:.2f}s decoded audio; trimmed blue frames, opening title and timed caption verified"


def run():
    with tempfile.TemporaryDirectory(prefix="clip-browser-smoke-") as folder, sync_playwright() as pw:
        temp = Path(folder)
        source = temp / "synthetic.mp4"
        command(FF, "-v", "error", "-f", "lavfi", "-i",
                "color=c=black:s=320x180:r=30:d=4,drawbox=color=blue:w=iw:h=ih:t=fill:enable='gte(t,1)'",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-movflags", "+faststart", source)
        js = "import {createEditor} from './server.mjs';const s=createEditor(process.argv[1]);s.listen(0,'127.0.0.1',()=>console.log(s.address().port));"
        proc = subprocess.Popen(["node", "--input-type=module", "-e", js, str(temp / "absent-pin.json")],
                                cwd=ROOT, stdout=subprocess.PIPE, text=True)
        try:
            base = f"http://127.0.0.1:{int(proc.stdout.readline())}"
            browser = pw.chromium.launch(executable_path=os.environ["CLIP_BROWSER"])
            phone = browser.new_context(**pw.devices["Pixel 7"], accept_downloads=True)
            page = phone.new_page()
            errors, requests = [], []
            page.on("pageerror", lambda exc: errors.append(str(exc)))
            page.on("request", lambda r: requests.append((r.method, r.url)))
            page.goto(base)
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            page.locator("#file").set_input_files({"name": "not-video.mp4", "mimeType": "video/mp4", "buffer": b"not video"})
            expect(page.locator("#status")).to_contain_text("standalone MP4")
            page.locator("#file").set_input_files(source)
            expect(page.locator("#preview")).to_be_enabled()
            page.locator("#start").fill("1")
            page.locator("#end").fill("3")
            page.locator("#title").fill("Studio smoke")
            page.locator("#captions").fill("0 | 9 | Too long")
            expect(page.locator("#export")).to_be_disabled()
            page.locator("#captions").fill("0 | 1 | Caption")
            page.locator("#preview").click()
            expect(page.locator("#status")).to_have_text("Preview complete.")
            page.locator("#export").click()
            expect(page.locator("#download")).to_be_visible(timeout=12000)
            with page.expect_download() as save:
                page.locator("#download").click()
            exported = temp / save.value.suggested_filename
            save.value.save_as(exported)
            print(verify_export(exported))
            second = browser.new_context(**pw.devices["Pixel 7"])
            other = second.new_page()
            other.goto(base)
            expect(other.locator("#status")).to_have_text("No video selected.")
            assert not other.locator("#captions").input_value()
            assert not errors, errors
            assert all(url.startswith("blob:") or (verb == "GET" and url in {
                base + "/", base + "/editor.css", base + "/editor.js"}) for verb, url in requests), requests
            print("Phone viewport; file selection, invalid cut, preview, export, isolated second visit and no media uploads: OK")
            browser.close()
        finally:
            proc.terminate()
            proc.wait(timeout=10)


if __name__ == "__main__":
    run()
