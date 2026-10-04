/**
 * The machinery behind video/registra.ts: the real demo stack (signer and
 * server from the built `dist/`, the real `selezione-cv` agent), a screen
 * recorder built on Chromium's own screencast, and a visible mouse pointer
 * that moves the way a person moves it.
 *
 * Nothing here is part of any package, and nothing here touches the
 * application: the console is started exactly as demo/selezione-cv/run_demo.sh
 * starts it, and recorded from the outside.
 *
 * Why Chromium's screencast and not Playwright's `recordVideo`: the latter
 * encodes VP8 at a fixed, low bitrate, and at 1920×1080 the console's small
 * text comes out soft. The screencast hands over every repainted frame as a
 * high-quality JPEG; ffmpeg then lays them on a 30 fps timeline with the
 * wall-clock time each one arrived, so pauses last exactly as long on screen
 * as they did while recording.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LINGUA, T } from "./lingua.js";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const OUT = join(ROOT, "video", "out");
export const SIGNER = join(ROOT, "apps", "signer", "dist", "cli.js");
export const SERVER = join(ROOT, "apps", "server", "dist", "cli.js");
export const VERIFIER = join(ROOT, "packages", "verifier", "dist", "cli.js");
export const SYSTEM_ID = T.systemId;
export const PORT = Number(process.env["SIGILLO_VIDEO_PORT"] ?? "8123");
export const ADDRESS = `http://127.0.0.1:${PORT}`;
/** A throwaway password for a throwaway local server; never used anywhere else. */
export const ADMIN_PASSWORD = "demo-video-solo-locale";
/** The real RFC 3161 authority the demo stamps its checkpoints with, as run_demo.sh does. */
export const TSA_URL = process.env["SIGILLO_VIDEO_TSA"] ?? "https://freetsa.org/tsr";
export const PYTHON = process.env["SIGILLO_VIDEO_PYTHON"] ?? "python3";

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- the stack

/**
 * The demo's state (signing key, database, signer state, ingest token), kept
 * outside the repository: `pnpm lint` rightly refuses key material anywhere
 * in the tree, ignored or not.
 */
export const STATE = process.env["SIGILLO_VIDEO_STATE"] ?? join(tmpdir(), `sigillo-video-stato${T.suffix}`);
/** Where the running stack keeps its key, socket, database and signer state. */
export const WORK = join(STATE, "lavoro");

const processes: ChildProcess[] = [];

function node(args: string[]): string {
  return execFileSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
}

/** A brand new chain: a key, the system and its genesis receipt, an ingest token. */
export function freshState(): void {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  node([SIGNER, "keygen", "--key", join(WORK, "signer.key")]);
}

/** Starts the signer, and waits for its socket. */
async function startSigner(): Promise<void> {
  const socket = join(WORK, "signer.sock");
  rmSync(socket, { force: true });
  const signer = spawn(
    process.execPath,
    [SIGNER, "serve", "--key", join(WORK, "signer.key"), "--socket", socket, "--state", join(WORK, "signer-state")],
    { cwd: ROOT, stdio: "ignore" },
  );
  processes.push(signer);
  for (let i = 0; i < 100 && !existsSync(socket); i += 1) await sleep(100);
  if (!existsSync(socket)) throw new Error("the signer did not start");
}

/** Registers the system and returns a fresh ingest token for it (the signer must be running). */
export async function createSystem(): Promise<string> {
  await startSigner();
  const flags = ["--db", join(WORK, "sigillo.db"), "--signer-socket", join(WORK, "signer.sock")];
  node([SERVER, "system", "create", SYSTEM_ID, ...flags]);
  return node([SERVER, "key", "create", SYSTEM_ID, "--db", join(WORK, "sigillo.db")]).trim().split("\n").pop() ?? "";
}

/** Starts the server on PORT (the signer too, unless it already runs), and waits for /healthz. */
export async function startStack(): Promise<void> {
  if (processes.length === 0) await startSigner();
  const server = spawn(
    process.execPath,
    [
      SERVER,
      "serve",
      "--db",
      join(WORK, "sigillo.db"),
      "--signer-socket",
      join(WORK, "signer.sock"),
      "--port",
      String(PORT),
      "--checkpoint-minutes",
      "1000",
    ],
    { cwd: ROOT, stdio: "ignore", env: { ...process.env, SIGILLO_ADMIN_PASSWORD: ADMIN_PASSWORD } },
  );
  processes.push(server);
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${ADDRESS}/healthz`)).ok) return;
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  throw new Error(`the server did not answer on ${ADDRESS}`);
}

export async function stopStack(): Promise<void> {
  for (const child of processes.splice(0)) {
    child.kill("SIGTERM");
    await new Promise((resolve) => (child.exitCode !== null ? resolve(null) : child.once("exit", resolve)));
  }
}

/** Checkpoints every chain now and stamps it with the external authority, as run_demo.sh does. */
export function checkpoint(): string {
  return node([SERVER, "checkpoint", "--db", join(WORK, "sigillo.db"), "--signer-socket", join(WORK, "signer.sock"), "--tsa-url", TSA_URL]);
}

/** Copies the stopped stack's state aside, so a later scene can start from exactly here. */
export function saveState(name: string): void {
  const target = join(STATE, name);
  rmSync(target, { recursive: true, force: true });
  cpSync(WORK, target, { recursive: true, filter: (source) => !source.endsWith(".sock") });
}

/** Puts a saved state back in place, for re-recording one scene alone. */
export function restoreState(name: string): void {
  const source = join(STATE, name);
  if (!existsSync(source)) throw new Error(`no saved state "${name}": run "prepara" first (and scene 2 for the later scenes)`);
  rmSync(WORK, { recursive: true, force: true });
  cpSync(source, WORK, { recursive: true });
}

/**
 * Runs the real demo agent over the given CVs. The agent reads every CV in
 * the `curricula/` folder beside it, so it runs from a copy of
 * the demo's agent.py (demo/selezione-cv or demo/cv-screening, video/lingua.ts) next to a folder holding just these CVs: the
 * agent's code is the demo's, unchanged.
 */
export function agentRun(
  name: string,
  cvs: string[],
  token: string,
  onLine: (line: string) => void = () => {},
): Promise<number> {
  const folder = join(OUT, T.agentFolder, name);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(join(folder, "curricula"), { recursive: true });
  cpSync(join(ROOT, "demo", T.demo, "agent.py"), join(folder, "agent.py"));
  for (const cv of cvs) cpSync(join(ROOT, "demo", T.demo, "curricula", cv), join(folder, "curricula", cv));
  const child = spawn(PYTHON, ["-u", "agent.py"], {
    cwd: folder,
    env: {
      ...process.env,
      SIGILLO_ENDPOINT: ADDRESS,
      SIGILLO_API_KEY: token,
      SIGILLO_SYSTEM_ID: SYSTEM_ID,
      SIGILLO_DEMO_OUTBOX: join(OUT, "outbox"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  const take = (chunk: Buffer): void => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  return new Promise((resolve) =>
    child.on("exit", (code) => {
      if (buffer !== "") onLine(buffer);
      resolve(code ?? 1);
    }),
  );
}

// ------------------------------------------------------------- the browser

/** The same discovery as scripts/screenshots.ts: no browser is ever downloaded here. */
export function findBrowser(): string {
  const candidates: (string | undefined)[] = [process.env["SIGILLO_TEST_BROWSER"]];
  try {
    candidates.push(chromium.executablePath());
  } catch {
    // no Playwright download on this machine
  }
  const downloads = process.env["PLAYWRIGHT_BROWSERS_PATH"];
  if (downloads !== undefined && existsSync(downloads)) {
    for (const entry of readdirSync(downloads).filter((name) => /^chromium-\d+$/.test(name)).sort().reverse()) {
      candidates.push(join(downloads, entry, "chrome-linux64", "chrome"), join(downloads, entry, "chrome-linux", "chrome"));
    }
  }
  candidates.push("/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser");
  const found = candidates.find((path) => path !== undefined && path !== "" && existsSync(path));
  if (found === undefined) throw new Error("no Chromium or Chrome found: set SIGILLO_TEST_BROWSER");
  return found;
}

export async function launch(): Promise<Browser> {
  // The video's language all the way down: the locale option alone leaves the
  // browser's own controls (a date field's "mm/dd/yyyy", "Choose File") in the
  // process's language.
  return chromium.launch({
    executablePath: findBrowser(),
    args: ["--hide-scrollbars", "--force-color-profile=srgb", `--lang=${T.locale}`],
    env: { ...process.env, LANG: T.posixLocale, LANGUAGE: LINGUA, LC_ALL: T.posixLocale },
  });
}

/**
 * The pointer drawn over the page: a dark ring with a light core that a
 * click briefly fills. It follows the real mouse events Playwright sends, so
 * it is wherever the page itself believes the mouse is.
 */
const POINTER_SCRIPT = `(() => {
  const install = () => {
    if (document.getElementById("__video-pointer")) return;
    const dot = document.createElement("div");
    dot.id = "__video-pointer";
    dot.setAttribute("aria-hidden", "true");
    Object.assign(dot.style, {
      position: "fixed", left: "0px", top: "0px", width: "30px", height: "30px", margin: "-15px 0 0 -15px",
      borderRadius: "50%", border: "3px solid rgba(29,29,31,0.85)", background: "rgba(255,255,255,0.35)",
      boxShadow: "0 1px 6px rgba(0,0,0,0.25)", zIndex: "2147483647", pointerEvents: "none",
      transition: "transform 120ms ease, background 120ms ease", transform: "scale(1)",
    });
    const start = window.__videoPointer || { x: -100, y: -100 };
    dot.style.left = start.x + "px"; dot.style.top = start.y + "px";
    document.documentElement.appendChild(dot);
    addEventListener("mousemove", (e) => { dot.style.left = e.clientX + "px"; dot.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => { dot.style.transform = "scale(0.78)"; dot.style.background = "rgba(10,132,255,0.45)"; }, true);
    addEventListener("mouseup", () => { dot.style.transform = "scale(1)"; dot.style.background = "rgba(255,255,255,0.35)"; }, true);
  };
  if (document.documentElement) install(); else addEventListener("DOMContentLoaded", install);
  addEventListener("DOMContentLoaded", install);
})();`;

/** A page with the pointer, and the motions a person makes with it. */
export class Actor {
  x = 960;
  y = 600;
  constructor(readonly page: Page) {}

  static async open(context: BrowserContext): Promise<Actor> {
    await context.addInitScript(POINTER_SCRIPT);
    const actor = new Actor(await context.newPage());
    return actor;
  }

  /** Puts the pointer back where it was after a navigation (the new document starts without one). */
  async settle(): Promise<void> {
    // Evaluated as a string: these scripts run in the page, and this project's TypeScript has no DOM types.
    await this.page.evaluate(`(() => {
      window.__videoPointer = { x: ${this.x}, y: ${this.y} };
      const dot = document.getElementById("__video-pointer");
      if (dot !== null) { dot.style.left = "${this.x}px"; dot.style.top = "${this.y}px"; }
    })()`);
    await this.page.mouse.move(this.x, this.y);
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url);
    await this.settle();
  }

  /** Moves in a gentle ease-in-out curve, slower over longer distances. */
  async moveTo(x: number, y: number, ms?: number): Promise<void> {
    const distance = Math.hypot(x - this.x, y - this.y);
    const duration = ms ?? Math.min(1400, 450 + distance * 0.9);
    const steps = Math.max(8, Math.round(duration / 16));
    const fromX = this.x;
    const fromY = this.y;
    // A slight arc, as a wrist draws it, rather than a ruler-straight line.
    const bend = Math.min(60, distance * 0.08);
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const ease = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      const arc = Math.sin(Math.PI * t) * bend;
      const px = fromX + (x - fromX) * ease;
      const py = fromY + (y - fromY) * ease - arc;
      await this.page.mouse.move(px, py);
      await sleep(duration / steps);
    }
    this.x = x;
    this.y = y;
  }

  /** The point to aim at inside an element: its centre, or an offset from its left edge. */
  async aim(locator: Locator, fromLeft?: number): Promise<{ x: number; y: number }> {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (box === null) throw new Error(`not visible: ${locator.toString()}`);
    return { x: fromLeft === undefined ? box.x + box.width / 2 : box.x + Math.min(fromLeft, box.width / 2), y: box.y + box.height / 2 };
  }

  async hover(locator: Locator, fromLeft?: number): Promise<void> {
    const { x, y } = await this.aim(locator, fromLeft);
    await this.moveTo(x, y);
  }

  /** Moves to an element, pauses, clicks, and pauses again: nothing faster than a person. */
  async click(locator: Locator, options: { fromLeft?: number; before?: number; after?: number; navigates?: boolean } = {}): Promise<void> {
    await this.hover(locator, options.fromLeft);
    await sleep(options.before ?? 700);
    if (options.navigates === true) {
      await Promise.all([this.page.waitForNavigation(), this.press()]);
      await this.settle();
    } else {
      await this.press();
    }
    await sleep(options.after ?? 1000);
  }

  private async press(): Promise<void> {
    await this.page.mouse.down();
    await sleep(110);
    await this.page.mouse.up();
  }

  /** Scrolls the element under the pointer smoothly, by `pixels` (negative scrolls up). */
  async scroll(pixels: number, ms = 1600): Promise<void> {
    const steps = Math.max(10, Math.round(ms / 16));
    let done = 0;
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const target = Math.round(pixels * ease);
      await this.page.mouse.wheel(0, target - done);
      done = target;
      await sleep(ms / steps);
    }
  }
}

/**
 * Records one page through Chromium's screencast. Each frame is written as
 * it arrives, with the wall-clock time it arrived; `stop` then hands ffmpeg a
 * concat list that shows each frame exactly until the next one came.
 */
export class Recorder {
  private cdp: CDPSession | null = null;
  private frames: { file: string; at: number }[] = [];
  private startedAt = 0;
  private stoppedAt = 0;
  private pending: Promise<void>[] = [];

  constructor(
    private readonly page: Page,
    private readonly directory: string,
    private readonly size: { width: number; height: number },
  ) {}

  async start(): Promise<void> {
    rmSync(this.directory, { recursive: true, force: true });
    mkdirSync(this.directory, { recursive: true });
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on("Page.screencastFrame", (frame: { data: string; sessionId: number }) => {
      const at = Date.now();
      const file = join(this.directory, `f${String(this.frames.length).padStart(6, "0")}.jpg`);
      this.frames.push({ file, at });
      writeFileSync(file, Buffer.from(frame.data, "base64"));
      this.pending.push(this.cdp?.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).then(() => undefined) ?? Promise.resolve());
    });
    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 95,
      maxWidth: this.size.width,
      maxHeight: this.size.height,
      everyNthFrame: 1,
    });
    // A first frame even if nothing moves: nudge a repaint.
    await this.page.evaluate("document.body.getBoundingClientRect()");
    this.startedAt = Date.now();
  }

  async stop(): Promise<{ startedAt: number; stoppedAt: number }> {
    this.stoppedAt = Date.now();
    await this.cdp?.send("Page.stopScreencast");
    await Promise.allSettled(this.pending);
    await this.cdp?.detach();
    return { startedAt: this.startedAt, stoppedAt: this.stoppedAt };
  }

  /**
   * Encodes the frames between `from` and `to` (wall-clock ms; the whole
   * recording by default) into an H.264 MP4 at 30 fps.
   */
  encode(output: string, from = this.startedAt, to = this.stoppedAt): void {
    if (this.frames.length === 0) throw new Error(`no frames recorded in ${this.directory}`);
    const lines = ["ffconcat version 1.0"];
    const shown = this.frames.filter((frame, index) => {
      const next = this.frames[index + 1];
      return frame.at < to && (next === undefined || next.at > from);
    });
    shown.forEach((frame, index) => {
      const begin = Math.max(frame.at, from);
      const end = Math.min(shown[index + 1]?.at ?? to, to);
      lines.push(`file '${frame.file}'`, `duration ${((end - begin) / 1000).toFixed(4)}`);
    });
    // The concat demuxer ignores the last entry's duration: repeat it.
    lines.push(`file '${shown[shown.length - 1]?.file ?? ""}'`);
    const list = join(this.directory, "frames.ffconcat");
    writeFileSync(list, `${lines.join("\n")}\n`);
    encodeConcat(list, output, this.size);
  }
}

/** ffmpeg: a frame list to H.264, 30 fps constant, padded to the exact size. */
export function encodeConcat(list: string, output: string, size: { width: number; height: number }): void {
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", list,
    "-vf", `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2:color=white,fps=30,format=yuv420p`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-tune", "stillimage",
    "-movflags", "+faststart", output,
  ]);
}

// ------------------------------------------------------- terminal and titles

/** A woff2 from the console's own font folder, as a data URL (a set-content page has no origin to load it from). */
export function fontUrl(name: string): string {
  const bytes = readFileSync(join(ROOT, "apps", "server", "assets", "fonts", name));
  return `data:font/woff2;base64,${bytes.toString("base64")}`;
}

/**
 * A terminal window, drawn in a page of its own so it can be recorded beside
 * or between the console's. It only ever shows what really ran: `run` types
 * the command, executes exactly that string with bash, and prints its real
 * output as it arrives.
 */
export class Terminal {
  constructor(
    readonly page: Page,
    private readonly cwdLabel: string,
  ) {}

  static async open(context: BrowserContext, options: { fontSize: number; cwdLabel: string; title: string }): Promise<Terminal> {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Plex; src: url(${fontUrl("ibm-plex-mono-latin-400-normal.woff2")}) format("woff2"); font-weight: 400; }
@font-face { font-family: Plex; src: url(${fontUrl("ibm-plex-mono-latin-500-normal.woff2")}) format("woff2"); font-weight: 500; }
html, body { margin: 0; height: 100%; background: #e9e9ee; }
.window { position: absolute; inset: 14px; border-radius: 12px; overflow: hidden; background: #1d1f24; box-shadow: 0 8px 30px rgba(0,0,0,0.25); display: flex; flex-direction: column; }
.bar { height: 38px; flex: none; background: #2b2e35; display: flex; align-items: center; padding: 0 14px; gap: 8px; color: #b9bcc6; font: 500 14px Plex, monospace; }
.bar i { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
.bar span { margin-left: 12px; }
pre { flex: 1; margin: 0; padding: 18px 22px; overflow: hidden; color: #e6e7eb; font: 400 ${options.fontSize}px/1.5 Plex, monospace; white-space: pre-wrap; word-break: break-all; }
.prompt { color: #7fd1a8; } .cmd { color: #ffffff; font-weight: 500; } .ok { color: #7fd1a8; font-weight: 500; } .bad { color: #ff8a80; font-weight: 500; } .dim { color: #9aa0ac; }
.caret { display: inline-block; width: 0.6em; height: 1.15em; vertical-align: text-bottom; background: #e6e7eb; animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }
</style></head><body><div class="window"><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span>${options.title}</span></div><pre id="screen"></pre></div>
<script>
const screen = document.getElementById("screen");
let caret = document.createElement("span"); caret.className = "caret";
screen.appendChild(caret);
window.term = {
  clear() { while (screen.firstChild !== caret) screen.removeChild(screen.firstChild); },
  add(text, cls) { const span = document.createElement("span"); if (cls) span.className = cls; span.textContent = text; screen.insertBefore(span, caret); screen.scrollTop = screen.scrollHeight; return span; },
};
</script></body></html>`);
    const terminal = new Terminal(page, options.cwdLabel);
    await terminal.showPrompt();
    return terminal;
  }

  private async add(text: string, cls = ""): Promise<void> {
    await this.page.evaluate(`window.term.add(${JSON.stringify(text)}, ${JSON.stringify(cls)})`);
  }

  async showPrompt(): Promise<void> {
    await this.add(`${this.cwdLabel} $ `, "prompt");
  }

  /** Types a command the way a person does: not fast, not evenly. */
  async type(command: string, perChar = 45): Promise<void> {
    for (const char of command) {
      await this.add(char, "cmd");
      await sleep(perChar * (0.6 + Math.random() * 0.8));
    }
  }

  /** Types `command`, waits a beat, runs it for real in `cwd`, prints its output, and shows the next prompt. */
  async run(command: string, cwd: string, env: NodeJS.ProcessEnv = {}, colour?: (line: string) => string): Promise<number> {
    await this.type(command);
    await sleep(350);
    await this.add("\n");
    const child = spawn("bash", ["-c", command], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const queue: Promise<void>[] = [];
    let buffer = "";
    const take = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) queue.push(this.add(`${line}\n`, colour?.(line) ?? ""));
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const code: number = await new Promise((resolve) => child.on("exit", (exit) => resolve(exit ?? 1)));
    if (buffer !== "") queue.push(this.add(`${buffer}\n`, colour?.(buffer) ?? ""));
    await Promise.all(queue);
    await this.showPrompt();
    return code;
  }

  /** Types `clear` and empties the window, as the shell's `clear` does. */
  async clear(): Promise<void> {
    await this.type("clear");
    await sleep(350);
    await this.page.evaluate(`window.term.clear()`);
    await this.showPrompt();
  }
}

/** A title card as a transparent PNG, set in the console's own typefaces. */
export async function renderTitle(browser: Browser, file: string, title: string, subtitle: string): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Newsreader; src: url(${fontUrl("newsreader-latin-600-normal.woff2")}) format("woff2"); font-weight: 600; }
@font-face { font-family: PublicSans; src: url(${fontUrl("public-sans-latin-500-normal.woff2")}) format("woff2"); font-weight: 500; }
html, body { margin: 0; height: 100%; background: transparent; }
body { display: flex; align-items: center; justify-content: center; background: rgba(250,250,252,0.9); }
.card { text-align: center; max-width: 1400px; padding: 0 60px; }
.brand { display: inline-flex; align-items: center; gap: 14px; font: 500 30px PublicSans, sans-serif; color: #1d1d1f; margin-bottom: 34px; }
.brand svg { width: 52px; height: 52px; }
h1 { margin: 0; font: 600 76px/1.12 Newsreader, serif; color: #1d1d1f; letter-spacing: -0.5px; }
p { margin: 28px 0 0; font: 500 32px PublicSans, sans-serif; color: #636366; }
</style></head><body><div class="card">
<div class="brand"><svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="22" fill="none" stroke="#8e2a24" stroke-width="2"/><circle cx="24" cy="24" r="16" fill="none" stroke="#8e2a24" stroke-width="1.25"/><polygon points="24,15 33,24 24,33 15,24" fill="#8e2a24"/></svg>sigillo</div>
<h1>${title}</h1>${subtitle === "" ? "" : `<p>${subtitle}</p>`}
</div></body></html>`);
  await page.evaluate("document.fonts.ready");
  await page.screenshot({ path: file, omitBackground: true });
  await page.close();
}
