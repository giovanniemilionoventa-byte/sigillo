/**
 * The voice-over of the demo video, added to the delivered film.
 *
 *   pnpm tsx video/voce.ts it        # or en: speak, place, mix, write the films
 *   pnpm tsx video/voce.ts it testo  # only write the lines to speak (out/voce-it/lines.json)
 *   pnpm tsx video/voce.ts it mixa   # only mix: the audio files are already in out/voce-it/
 *
 * The words are those of video/parlato.ts, the same as the subtitles. Each
 * line is spoken by video/voce.py (any other engine can take its place: put a
 * <id>.wav or <id>.mp3 per line in out/voce-<language>/ and run `mixa`). A line
 * starts where its first subtitle cue starts in the delivered film, and
 * waits for the previous line to finish when it spoke longer than its window;
 * a line that would run too far behind the picture is sped up a little. The
 * subtitles are then laid again over the speech that was really spoken.
 *
 * Reads the delivered film and subtitles of the recording (video/consegna/,
 * video/consegna/en/) and writes next to them <name>-voce|voice.mp4 (voice,
 * no subtitles), its .srt, and <name>-voce|voice-sottotitolato|subtitled.mp4
 * (voice and subtitles burned in). Needs ffmpeg and, to speak, the Python
 * of video/voce.py (SIGILLO_TTS_PYTHON, default python3).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PARLATO } from "./parlato.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argument = process.argv[2];
if (argument !== "it" && argument !== "en") throw new Error("usage: pnpm tsx video/voce.ts <it|en> [testo|mixa]");
const language: "it" | "en" = argument;
const step = process.argv[3] ?? "tutto";

const NAMES = {
  it: { dir: join(ROOT, "video", "consegna"), base: "sigillo-demo", voice: "voce", subtitled: "sottotitolato" },
  en: { dir: join(ROOT, "video", "consegna", "en"), base: "sigillo-demo-en", voice: "voice", subtitled: "subtitled" },
}[language];
const WORK = join(ROOT, "video", "out", `voce-${language}`);
const FILM = join(NAMES.dir, `${NAMES.base}.mp4`);
const SRT = join(NAMES.dir, `${NAMES.base}.srt`);

/** Pause kept between two lines, in seconds, and the most a line may be sped up. */
const PAUSE = 0.35;
const MAX_SPEEDUP = 1.15;
/** How far behind its subtitle window a line may start before it is sped up. */
const MAX_LAG = 1.5;
/** The closing seconds of the film, whose lines may start earlier than their subtitles did, by at most MAX_EARLIER seconds. */
const ENDING = 15;
const MAX_EARLIER = 4;

type Cue = { start: number; end: number; text: string };
type Line = { id: string; text: string; cues: Cue[]; start: number };

const seconds = (file: string): number =>
  Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).trim());

function readSrt(file: string): Cue[] {
  const time = (t: string): number => {
    const m = /^(\d+):(\d+):(\d+),(\d+)$/.exec(t.trim());
    if (!m) throw new Error(`bad time ${t} in ${file}`);
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
  };
  return readFileSync(file, "utf8").trim().split(/\n\n+/).map((block) => {
    const [, when = "", ...rows] = block.split("\n");
    const [from = "", to = ""] = when.split(" --> ");
    return { start: time(from), end: time(to), text: rows.join(" ") };
  });
}

function stamp(t: number): string {
  const ms = Math.round(t * 1000);
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

/** The narration's lines, each with the subtitle cues that carry it in the delivered film. */
function lines(): Line[] {
  const cues = readSrt(SRT);
  const out: Line[] = [];
  let next = 0;
  for (const { lines: texts } of PARLATO[language]) {
    for (const text of texts) {
      const mine: Cue[] = [];
      let joined = "";
      while (joined !== text) {
        const cue = cues[next];
        if (!cue || joined.length >= text.length) throw new Error(`the subtitles of ${SRT} do not match parlato.ts at: ${text}`);
        mine.push(cue);
        next += 1;
        joined = joined === "" ? cue.text : `${joined} ${cue.text}`;
      }
      out.push({ id: String(out.length + 1).padStart(2, "0"), text, cues: mine, start: mine[0]?.start ?? 0 });
    }
  }
  if (next !== cues.length) throw new Error(`${SRT} has cues that parlato.ts does not`);
  return out;
}

function testo(all: Line[]): void {
  mkdirSync(WORK, { recursive: true });
  writeFileSync(join(WORK, "lines.json"), JSON.stringify(all.map(({ id, text }) => ({ id, text })), null, 2));
}

function parla(): void {
  const python = process.env["SIGILLO_TTS_PYTHON"] ?? "python3";
  execFileSync(python, [join(ROOT, "video", "voce.py"), language, join(WORK, "lines.json"), WORK], { stdio: "inherit" });
}

/** A line's audio file with the silence at both ends cut off, as a 48 kHz mono wav. */
function trimmed(id: string): string {
  const source = [`${id}.wav`, `${id}.mp3`].map((name) => join(WORK, name)).find((file) => existsSync(file));
  if (!source) throw new Error(`no audio for line ${id} in ${WORK}`);
  const cut = "silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB";
  const out = join(WORK, `${id}.cut.wav`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", source, "-af", `${cut},areverse,${cut},areverse`, "-ar", "48000", "-ac", "1", out]);
  return out;
}

function mixa(all: Line[]): void {
  const film = seconds(FILM);
  const parts = all.map((line) => {
    const file = trimmed(line.id);
    return { line, file, length: seconds(file) };
  });

  // Place every line, in order. If the voice would run past the end of the film, the closing lines start a little earlier, a quarter of a second at a time.
  const place = (earlier: number) => {
    let free = 0;
    return parts.map(({ line, file, length }) => {
      const closing = line.start > film - ENDING;
      const wanted = Math.max(closing ? line.start - earlier : line.start, free);
      const lag = Math.max(0, wanted - line.start);
      // Late by more than MAX_LAG: speed up so that the next lines do not slip further.
      const lagSpeed = lag > MAX_LAG ? Math.min(MAX_SPEEDUP, 1 + (lag - MAX_LAG) / 6) : 1;
      const speed = lagSpeed;
      const spoken = length / speed;
      free = wanted + spoken + PAUSE;
      return { line, file, speed, start: wanted, end: wanted + spoken, lag };
    });
  };
  let earlier = 0;
  let placed = place(earlier);
  while ((placed[placed.length - 1]?.end ?? 0) > film - 0.8 && earlier < MAX_EARLIER) {
    earlier += 0.25;
    placed = place(earlier);
  }
  const last = placed[placed.length - 1];
  for (const { line, start, end, speed, lag } of placed) {
    process.stdout.write(`${line.id}  ${start.toFixed(1).padStart(6)}-${end.toFixed(1).padStart(6)} s  late ${lag.toFixed(1)} s  speed x${speed.toFixed(2)}\n`);
  }
  if (last && last.end > film - 0.8) throw new Error(`the voice ends at ${last.end.toFixed(1)} s, after the film (${film.toFixed(1)} s)`);

  // One audio track: every line delayed to its place, summed, levelled, faded at both ends.
  const inputs = placed.flatMap(({ file }) => ["-i", file]);
  const delays = placed.map(({ start, speed }, i) => `[${i}:a]atempo=${speed.toFixed(4)},adelay=${Math.round(start * 1000)}:all=1[a${i}]`);
  const mix = `${placed.map((_, i) => `[a${i}]`).join("")}amix=inputs=${placed.length}:normalize=0:duration=longest,loudnorm=I=-16:TP=-1.5:LRA=7,apad=whole_dur=${film.toFixed(3)},atrim=0:${film.toFixed(3)},afade=t=in:d=0.3,afade=t=out:st=${(film - 0.8).toFixed(3)}:d=0.8[voice]`;
  const track = join(WORK, "voce.wav");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", [...delays, mix].join(";"), "-map", "[voice]", "-ar", "48000", "-ac", "2", track]);

  // The film with the voice: the picture is copied, not encoded again.
  const withVoice = join(NAMES.dir, `${NAMES.base}-${NAMES.voice}.mp4`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", FILM, "-i", track, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", withVoice]);

  // The subtitles again, over the speech that was spoken.
  const srt = rebuildSrt(placed);
  const withVoiceSrt = join(NAMES.dir, `${NAMES.base}-${NAMES.voice}.srt`);
  writeFileSync(withVoiceSrt, srt);

  // The same film with the subtitles burned in, as monta.sh does.
  const burned = join(NAMES.dir, `${NAMES.base}-${NAMES.voice}-${NAMES.subtitled}.mp4`);
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-i", withVoice, "-vf",
    `subtitles=${withVoiceSrt}:charenc=UTF-8:force_style='FontName=DejaVu Sans,FontSize=13,PrimaryColour=&H00FFFFFF,BackColour=&H99000000,BorderStyle=4,Outline=0,Shadow=0,MarginV=22,Alignment=2'`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", burned,
  ]);

  process.stdout.write(`wrote ${withVoice}\nwrote ${withVoiceSrt}\nwrote ${burned}\n`);
}

/** The .srt of the placed lines: a line's cues share its speaking time by length, and keep their two rows. */
function rebuildSrt(placed: { line: Line; start: number; end: number }[]): string {
  const rows = readFileSync(SRT, "utf8").trim().split(/\n\n+/).map((block) => block.split("\n").slice(2).join("\n"));
  const out: string[] = [];
  let index = 0;
  for (const { line, start, end } of placed) {
    const weight = line.cues.reduce((sum, cue) => sum + cue.text.length + 12, 0);
    let t = start;
    for (const cue of line.cues) {
      const length = ((cue.text.length + 12) / weight) * (end - start);
      out.push(`${out.length + 1}`, `${stamp(t)} --> ${stamp(t + length - 0.05)}`, rows[index] ?? cue.text, "");
      index += 1;
      t += length;
    }
  }
  return out.join("\n");
}

const all = lines();
if (step === "testo" || step === "tutto") testo(all);
if (step === "tutto") parla();
if (step === "mixa" || step === "tutto") mixa(all);
