/**
 * Records the HiLabs/Polina demo: a new account's console on the left two
 * thirds of the screen, the right third left empty for the presenter.
 *
 *   SIGILLO_VIDEO_LANG=en pnpm tsx video/hilabs.ts
 *
 * Real console, real agent run, real verification; nothing is mocked. The
 * output is video/out/hilabs/hilabs-demo.mp4 (1920x1080, right third blank).
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator } from "playwright-core";
import {
  ADDRESS,
  ADMIN_PASSWORD,
  Actor,
  OUT,
  ROOT,
  Recorder,
  Terminal,
  freshState,
  launch,
  sleep,
  startStack,
  stopStack,
} from "./lib.js";

const LEFT = { width: 1280, height: 1080 };
const DIR = join(OUT, "hilabs");
const HERE = join(ROOT, "video", "hilabs");
const POLICY = "pharmacy-dispensing-policy.txt";
const COPY = "pharmacy-dispensing-policy-copy.txt";
const parts: string[] = [];
/** Lengths, in seconds, of the segments: the stretches of Polina's recorded narration each one plays under. */
const TARGET: Record<string, number> = { login: 6.4, connect: 15.8, agent: 9.5, receipts: 9.1, verify: 18.1 };

const rand = (a: number, b: number): number => a + Math.random() * (b - a);

/** An arrow cursor, as a mouse shows one, drawn over the page in place of the video library's ring. */
const ARROW_SCRIPT = `(() => {
  const install = () => {
    if (document.getElementById("__arrow")) return;
    const style = document.createElement("style");
    style.textContent = "#__video-pointer{display:none!important}";
    document.documentElement.appendChild(style);
    const arrow = document.createElement("div");
    arrow.id = "__arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.innerHTML = '<svg width="26" height="26" viewBox="0 0 26 26" style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.5))"><path d="M3 2 L3 20 L8 15.5 L11.5 23 L14.5 21.7 L11 14.3 L18 14 Z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    const start = window.__videoPointer || { x: -100, y: -100 };
    arrow.style.cssText = "position:fixed;left:" + start.x + "px;top:" + start.y + "px;z-index:2147483647;pointer-events:none;transition:transform 90ms ease;transform-origin:3px 2px";
    document.documentElement.appendChild(arrow);
    addEventListener("mousemove", (e) => { arrow.style.left = e.clientX + "px"; arrow.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => { arrow.style.transform = "scale(0.88)"; }, true);
    addEventListener("mouseup", () => { arrow.style.transform = "scale(1)"; }, true);
  };
  if (document.documentElement) install(); else addEventListener("DOMContentLoaded", install);
  addEventListener("DOMContentLoaded", install);
})();`;

/** The same actor with a hand's habits: curved, uneven paths that sometimes overshoot, short pauses, a cursor that never freezes, typing at a human pace. */
class HumanActor extends Actor {
  override async moveTo(x: number, y: number, ms?: number): Promise<void> {
    const fromX = this.x;
    const fromY = this.y;
    const distance = Math.hypot(x - fromX, y - fromY);
    if (distance < 1) return;
    const overshoot = distance > 320 && Math.random() < 0.5;
    const aimX = overshoot ? x + ((x - fromX) / distance) * rand(7, 15) : x;
    const aimY = overshoot ? y + ((y - fromY) / distance) * rand(7, 15) : y;
    await this.glide(fromX, fromY, aimX, aimY, ms);
    if (overshoot) await this.glide(aimX, aimY, x, y, rand(140, 230));
    this.x = x;
    this.y = y;
  }

  /** One cubic-Bezier stroke with a minimum-jerk speed profile and a little tremor. */
  private async glide(fromX: number, fromY: number, toX: number, toY: number, ms?: number): Promise<void> {
    const distance = Math.hypot(toX - fromX, toY - fromY);
    const duration = ms ?? Math.min(1000, 240 + 110 * Math.log2(distance / 24 + 1) + rand(0, 140));
    const nx = -(toY - fromY) / (distance || 1);
    const ny = (toX - fromX) / (distance || 1);
    const bend1 = rand(-0.12, 0.12) * distance;
    const bend2 = rand(-0.1, 0.1) * distance;
    const c1x = fromX + (toX - fromX) * 0.3 + nx * bend1;
    const c1y = fromY + (toY - fromY) * 0.3 + ny * bend1;
    const c2x = fromX + (toX - fromX) * 0.75 + nx * bend2;
    const c2y = fromY + (toY - fromY) * 0.75 + ny * bend2;
    const steps = Math.max(10, Math.round(duration / 14));
    let jx = 0;
    let jy = 0;
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const e = t * t * t * (10 - 15 * t + 6 * t * t);
      const u = 1 - e;
      jx = jx * 0.7 + rand(-0.5, 0.5);
      jy = jy * 0.7 + rand(-0.5, 0.5);
      const fade = i === steps ? 0 : 1;
      const px = u * u * u * fromX + 3 * u * u * e * c1x + 3 * u * e * e * c2x + e * e * e * toX + jx * fade;
      const py = u * u * u * fromY + 3 * u * u * e * c1y + 3 * u * e * e * c2y + e * e * e * toY + jy * fade;
      await this.page.mouse.move(px, py);
      await sleep(duration / steps);
    }
  }

  override async aim(locator: Locator, fromLeft?: number): Promise<{ x: number; y: number }> {
    const point = await super.aim(locator, fromLeft);
    const box = await locator.boundingBox();
    if (box === null || fromLeft !== undefined) return point;
    // Nobody hits the exact middle: somewhere in the inner half, and not on the very edge of a thin target.
    return { x: point.x + rand(-0.22, 0.22) * Math.min(box.width, 400), y: point.y + rand(-0.2, 0.2) * Math.min(box.height, 60) };
  }

  override async click(locator: Locator, options: { fromLeft?: number; before?: number; after?: number; navigates?: boolean } = {}): Promise<void> {
    await this.hover(locator, options.fromLeft);
    await sleep(rand(160, 380));
    const press = async (): Promise<void> => {
      await this.page.mouse.down();
      await sleep(rand(70, 130));
      await this.page.mouse.up();
    };
    if (options.navigates === true) {
      await Promise.all([this.page.waitForNavigation(), press()]);
      await this.settle();
    } else {
      await press();
    }
    await this.idle(options.after ?? 600);
  }

  /** Wait while the cursor wanders a little, as a hand resting on a mouse does. */
  /** Shrinks every wait of the segment being recorded, so that the natural pace needs no speeding up. */
  scale = 1;

  async idle(ms: number): Promise<void> {
    const end = Date.now() + ms * this.scale;
    while (end - Date.now() > 350) {
      const left = end - Date.now();
      const x = Math.min(1250, Math.max(10, this.x + rand(-45, 45)));
      const y = Math.min(1070, Math.max(10, this.y + rand(-35, 35)));
      await this.glide(this.x, this.y, x, y, Math.min(left - 100, rand(350, 800)));
      this.x = x;
      this.y = y;
      const rest = Math.min(end - Date.now(), rand(80, 450));
      if (rest > 0) await sleep(rest);
    }
    const rest = end - Date.now();
    if (rest > 0) await sleep(rest);
  }

  /** Types with an uneven rhythm: quick runs, a beat at spaces, now and then a hesitation. */
  async write(locator: Locator, text: string): Promise<void> {
    for (const char of text) {
      await locator.pressSequentially(char);
      let wait = rand(65, 150);
      if (char === " ") wait += rand(50, 140);
      if (Math.random() < 0.05) wait += rand(220, 420);
      await sleep(wait);
    }
  }
}

/** Terminal typing at the same human pace. */
async function typeLikeAHuman(terminal: Terminal, command: string): Promise<void> {
  for (const char of command) {
    await terminal.page.evaluate(`window.term.add(${JSON.stringify(char)}, "cmd")`);
    await sleep(rand(60, 150) + (char === " " ? rand(40, 120) : 0) + (Math.random() < 0.05 ? rand(200, 380) : 0));
  }
}

/** A file dialog in the style of a desktop "Open" window, drawn over the page; the arguments are JSON. */
const openDialog = (location: string, entries: { name: string; kind: string; date: string; size: string }[]): string => `((location, entries) => {
  const shade = document.createElement("div");
  shade.id = "fake-dialog-shade";
  shade.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:2147483000;display:flex;align-items:center;justify-content:center;font:14px 'Segoe UI',Arial,sans-serif;color:#1b1b1b";
  const rows = entries.map((e, i) =>
    '<div id="fake-row-' + i + '" class="r" data-name="' + e.name + '" style="display:flex;align-items:center;padding:7px 12px;gap:10px;cursor:default"><span style="width:22px">' + (e.kind === "File folder" ? "&#128193;" : "&#128196;") + '</span><span style="flex:1">' + e.name + '</span><span style="width:150px;color:#555">' + e.date + '</span><span style="width:110px;color:#555">' + e.kind + '</span><span style="width:70px;text-align:right;color:#555">' + e.size + '</span></div>').join("");
  shade.innerHTML = '<div style="width:880px;background:#fff;border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,0.45);overflow:hidden">'
    + '<div style="padding:10px 14px;background:#f3f3f3;border-bottom:1px solid #ddd;font-weight:600">Open</div>'
    + '<div style="padding:10px 14px;border-bottom:1px solid #e5e5e5;color:#444">' + location + '</div>'
    + '<div style="display:flex;padding:7px 12px;gap:10px;color:#666;border-bottom:1px solid #eee"><span style="width:22px"></span><span style="flex:1">Name</span><span style="width:150px">Date modified</span><span style="width:110px">Type</span><span style="width:70px;text-align:right">Size</span></div>'
    + '<div style="height:200px">' + rows + '</div>'
    + '<div style="display:flex;justify-content:flex-end;align-items:center;gap:12px;padding:12px 14px;background:#f3f3f3;border-top:1px solid #ddd"><span style="margin-right:auto;color:#555">File name: <span id="fake-name" style="display:inline-block;min-width:360px;padding:4px 8px;background:#fff;border:1px solid #aaa;color:#1b1b1b"></span></span>'
    + '<button id="fake-open" style="padding:6px 26px;border:1px solid #0067c0;background:#0067c0;color:#fff;border-radius:4px;font:inherit">Open</button>'
    + '<button style="padding:6px 22px;border:1px solid #bbb;background:#fff;color:#1b1b1b;border-radius:4px;font:inherit">Cancel</button></div></div>';
  shade.addEventListener("click", (e) => {
    const r = e.target.closest(".r");
    if (!r) return;
    shade.querySelectorAll(".r").forEach((x) => (x.style.background = ""));
    r.style.background = "#cce4f7";
    document.getElementById("fake-name").textContent = r.dataset.name;
  });
  document.body.appendChild(shade);
})(${JSON.stringify(location)}, ${JSON.stringify(entries)})`;

async function main(): Promise<void> {
  process.env["SIGILLO_AGENT_UPLOAD"] = "operator";
  process.env["SIGILLO_PLAIN_AGENTS"] = "operator";
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const folder = join(DIR, "pharmacy-assistant");
  const original = join(DIR, "original", "agent.py");
  const downloads = join(DIR, "Downloads");
  mkdirSync(join(DIR, "original"), { recursive: true });
  mkdirSync(downloads, { recursive: true });
  cpSync(join(HERE, "agent.py"), original);
  cpSync(join(HERE, "documents"), join(folder, "documents"), { recursive: true });
  cpSync(join(HERE, "documents", POLICY), join(downloads, POLICY));
  const text = readFileSync(join(HERE, "documents", POLICY), "utf8");
  if (!text.includes("two pharmacists")) throw new Error("the sentence to change is not in the policy");
  writeFileSync(join(downloads, COPY), text.replace("two pharmacists", "one pharmacist"));

  freshState();
  await startStack();
  const browser = await launch();
  const context = await browser.newContext({ viewport: LEFT, colorScheme: "light", locale: "en-GB", timezoneId: "Europe/Berlin", acceptDownloads: true });
  await context.addInitScript(ARROW_SCRIPT);
  const actor = new HumanActor((await Actor.open(context)).page);
  const page = actor.page;
  const python = process.env["SIGILLO_VIDEO_PYTHON"] ?? "python3";
  const env = { PATH: `${join(python, "..")}:${process.env["PATH"] ?? ""}` };
  let n = 0;
  const segment = async (name: string, body: (r: Recorder) => Promise<void>, on: { page: typeof page } = actor): Promise<void> => {
    const recorder = new Recorder(on.page, join(DIR, "frames", name), LEFT);
    await recorder.start();
    try {
      await body(recorder);
    } catch (error) {
      process.stdout.write(`segment ${name} failed: ${String(error)}\n`);
      await on.page.screenshot({ path: `/tmp/hilabs-${name}-error.png` });
      throw error;
    }
    await recorder.stop();
    const file = join(DIR, `${String(n++).padStart(2, "0")}-${name}.mp4`);
    const raw = file.replace(".mp4", "-raw.mp4");
    recorder.encode(raw);
    // Each segment keeps the length of the first cut, so the presenter's script does not move.
    const length = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", raw], { encoding: "utf8" }));
    const factor = TARGET[name] === undefined ? 1 : TARGET[name] / length;
    process.stdout.write(`${name}: ${length.toFixed(1)}s -> ${(length * factor).toFixed(1)}s (x${factor.toFixed(3)})\n`);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-vf", `setpts=PTS*${factor.toFixed(5)},fps=30,format=yuv420p`, "-c:v", "libx264", "-preset", "slow", "-crf", "16", file]);
    parts.push(file);
  };

  try {
    // 1. Sign in.
    await actor.goto(`${ADDRESS}/ui/login`);
    actor.scale = 0.3;
    await segment("login", async () => {
      await actor.idle(1500);
      await actor.click(page.locator('input[name="password"]'), { after: 400 });
      await actor.write(page.locator('input[name="password"]'), ADMIN_PASSWORD);
      await actor.idle(700);
      await actor.click(page.locator('button[type="submit"]'), { navigates: true, after: 2500 });
    });

    // 2. New system, then upload the customer's plain agent and download it back with Sigillo added.
    actor.scale = 0.12;
    await segment("connect", async () => {
      await actor.goto(`${ADDRESS}/ui/sistemi`);
      await actor.idle(1500);
      await actor.click(page.locator('a[href="/ui/sistemi/nuovo"]').first(), { navigates: true, after: 900 });
      await actor.click(page.locator('input[name="display_name"]'), { after: 500 });
      await actor.write(page.locator('input[name="display_name"]'), "Pharmacy review assistant");
      await actor.idle(900);
      await actor.click(page.locator('form[action="/ui/sistemi"] button[type="submit"]'), { navigates: true, after: 1800 });
      const chooserPromise = page.waitForEvent("filechooser");
      await actor.click(page.locator("label.drop"), { after: 300 });
      const chooser = await chooserPromise;
      // The system's own file dialog does not show in a page recording: draw one, as the person would see it.
      await page.evaluate(
        openDialog("This PC › Documents › pharmacy-assistant", [
          { name: "documents", kind: "File folder", date: "26/10/2026 15:41", size: "" },
          { name: "agent.py", kind: "Python File", date: "26/10/2026 15:38", size: "2 KB" },
        ]),
      );
      await actor.idle(1500);
      await actor.click(page.locator("#fake-row-1"), { after: 900 });
      await actor.click(page.locator("#fake-open"), { after: 300 });
      await page.evaluate(`document.getElementById("fake-dialog-shade")?.remove()`);
      await chooser.setFiles(original);
      await page.locator("#sigillo-agent-choice").waitFor({ state: "visible" });
      await actor.idle(1500);
      await actor.idle(2400);
      const [download] = await Promise.all([page.waitForEvent("download"), actor.click(page.locator("#sigillo-agent-download"), { after: 600 })]);
      await download.saveAs(join(folder, "agent.py"));
      await actor.idle(2000);
      await actor.idle(2200);
    });

    // 3. The agent works on the documents folder, in a terminal.
    const termContext = await browser.newContext({ viewport: LEFT, locale: "en-GB" });
    const terminal = await Terminal.open(termContext, { fontSize: 18, cwdLabel: "pharmacy-assistant", title: "Terminal — pharmacy-assistant" });
    terminal.type = (command: string): Promise<void> => typeLikeAHuman(terminal, command);
    await segment(
      "agent",
      async () => {
        await sleep(1000);
        await terminal.run("ls documents", folder, env);
        await sleep(1500);
        const code = await terminal.run("python3 agent.py", folder, env);
        if (code !== 0) throw new Error(`the agent exited with ${code}`);
        await sleep(2000);
      },
      terminal,
    );

    // 4. The console: the receipts the run left.
    actor.scale = 0.45;
    await segment("receipts", async () => {
      await actor.idle(1000);
      await actor.click(page.locator(".wait-line a.end"), { navigates: true, after: 1800 });
      await actor.hover(page.locator(".wait-line.green"), 300);
      await actor.idle(1800);
      await actor.click(page.locator(".wait-line.green a.button"), { navigates: true, after: 1500 });
      await actor.idle(3500);
    });

    // 5. Verify a document: the original, then the copy with one word changed.
    await actor.goto(`${ADDRESS}/ui/verify-document`);
    actor.scale = 0.3;
    await segment("verify", async () => {
      await actor.idle(1500);
      for (const file of [POLICY, COPY]) {
        const chooserPromise = page.waitForEvent("filechooser");
        await actor.click(page.locator("label.drop"), { after: 300 });
        const chooser = await chooserPromise;
        await page.evaluate(
          openDialog("This PC › Documents › pharmacy-assistant › documents", [
            { name: POLICY, kind: "Text Document", date: "26/10/2026 15:41", size: "1 KB" },
            { name: COPY, kind: "Text Document", date: "26/10/2026 15:44", size: "1 KB" },
            { name: "ai-services-agreement.txt", kind: "Text Document", date: "26/10/2026 15:41", size: "1 KB" },
            { name: "medication-incident-procedure.txt", kind: "Text Document", date: "26/10/2026 15:41", size: "1 KB" },
          ]),
        );
        await actor.idle(1200);
        await actor.click(page.locator(file === POLICY ? "#fake-row-0" : "#fake-row-1"), { after: 800 });
        await actor.click(page.locator("#fake-open"), { after: 300 });
        await page.evaluate(`document.getElementById("fake-dialog-shade")?.remove()`);
        await chooser.setFiles(join(downloads, file));
        await actor.idle(1200);
        await actor.click(page.locator("#sigillo-doc-button"), { navigates: true, after: 1200 });
        await actor.hover(page.locator("#sigillo-doc-result h3").first());
        await actor.idle(3500);
      }
    });
  } finally {
    await browser.close();
    await stopStack();
  }

  // Join the segments and park them on the left of a 1920x1080 frame; the right stays blank.
  const list = join(DIR, "parts.txt");
  writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n") + "\n");
  const output = join(DIR, "hilabs-demo.mp4");
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list,
    "-vf", "pad=1920:1080:0:0:color=0xF4F4F6,format=yuv420p",
    "-r", "30", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-movflags", "+faststart", output,
  ]);
  process.stdout.write(`written ${output}\n`);
}

await main();
