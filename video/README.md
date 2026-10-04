# The demo video, as a real screen capture

`video/` records the Sigillo demo video from the real web console running
locally with the data of the `selezione-cv` demo (`demo/selezione-cv`: the
real LangGraph agent, the 20 fictional CVs). Every frame is the real console
or the real output of a real command; nothing is mocked up. The scripts are
not part of any package and add no dependency: they use `playwright-core`
(already a root devDependency), the built `dist/` of the signer, server and
verifier, ffmpeg, and Chromium.

## Running it

From the repository root, after `pnpm install && pnpm build` and with the
demo's Python dependencies installed (`demo/selezione-cv/README.md`):

```bash
export SIGILLO_VIDEO_PYTHON=/path/to/python3   # the interpreter that has langgraph and sigillo
pnpm tsx video/registra.ts tutto               # prepare the data, record the six scenes, titles, subtitles
video/monta.sh                                 # join them: video/out/sigillo-demo.mp4 and .srt
```

For the English video, set `SIGILLO_VIDEO_LANG=en` for both commands: the
browser asks the console for English, and everything that is the video's own
(the system's name, the terminal, the one-character tool, the titles, the
subtitles) follows `video/lingua.ts`. The output gets an `-en` suffix
(`out/scene-en/`, `sigillo-demo-en.mp4`, `sigillo-demo-en.srt`,
`sigillo-demo-en-subtitled.mp4`) and its own saved state, so the two
languages never mix. The English video also runs the English edition of the
demo, `demo/cv-screening`: the same agent and CVs, in English (tools
`read_cv`, `evaluate_candidate`, `send_email`; CVs `candidate-XX.txt`), so
nothing on screen is Italian.

One scene can be redone alone, from the state it needs:
`pnpm tsx video/registra.ts scena 3`, then `video/monta.sh` again.

Needs network access to the timestamp authority (freetsa.org, the same one
`run_demo.sh` uses; `SIGILLO_VIDEO_TSA` to change it) and, for the end of
scene 6, to `get-sigillo.eu`.

## Files

| file | what it is |
|---|---|
| `registra.ts` | the scenes, the demo data, the title cards, the subtitles |
| `lib.ts` | the stack (signer and server from `dist/`), the screen recorder, the pointer, the terminal window |
| `cambia-un-carattere.mjs` | writes a copy of a fascicolo or a CV with exactly one character changed, and says which (scene 5) |
| `parlato.ts` | the narration, scene by scene, in Italian and English: voice-over text and subtitles |
| `lingua.ts` | the language of the recording (`SIGILLO_VIDEO_LANG`), and the words on screen that depend on it |
| `voce.ts` | the voice-over: reads the narration and the delivered film and subtitles, has each line spoken, places it, mixes it, writes the films with voice |
| `voce.py` | text to speech, one audio file per line of the narration (Kokoro, offline, on the CPU) |
| `monta.sh` | ffmpeg: titles over scenes 1 and 6, a short fade at each cut, H.264 30 fps, no audio (`voce.ts` adds it later) |
| `out/` | everything produced (ignored by git): `scene/*.mp4` one per scene, `sigillo-demo.mp4`, `sigillo-demo.srt` |
| `consegna/` | the delivered copy of the recording of 2026-10-04: the six scenes, the joined film, the subtitles; `consegna/en/` the same in English |

The demo's state (signing key, database, ingest token) lives outside the
repository, in the system temporary directory (`SIGILLO_VIDEO_STATE` to
change it): `pnpm lint` refuses key material anywhere in the tree.

## The voice-over

The films in `consegna/` have no sound. `voce.ts` adds a voice to the delivered
ones, in the same language as the subtitles:

```bash
python3 -m venv /tmp/tts && /tmp/tts/bin/pip install kokoro-onnx soundfile
# the two model files, from https://github.com/thewh1teagle/kokoro-onnx/releases (model-files-v1.0):
#   kokoro-v1.0.onnx and voices-v1.0.bin
export SIGILLO_TTS_PYTHON=/tmp/tts/bin/python SIGILLO_TTS_MODEL=/path/kokoro-v1.0.onnx SIGILLO_TTS_VOICES=/path/voices-v1.0.bin
pnpm tsx video/voce.ts it      # and: pnpm tsx video/voce.ts en
```

It writes next to the silent films `sigillo-demo-voce.mp4` and its `.srt`
(English: `sigillo-demo-en-voice*`). The subtitles stay a separate `.srt`, which
the site's player offers as a track that can be switched on and off. Each
line of `parlato.ts` starts where its subtitle started, waits for the line before
it, and the closing lines may start up to four seconds early so the voice ends
before the film does. The subtitles are laid again over the speech that was
really spoken, so the `-voce.srt` is the one to use with the `-voce.mp4`, not the
old one. The voice track is levelled to -16 LUFS; the picture is copied, not
encoded again.

The English voice is Kokoro's `bm_george`, set in `voce.py`
(`SIGILLO_TTS_VOICE_EN` changes it). The delivered Italian voice is not Kokoro's,
which sounded too flat: it is the Qwen text-to-speech model, run through
Higgsfield with `language: it` and an instruction asking for a warm, expressive
narrator, one wav per line dropped into `out/voce-it/` (see below). It is
tooling for the video, like ffmpeg and Chromium; no package depends on it.
Another engine, a studio-grade one for instance, can replace it without
touching the mixer: `pnpm tsx video/voce.ts it testo` writes
`out/voce-it/lines.json`, put one `<id>.wav` or `<id>.mp3` per line next to it,
and `pnpm tsx video/voce.ts it mixa` does the rest.

## How it is recorded, and what that changes

- **The data.** `prepara` starts a throwaway signer and server exactly as
  `run_demo.sh` does, names the system from its settings page, runs the real
  agent over CVs 01–14, and seals with the external authority. Scene 2 runs
  the agent over CVs 15–20 live, one CV per run (so the console visibly
  updates six times; in one run the SDK would send everything at the end),
  from a copy of `agent.py` beside a folder holding that one CV: the agent's
  code is unchanged. The model is the demo's deterministic stand-in
  (`FakeRationaleModel`, see the demo's README), and the console says so.
- **The capture.** Chromium's own screencast, not Playwright's `recordVideo`
  (which encodes at a low fixed bitrate that blurs the console's small text):
  every repainted frame is kept as a JPEG with the time it arrived, and ffmpeg
  lays them on a 30 fps timeline. The pointer is a ring drawn over the page
  that follows the real mouse events; it moves on eased, slightly curved
  paths with a pause before and after every click.
- **The terminal** in scenes 2 and 5 is a window drawn in a page of its own,
  so it can be recorded beside or between the console's. It shows only what
  ran: each command is typed, then executed with bash exactly as shown, and
  its real output is printed as it arrives. `sigillo-verify` is
  `packages/verifier/dist/cli.js`, put on `PATH` under the name its package
  gives it.
- **The public site.** In the environment this was recorded in, outbound
  traffic goes through a proxy that serves `curl` but answers the browser
  with an error, so the browser is handed exactly the bytes `curl` fetched
  from `https://get-sigillo.eu/ui/login` (where `https://get-sigillo.eu/`
  lands). There is no separate marketing site: `design/sito/` does not exist.
- **The browser is Italian** (`--lang`, `LANG`), so its own controls read
  "gg/mm/aaaa" and "Scegli file", as an Italian viewer's would.
