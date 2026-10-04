"""Text to speech for the demo video: one audio file per line of the narration.

Run by `pnpm tsx video/voce.ts <it|en>`, which writes the lines to speak and
mixes the result into the film; it can be run alone too:

    python3 video/voce.py <it|en> <lines.json> <output folder>

lines.json is a list of {"id": "03", "text": "..."}; the output is <id>.wav for
each. The engine is Kokoro (Apache-2.0, 82 million parameters, runs on the
CPU, offline once its two model files are on disk). It is video tooling, like
ffmpeg and Chromium: nothing in the packages depends on it. Needs
`pip install kokoro-onnx soundfile` and the two model files named by
SIGILLO_TTS_MODEL (kokoro-v1.0.onnx) and SIGILLO_TTS_VOICES (voices-v1.0.bin),
from https://github.com/thewh1teagle/kokoro-onnx/releases (model-files-v1.0).

Another engine can replace this one: the mixer takes any <id>.wav or <id>.mp3
it finds in the folder.
"""
import json
import os
import re
import sys

import soundfile as sf
from kokoro_onnx import Kokoro

# Voice, Kokoro language code and speaking speed per video language.
VOICES = {
    "it": {"voice": os.environ.get("SIGILLO_TTS_VOICE_IT", "im_nicola"), "lang": "it", "speed": 0.95},
    "en": {"voice": os.environ.get("SIGILLO_TTS_VOICE_EN", "bm_george"), "lang": "en-gb", "speed": 0.97},
}

# Words the engine would read badly, written the way they are said.
SAID = {
    "it": [(r"\bAI\b", "A I"), (r"get-sigillo\.eu", "get sigillo punto e u")],
    "en": [(r"\bCVs\b", "C Vs"), (r"\bCV\b", "C V"), (r"\bAI\b", "A I"), (r"get-sigillo\.eu", "get sigillo dot e u")],
}


def spoken(language: str, text: str) -> str:
    for pattern, replacement in SAID[language]:
        text = re.sub(pattern, replacement, text)
    return text


def main() -> None:
    language, lines_file, folder = sys.argv[1], sys.argv[2], sys.argv[3]
    setting = VOICES[language]
    engine = Kokoro(os.environ["SIGILLO_TTS_MODEL"], os.environ["SIGILLO_TTS_VOICES"])
    os.makedirs(folder, exist_ok=True)
    with open(lines_file, encoding="utf-8") as handle:
        lines = json.load(handle)
    for line in lines:
        samples, rate = engine.create(spoken(language, line["text"]), voice=setting["voice"], speed=setting["speed"], lang=setting["lang"])
        sf.write(os.path.join(folder, f"{line['id']}.wav"), samples, rate)
        print(f"{line['id']}  {len(samples) / rate:5.1f} s  {line['text'][:60]}")


main()
