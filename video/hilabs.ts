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
  const actor = await Actor.open(context);
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
      await on.page.screenshot({ path: `/tmp/hilabs-${name}-error.png` });
      throw error;
    }
    await recorder.stop();
    const file = join(DIR, `${String(n++).padStart(2, "0")}-${name}.mp4`);
    recorder.encode(file);
    parts.push(file);
  };

  try {
    // 1. Sign in.
    await actor.goto(`${ADDRESS}/ui/login`);
    await segment("login", async () => {
      await sleep(1500);
      await actor.click(page.locator('input[name="password"]'), { after: 400 });
      await page.locator('input[name="password"]').pressSequentially(ADMIN_PASSWORD, { delay: 70 });
      await sleep(700);
      await actor.click(page.locator('button[type="submit"]'), { navigates: true, after: 2500 });
    });

    // 2. New system, then upload the customer's plain agent and download it back with Sigillo added.
    await segment("connect", async () => {
      await actor.goto(`${ADDRESS}/ui/sistemi`);
      await sleep(1500);
      await actor.click(page.locator('a[href="/ui/sistemi/nuovo"]').first(), { navigates: true, after: 900 });
      await actor.click(page.locator('input[name="display_name"]'), { after: 500 });
      await page.locator('input[name="display_name"]').pressSequentially("Pharmacy review assistant", { delay: 75 });
      await sleep(900);
      await actor.click(page.locator('form[action="/ui/sistemi"] button[type="submit"]'), { navigates: true, after: 1800 });
      await actor.hover(page.locator("pre.code.install").first(), 300);
      await sleep(1500);
      const [chooser] = await Promise.all([page.waitForEvent("filechooser"), actor.click(page.locator("label.drop"), { after: 500 })]);
      await chooser.setFiles(original);
      await page.locator("#sigillo-agent-choice").waitFor({ state: "visible" });
      await sleep(1500);
      await actor.hover(page.locator("#sigillo-agent-analysis"), 300);
      await sleep(2400);
      const [download] = await Promise.all([page.waitForEvent("download"), actor.click(page.locator("#sigillo-agent-download"), { after: 600 })]);
      await download.saveAs(join(folder, "agent.py"));
      await sleep(2000);
      await actor.hover(page.locator("#sigillo-agent-done"), 300);
      await sleep(2200);
    });

    // 3. The agent works on the documents folder, in a terminal.
    const termContext = await browser.newContext({ viewport: LEFT, locale: "en-GB" });
    const terminal = await Terminal.open(termContext, { fontSize: 18, cwdLabel: "pharmacy-assistant", title: "Terminal — pharmacy-assistant" });
    await segment(
      "agent",
      async () => {
        await sleep(1500);
        await terminal.run("ls documents", folder, env);
        await sleep(2500);
        const code = await terminal.run("python3 agent.py", folder, env);
        if (code !== 0) throw new Error(`the agent exited with ${code}`);
        await sleep(3000);
      },
      terminal,
    );

    // 4. The console: the receipts the run left.
    await segment("receipts", async () => {
      await sleep(1000);
      await actor.click(page.locator(".wait-line a.end"), { navigates: true, after: 1800 });
      await actor.hover(page.locator(".wait-line.green"), 300);
      await sleep(1800);
      await actor.click(page.locator(".wait-line.green a.button"), { navigates: true, after: 1500 });
      await sleep(3500);
    });

    // 5. Verify a document: the original, then the copy with one word changed.
    await actor.goto(`${ADDRESS}/ui/verify-document`);
    await segment("verify", async () => {
      await sleep(1500);
      for (const file of [POLICY, COPY]) {
        const [chooser] = await Promise.all([page.waitForEvent("filechooser"), actor.click(page.locator("label.drop"), { after: 400 })]);
        await chooser.setFiles(join(downloads, file));
        await sleep(1200);
        await actor.click(page.locator("#sigillo-doc-button"), { navigates: true, after: 1200 });
        await actor.hover(page.locator("#sigillo-doc-result h3").first());
        await sleep(3500);
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
