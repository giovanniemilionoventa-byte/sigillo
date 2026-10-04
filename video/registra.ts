/**
 * Records the Sigillo demo video as a real screen capture of the real web
 * console, one scene at a time, with the data of the `selezione-cv` demo
 * (demo/selezione-cv: the real agent, the 20 fictional CVs).
 *
 *   pnpm tsx video/registra.ts prepara        fresh chain, CVs 01-14 screened, first seal
 *   pnpm tsx video/registra.ts scena 2        one scene (1 to 6), from the state it needs
 *   pnpm tsx video/registra.ts tutto          prepara, then every scene in order
 *   pnpm tsx video/registra.ts sopralluogo    screenshots of the pages the scenes use
 *
 * The demo's state lives outside the repository (lib.ts, STATE). Then video/monta.sh adds the titles and joins the scenes.
 *
 * State: "prepara" leaves a saved state "dopo-preparazione" (14 CVs screened
 * this morning, one seal from the external authority). Scene 2 screens CVs
 * 15-20 live while the console is on screen, seals again, and saves
 * "dopo-scena-2", which scenes 3 to 6 start from. Any scene can be redone
 * alone: it puts its starting state back first.
 *
 * Needs: `pnpm build` (the signer, server and verifier run from dist/), the
 * demo's Python dependencies (demo/selezione-cv/README.md; point
 * SIGILLO_VIDEO_PYTHON at the interpreter that has them), ffmpeg, a Chromium,
 * and network access to the timestamp authority (freetsa.org by default).
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright-core";
import {
  ADDRESS,
  Terminal,
  renderTitle,
  ADMIN_PASSWORD,
  Actor,
  OUT,
  ROOT,
  STATE,
  Recorder,
  SYSTEM_ID,
  VERIFIER,
  agentRun,
  checkpoint,
  createSystem,
  freshState,
  launch,
  restoreState,
  saveState,
  sleep,
  startStack,
  stopStack,
  WORK,
} from "./lib.js";
import { PARLATO } from "./parlato.js";

const SCENES = join(OUT, "scene");
const FULL = { width: 1920, height: 1080 };
const DISPLAY_NAME = "Selezione CV — backend junior";
const cv = (n: number): string => `candidato-${String(n).padStart(2, "0")}.txt`;
const MORNING = Array.from({ length: 14 }, (_, i) => cv(i + 1));
const LIVE = Array.from({ length: 6 }, (_, i) => cv(i + 15));

const tokenFile = join(WORK, "token.txt");

async function signedIn(browser: Browser, size = FULL): Promise<{ context: BrowserContext; actor: Actor }> {
  const context = await browser.newContext({ viewport: size, colorScheme: "light", acceptDownloads: true });
  const actor = await Actor.open(context);
  await actor.page.goto(`${ADDRESS}/ui/login`);
  await actor.page.fill('input[name="password"]', ADMIN_PASSWORD);
  await Promise.all([actor.page.waitForNavigation(), actor.page.click('button[type="submit"]')]);
  return { context, actor };
}

// ----------------------------------------------------------------- prepara

async function prepara(): Promise<void> {
  await stopStack();
  freshState();
  const token = await createSystem();
  writeFileSync(tokenFile, token);
  await startStack();

  // The name the console shows, given the way an administrator gives it: the system's settings page.
  const browser = await launch();
  const { context, actor } = await signedIn(browser);
  await actor.page.goto(`${ADDRESS}/ui/systems/${SYSTEM_ID}/manage`);
  await actor.page.fill(`form[action$="/rename"] input[name="display_name"]`, DISPLAY_NAME);
  await Promise.all([actor.page.waitForNavigation(), actor.page.click(`form[action$="/rename"] button[type="submit"]`)]);
  await context.close();
  await browser.close();

  const code = await agentRun("mattina", MORNING, token, (line) => process.stdout.write(`  agent | ${line}\n`));
  if (code !== 0) throw new Error(`the agent exited with ${code}`);
  process.stdout.write(checkpoint());
  await stopStack();
  saveState("dopo-preparazione");
  process.stdout.write("prepared: 14 CVs screened, one seal; state saved as dopo-preparazione\n");
}

// ------------------------------------------------------------- sopralluogo

async function sopralluogo(): Promise<void> {
  restoreState("dopo-preparazione");
  await startStack();
  const browser = await launch();
  const { context, actor } = await signedIn(browser);
  const dir = join(OUT, "sopralluogo");
  mkdirSync(dir, { recursive: true });
  const pages: [string, string][] = [
    ["registro", "/ui"],
    ["cronologia", `/ui/systems/${SYSTEM_ID}`],
    ["sigilli", `/ui/systems/${SYSTEM_ID}/checkpoints`],
    ["fascicolo", `/ui/systems/${SYSTEM_ID}#fascicolo`],
    ["verifica", "/ui/verify-document"],
  ];
  for (const [name, url] of pages) {
    await actor.page.goto(`${ADDRESS}${url}`);
    await sleep(300);
    await actor.page.screenshot({ path: join(dir, `${name}.png`) });
  }
  await context.close();
  await browser.close();
  await stopStack();
  process.stdout.write(`screenshots in ${dir}\n`);
}

// ------------------------------------------------------------------ scenes

/** The context every console recording uses: Italian, Rome time, light theme. */
const consoleOptions = (size = FULL): Parameters<Browser["newContext"]>[0] => ({
  viewport: size,
  colorScheme: "light",
  locale: "it-IT",
  timezoneId: "Europe/Rome",
  acceptDownloads: true,
});

async function consoleActor(browser: Browser, size = FULL): Promise<{ context: BrowserContext; actor: Actor }> {
  const context = await browser.newContext(consoleOptions(size));
  const actor = await Actor.open(context);
  // Signed in before the camera rolls: the operator's password page is not part of the film.
  await actor.page.goto(`${ADDRESS}/ui/login`);
  await actor.page.fill('input[name="password"]', ADMIN_PASSWORD);
  await Promise.all([actor.page.waitForNavigation(), actor.page.click('button[type="submit"]')]);
  return { context, actor };
}

const sceneFile = (name: string): string => join(SCENES, `${name}.mp4`);
const frames = (name: string): string => join(OUT, "fotogrammi", name);

/** Starts the stack from a saved state, runs `body` with a browser, and always stops both. */
async function withStack(state: string, body: (browser: Browser) => Promise<void>): Promise<void> {
  mkdirSync(SCENES, { recursive: true });
  restoreState(state);
  await startStack();
  const browser = await launch();
  try {
    await body(browser);
  } finally {
    await browser.close();
    await stopStack();
  }
}

/** Scene 1, 0:00-0:15: the Registro, still, under the opening title. */
async function scena1(): Promise<void> {
  await withStack("dopo-preparazione", async (browser) => {
    const { actor } = await consoleActor(browser);
    actor.x = 1500;
    actor.y = 900;
    await actor.goto(`${ADDRESS}/ui`);
    const recorder = new Recorder(actor.page, frames("1"), FULL);
    await recorder.start();
    await sleep(7000); // the title sits over these seconds
    await actor.hover(actor.page.locator(".notice, [role=status]").first(), 260);
    await sleep(1800);
    await actor.hover(actor.page.getByText("Azioni oggi"));
    await sleep(1600);
    await actor.hover(actor.page.locator("a").filter({ hasText: "Integro" }).first(), 200);
    await sleep(2400);
    await recorder.stop();
    recorder.encode(sceneFile("scena-1"));
  });
}

/**
 * Scene 2, 0:15-0:40: the Registro beside a terminal, where the real agent
 * screens CVs 15 to 20, one run per CV; after each run the Registro is
 * reloaded and shows what just arrived. Then a seal, and the state is saved
 * for the scenes after.
 */
async function scena2(): Promise<void> {
  const token = readFileSync(join(STATE, "dopo-preparazione", "token.txt"), "utf8").trim();
  await withStack("dopo-preparazione", async (browser) => {
    const left = { width: 1280, height: 1080 };
    const right = { width: 640, height: 1080 };
    const { actor } = await consoleActor(browser, left);
    actor.x = 900;
    actor.y = 800;
    await actor.goto(`${ADDRESS}/ui`);
    const termContext = await browser.newContext({ viewport: right, locale: "it-IT" });
    const terminal = await Terminal.open(termContext, { fontSize: 14, cwdLabel: "agente", title: "Terminale — l'agente di selezione" });
    const consoleRec = new Recorder(actor.page, frames("2-console"), left);
    const termRec = new Recorder(terminal.page, frames("2-terminale"), right);
    await consoleRec.start();
    await termRec.start();
    const from = Date.now();
    await sleep(1500);
    await actor.hover(actor.page.getByText("Azioni oggi"));
    await sleep(800);
    for (const cv of LIVE) {
      const folder = join(OUT, "agente", cv.replace(".txt", ""));
      rmSync(folder, { recursive: true, force: true });
      mkdirSync(join(folder, "curricula"), { recursive: true });
      cpSync(join(ROOT, "demo", "selezione-cv", "agent.py"), join(folder, "agent.py"));
      cpSync(join(ROOT, "demo", "selezione-cv", "curricula", cv), join(folder, "curricula", cv));
      // The command shown is the command run: the demo's agent.py, beside a folder holding this one CV.
      const python = process.env["SIGILLO_VIDEO_PYTHON"] ?? "python3";
      await terminal.run(`python3 ${cv.replace(".txt", "")}/agent.py`, join(OUT, "agente"), {
        PATH: `${join(python, "..")}:${process.env["PATH"] ?? ""}`,
        SIGILLO_ENDPOINT: ADDRESS,
        SIGILLO_API_KEY: token,
        SIGILLO_SYSTEM_ID: SYSTEM_ID,
        SIGILLO_DEMO_OUTBOX: join(OUT, "outbox"),
      }, (line) => (line.includes("esito=") ? "ok" : line.startsWith("model:") || line.includes("receipts sent") ? "dim" : ""));
      await sleep(300);
      await actor.page.reload();
      await actor.settle();
      await sleep(700);
    }
    await sleep(800);
    await actor.hover(actor.page.locator(".lines a, a.row, li a").filter({ hasText: "invia_email" }).first(), 220);
    await sleep(2200);
    const to = Date.now();
    await consoleRec.stop();
    await termRec.stop();
    consoleRec.encode(join(SCENES, "scena-2-console.mp4"), from, to);
    termRec.encode(join(SCENES, "scena-2-terminale.mp4"), from, to);
    execFileSync("ffmpeg", [
      "-y", "-loglevel", "error",
      "-i", join(SCENES, "scena-2-console.mp4"), "-i", join(SCENES, "scena-2-terminale.mp4"),
      "-filter_complex", "[0:v][1:v]hstack=inputs=2,format=yuv420p[v]", "-map", "[v]",
      "-r", "30", "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-movflags", "+faststart",
      sceneFile("scena-2"),
    ]);
  });
  // The seal after the live run, from the same external authority, outside the film.
  await startStack();
  process.stdout.write(checkpoint());
  await stopStack();
  saveState("dopo-scena-2");
}

/** Scene 3, 0:40-1:05: the Cronologia, one receipt, its technical details, the tools filter. */
async function scena3(): Promise<void> {
  await withStack("dopo-scena-2", async (browser) => {
    const { actor } = await consoleActor(browser);
    actor.x = 900;
    actor.y = 700;
    await actor.goto(`${ADDRESS}/ui/systems/${SYSTEM_ID}`);
    const recorder = new Recorder(actor.page, frames("3"), FULL);
    await recorder.start();
    await sleep(1500);
    const page = actor.page;
    await actor.click(page.locator("a.row").filter({ hasText: "valuta_candidato" }).first(), { fromLeft: 260, navigates: true, after: 2000 });
    await actor.hover(page.locator("aside, .inspector").locator("text=Quando").first());
    await sleep(1200);
    await actor.click(page.locator("details.tech > summary").first(), { after: 1500 });
    // The receipt's own fingerprint, then its link to the one before it.
    for (const label of [/^Impronta$/, /^Collegata alla ricevuta/]) {
      const target = page.locator("details.tech[open]").getByText(label).first();
      if ((await target.count()) > 0) {
        await actor.hover(target);
        await sleep(1700);
      }
    }
    await sleep(800);
    await actor.click(page.locator("a, button").filter({ hasText: /^Strumenti/ }).first(), { navigates: true, after: 2200 });
    await actor.moveTo(700, 560);
    await sleep(2500);
    await recorder.stop();
    recorder.encode(sceneFile("scena-3"));
  });
}

/** Scene 4, 1:05-1:25: the Sigilli tab, a seal opened, the external authority's timestamp. */
async function scena4(): Promise<void> {
  await withStack("dopo-scena-2", async (browser) => {
    const { actor } = await consoleActor(browser);
    actor.x = 900;
    actor.y = 600;
    await actor.goto(`${ADDRESS}/ui/systems/${SYSTEM_ID}`);
    const recorder = new Recorder(actor.page, frames("4"), FULL);
    await recorder.start();
    await sleep(1200);
    const page = actor.page;
    await actor.click(page.locator("a").filter({ hasText: /^Sigilli$/ }).first(), { navigates: true, after: 1800 });
    await actor.hover(page.locator(".seals .pill").first());
    await sleep(1500);
    await actor.click(page.locator(".seals summary").first(), { fromLeft: 200, after: 1800 });
    for (const label of ["Attestat", "Autorit"]) {
      const target = page.locator(".seals details[open] dt").filter({ hasText: label }).first();
      if ((await target.count()) > 0) {
        await actor.hover(target);
        await sleep(2200);
      }
    }
    await sleep(2500);
    await recorder.stop();
    recorder.encode(sceneFile("scena-4"));
  });
}

/** The verifier and the one-character tool, as commands on PATH, so the terminal shows exactly what runs. */
function toolsOnPath(): string {
  const bin = join(OUT, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "sigillo-verify"), `#!/bin/sh\nexec "${process.execPath}" "${VERIFIER}" "$@"\n`, { mode: 0o755 });
  writeFileSync(
    join(bin, "cambia-un-carattere"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, "video", "cambia-un-carattere.mjs")}" "$@"\n`,
    { mode: 0o755 },
  );
  return bin;
}

/**
 * Scene 5, 1:25-2:05: the fascicolo downloaded from the console, checked by
 * the independent verifier, then a copy with one character changed, which
 * fails and says where; then a CV through "Verifica documento", the original
 * and a copy with one character changed.
 */
async function scena5(): Promise<void> {
  const downloads = join(OUT, "Scaricati");
  rmSync(downloads, { recursive: true, force: true });
  mkdirSync(downloads, { recursive: true });
  cpSync(join(ROOT, "demo", "selezione-cv", "curricula", "candidato-07.txt"), join(downloads, "candidato-07.txt"));
  const bin = toolsOnPath();
  let zipName = "";

  await withStack("dopo-scena-2", async (browser) => {
    // 5a: the fascicolo, from the console.
    {
      const { actor } = await consoleActor(browser);
      actor.x = 1100;
      actor.y = 500;
      await actor.goto(`${ADDRESS}/ui/systems/${SYSTEM_ID}`);
      const recorder = new Recorder(actor.page, frames("5a"), FULL);
      await recorder.start();
      await sleep(1200);
      const page = actor.page;
      await actor.click(page.locator("a.button, a").filter({ hasText: /^\s*Fascicolo\s*$/ }).first(), { after: 1500 });
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        actor.click(page.locator("#fascicolo button[type=submit]"), { after: 300 }),
      ]);
      zipName = download.suggestedFilename();
      await download.saveAs(join(downloads, zipName));
      await sleep(1800);
      await recorder.stop();
      recorder.encode(sceneFile("scena-5a"));
    }

    // 5b: the terminal, full screen.
    {
      const context = await browser.newContext({ viewport: FULL, locale: "it-IT" });
      const terminal = await Terminal.open(context, { fontSize: 16, cwdLabel: "Scaricati", title: "Terminale — Scaricati" });
      const recorder = new Recorder(terminal.page, frames("5b"), FULL);
      await recorder.start();
      await sleep(1200);
      const env = { PATH: `${bin}:${process.env["PATH"] ?? ""}` };
      const verdict = (line: string): string => (line.startsWith("OK") || line === "the archive verifies" ? "ok" : line.startsWith("FAILED") ? "bad" : "");
      await terminal.run(`sigillo-verify ${zipName}`, downloads, env, verdict);
      await sleep(4000);
      await terminal.clear();
      await sleep(600);
      await terminal.run(`cambia-un-carattere ${zipName} copia.zip`, downloads, env);
      await sleep(2000);
      await terminal.run("sigillo-verify copia.zip", downloads, env, verdict);
      await sleep(4000);
      await terminal.run("cambia-un-carattere candidato-07.txt candidato-07-copia.txt", downloads, env);
      await sleep(2000);
      await recorder.stop();
      recorder.encode(sceneFile("scena-5b"));
      await context.close();
    }

    // 5c: the CV through "Verifica documento", original and copy.
    {
      const { actor } = await consoleActor(browser);
      actor.x = 1000;
      actor.y = 700;
      await actor.goto(`${ADDRESS}/ui/verify-document`);
      const recorder = new Recorder(actor.page, frames("5c"), FULL);
      await recorder.start();
      await sleep(1200);
      const page = actor.page;
      for (const file of ["candidato-07.txt", "candidato-07-copia.txt"]) {
        // The drop zone is a label around the file field: a click on it opens the file chooser.
        const [chooser] = await Promise.all([page.waitForEvent("filechooser"), actor.click(page.locator("label.drop"), { after: 400 })]);
        await chooser.setFiles(join(downloads, file));
        await sleep(1200);
        await actor.click(page.locator("#sigillo-doc-button"), { navigates: true, after: 1200 });
        await actor.hover(page.locator("#sigillo-doc-result h3").first());
        await sleep(2600);
      }
      await recorder.stop();
      recorder.encode(sceneFile("scena-5c"));
    }
  });
  concat(["scena-5a", "scena-5b", "scena-5c"], "scena-5");
}

/** Scene 6, 2:05-2:30: back to the Registro, then the public site under the closing title. */
async function scena6(): Promise<void> {
  await withStack("dopo-scena-2", async (browser) => {
    {
      const { actor } = await consoleActor(browser);
      actor.x = 1300;
      actor.y = 700;
      await actor.goto(`${ADDRESS}/ui/systems/${SYSTEM_ID}`);
      const recorder = new Recorder(actor.page, frames("6a"), FULL);
      await recorder.start();
      await sleep(1000);
      await actor.click(actor.page.locator("a.brand, nav a").filter({ hasText: "Registro" }).first(), { navigates: true, after: 1500 });
      await actor.hover(actor.page.locator(".notice, [role=status]").first(), 260);
      await sleep(2500);
      await actor.hover(actor.page.getByText("Ultimo sigillo"));
      await sleep(2500);
      await recorder.stop();
      recorder.encode(sceneFile("scena-6a"));
    }
    {
      // The public site: get-sigillo.eu, the real one, as anyone reaches it (no account, nothing signed in).
      const context = await browser.newContext({ viewport: FULL, colorScheme: "light", locale: "it-IT" });
      await context.route("https://get-sigillo.eu/**", async (route) => {
        const live = fetchLive(route.request().url());
        await route.fulfill(live);
      });
      const actor = await Actor.open(context);
      actor.x = 1400;
      actor.y = 820;
      // Where https://get-sigillo.eu/ lands (it redirects to /ui, which redirects here): the
      // redirected requests would bypass the interception below, so the film goes there directly.
      await actor.goto("https://get-sigillo.eu/ui/login");
      await actor.page.waitForLoadState("networkidle");
      const recorder = new Recorder(actor.page, frames("6b"), FULL);
      await recorder.start();
      await sleep(10000);
      await recorder.stop();
      recorder.encode(sceneFile("scena-6b"));
      await context.close();
    }
  });
  concat(["scena-6a", "scena-6b"], "scena-6");
}

/**
 * One response of the live site, fetched with curl. Where this is recorded,
 * outbound traffic goes through a proxy that serves curl but answers the
 * browser with an error page, so the browser is handed exactly the bytes
 * curl received: the same page, headers and all, only the transport differs.
 * Redirects are passed on, not followed, so the browser takes them itself.
 */
function fetchLive(url: string): { status: number; headers: Record<string, string>; body: Buffer } {
  const raw = execFileSync("curl", ["-sS", "--http1.1", "--suppress-connect-headers", "--retry", "4", "--retry-all-errors", "-D", "-", url], { maxBuffer: 32 * 1024 * 1024 });
  const split = raw.indexOf("\r\n\r\n");
  const head = raw.subarray(0, split).toString("latin1").split("\r\n");
  const status = Number(/^HTTP\/[\d.]+ (\d+)/.exec(head[0] ?? "")?.[1] ?? "502");
  const headers: Record<string, string> = {};
  for (const line of head.slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status, headers, body: raw.subarray(split + 4) };
}

/** Joins encoded parts of one scene, re-encoding so the cut is exact. */
function concat(parts: string[], name: string): void {
  const list = join(SCENES, `${name}.txt`);
  writeFileSync(list, parts.map((part) => `file '${sceneFile(part)}'`).join("\n") + "\n");
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list,
    "-r", "30", "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    sceneFile(name),
  ]);
}

/** The title cards video/monta.sh lays over scenes 1 and 6. */
async function titoli(): Promise<void> {
  mkdirSync(SCENES, { recursive: true });
  const browser = await launch();
  await renderTitle(browser, join(SCENES, "titolo-apertura.png"), "Il registro a prova di manomissione<br>per i tuoi agenti AI", "");
  await renderTitle(browser, join(SCENES, "titolo-chiusura.png"), "Pilota gratuito · get-sigillo.eu", "");
  await browser.close();
}

/** ffprobe: a clip's duration in seconds. */
function seconds(file: string): number {
  return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).trim());
}

/** A subtitle line as at most two rows of about 50 characters, or two cues when it is longer than that. */
function cuesOf(line: string): string[] {
  const rows = (text: string): string => {
    if (text.length <= 50) return text;
    const middle = text.length / 2;
    let cut = -1;
    for (let i = 0; i < text.length; i += 1) if (text[i] === " " && (cut === -1 || Math.abs(i - middle) < Math.abs(cut - middle))) cut = i;
    return cut === -1 ? text : `${text.slice(0, cut)}\n${text.slice(cut + 1)}`;
  };
  if (line.length <= 100) return [rows(line)];
  // Two cues, cut at the punctuation nearest the middle.
  const middle = line.length / 2;
  let cut = -1;
  for (let i = 0; i < line.length - 1; i += 1) {
    if (/[.,:;?!»]/.test(line[i] ?? "") && line[i + 1] === " " && (cut === -1 || Math.abs(i - middle) < Math.abs(cut - middle))) cut = i;
  }
  if (cut === -1) return [rows(line)];
  return [...cuesOf(line.slice(0, cut + 1)), ...cuesOf(line.slice(cut + 2))];
}

/**
 * video/out/sigillo-demo.srt: the narration of video/parlato.ts, each clip's
 * lines spread over that clip's real place in the joined film, in proportion
 * to their length.
 */
function sottotitoli(): void {
  const parts: Record<string, string[]> = {
    "scena-1": ["scena-1"],
    "scena-2": ["scena-2"],
    "scena-3": ["scena-3"],
    "scena-4": ["scena-4"],
    "scena-5": ["scena-5a", "scena-5b", "scena-5c"],
    "scena-6": ["scena-6a", "scena-6b"],
  };
  // Where each clip starts and ends in the joined film. A scene made of parts was
  // re-encoded as a whole, so its parts are scaled to the scene's own length.
  const span = new Map<string, [number, number]>();
  let at = 0;
  for (const [scene, clips] of Object.entries(parts)) {
    const total = seconds(sceneFile(scene));
    const lengths = clips.map((clip) => seconds(sceneFile(clip)));
    const scale = total / lengths.reduce((sum, length) => sum + length, 0);
    let inner = at;
    clips.forEach((clip, index) => {
      const length = (lengths[index] ?? 0) * scale;
      span.set(clip, [inner, inner + length]);
      inner += length;
    });
    at += total;
  }
  const stamp = (t: number): string => {
    const ms = Math.round(t * 1000);
    const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
    return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
  };
  const out: string[] = [];
  for (const { clip, lines } of PARLATO) {
    const [from, to] = span.get(clip) ?? [0, 0];
    const cues = lines.flatMap(cuesOf);
    const start = from + 0.5;
    const end = to - 0.4;
    const weight = cues.reduce((sum, cue) => sum + cue.length + 12, 0);
    let t = start;
    for (const cue of cues) {
      const length = ((cue.length + 12) / weight) * (end - start);
      out.push(`${out.length / 4 + 1}`, `${stamp(t)} --> ${stamp(t + length - 0.15)}`, cue, "");
      t += length;
    }
  }
  writeFileSync(join(OUT, "sigillo-demo.srt"), out.join("\n"));
  process.stdout.write(`wrote ${join(OUT, "sigillo-demo.srt")} (${out.length / 4} cues, ${at.toFixed(1)} s of film)\n`);
}

const scenes: Record<string, () => Promise<void>> = { "1": scena1, "2": scena2, "3": scena3, "4": scena4, "5": scena5, "6": scena6 };

const command = process.argv[2] ?? "";
try {
  if (command === "prepara") await prepara();
  else if (command === "sopralluogo") await sopralluogo();
  else if (command === "titoli") await titoli();
  else if (command === "sottotitoli") sottotitoli();
  else if (command === "scena" && scenes[process.argv[3] ?? ""] !== undefined) await scenes[process.argv[3] ?? ""]?.();
  else if (command === "tutto") {
    await prepara();
    for (const scene of Object.values(scenes)) await scene();
    await titoli();
    sottotitoli();
  } else {
    process.stderr.write("usage: pnpm tsx video/registra.ts prepara | scena <1-6> | titoli | sottotitoli | tutto | sopralluogo\n");
    process.exitCode = 2;
  }
} finally {
  await stopStack();
}
