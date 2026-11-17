"""Local-only faster-whisper bridge. A model must already be installed."""
import json
import sys
from faster_whisper import WhisperModel

model = WhisperModel(sys.argv[2], device="cpu", compute_type="int8",
                     cpu_threads=4, local_files_only=True)
segments, info = model.transcribe(sys.argv[1], beam_size=3, vad_filter=True,
                                 word_timestamps=False)
print(json.dumps({
    "language": info.language,
    "segments": [{"start": s.start, "end": s.end, "text": s.text.strip()}
                 for s in segments],
}, ensure_ascii=False))
