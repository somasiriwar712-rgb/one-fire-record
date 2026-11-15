// Screenshots of page parts for the slides, through Chromium's DevTools protocol (no extra packages).
// Usage: node shots.mjs <page url> <out dir> <width> <selector>=<name> ...
// Needs the page served (preview "fire-record" on port 4180) and chromium on PATH.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const [url, out, width, ...targets] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const port = 9333;
const chrome = spawn("chromium", ["--headless=new", `--remote-debugging-port=${port}`, "--no-first-run", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--hide-scrollbars", `--user-data-dir=${out}/.profile`, "about:blank"], { stdio: "ignore" });
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

  await send("Emulation.setDeviceMetricsOverride", { width: +width, height: 900, deviceScaleFactor: +(process.env.DPR || 2), mobile: +width < 600 });
  await send("Page.enable");
  await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });   // the profile folder persists: never draw an old app.js
  const t0 = Date.now();
  await send("Page.navigate", { url });
  for (let i = 0; i < 60 && !(await evaluate("!!(typeof state !== \"undefined\" && state.rec && document.querySelector('#calendar button'))")); i++) await sleep(250);
  await evaluate("document.getElementById('map').scrollIntoView()");   // the globe loads when it comes near the screen
  for (let i = 0; i < 80 && !(await evaluate("!!(state.mapReady && state.fires && state.map.loaded()) || !!document.querySelector('#map .map-wait.note')")); i++) await sleep(250);
  console.error(`map ready after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await evaluate(`void (${process.env.SETUP || "0"})`);   // void: a call that returns a map or element is not sent back   // e.g. SETUP='state.map.jumpTo({zoom: 9})' or a layer switch
  await sleep(+(process.env.WAIT || 4500));   // map tiles and fire dots
  await evaluate("document.querySelector('.top').style.position = 'static'");   // the sticky bar would cover each part
  for (const t of targets) {
    const [selector, name] = t.split("=");
    const r = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: "start" }); const b = e.getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height }; })()`);
    await sleep(600);
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 } });
    writeFileSync(`${out}/${name}.png`, Buffer.from(shot.data, "base64"));
    console.log(`${name}.png ${Math.round(r.w)}x${Math.round(r.h)} css px`);
  }
  if (process.env.EVAL) console.log(JSON.stringify(await evaluate(process.env.EVAL)));   // e.g. EVAL='state.map.getZoom()'
  ws.close();
} finally {
  chrome.kill();
}
