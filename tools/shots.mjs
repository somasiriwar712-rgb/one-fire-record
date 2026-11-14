// Screenshots of page parts for the slides, through Chromium's DevTools protocol (no extra packages).
// Usage: node shots.mjs <page url> <out dir> <width> <selector>=<name> ...
// Needs the page served (preview "fire-record" on port 4180) and chromium on PATH.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const [url, out, width, ...targets] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const port = 9333;
const chrome = spawn("chromium", ["--headless=new", `--remote-debugging-port=${port}`, "--no-first-run", "--hide-scrollbars", `--user-data-dir=${out}/.profile`, "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));

try {
  let list;
  for (let i = 0; i < 50 && !list; i++) { await sleep(200); list = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json()).catch(() => null); }
  const ws = new WebSocket(list.find(t => t.type === "page").webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const waiting = new Map();
  ws.addEventListener("message", e => { const m = JSON.parse(e.data); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; waiting.set(n, m => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result))); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async expr => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result.value;

  await send("Emulation.setDeviceMetricsOverride", { width: +width, height: 900, deviceScaleFactor: 2, mobile: +width < 600 });
  await send("Page.enable");
  await send("Page.navigate", { url });
  for (let i = 0; i < 60 && !(await evaluate("!!(window.state && state.rec && document.querySelector('#calendar button'))")); i++) await sleep(250);
  await sleep(2500);   // map tiles
  await evaluate("document.querySelector('.top').style.position = 'static'");   // the sticky bar would cover each part
  for (const t of targets) {
    const [selector, name] = t.split("=");
    const r = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: "start" }); const b = e.getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height }; })()`);
    await sleep(600);
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 } });
    writeFileSync(`${out}/${name}.png`, Buffer.from(shot.data, "base64"));
    console.log(`${name}.png ${Math.round(r.w)}x${Math.round(r.h)} css px`);
  }
  ws.close();
} finally {
  chrome.kill();
}
