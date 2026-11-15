// Load speed as a phone on slow 4G sees it, through Chromium's DevTools protocol (no extra packages).
// The same throttling as Lighthouse's mobile run: 150 ms round trip, 1.6 Mbit/s down, CPU 4x slower.
// Usage: node tools/speed.mjs <url> [runs=3]    Prints the median of each number.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, runs = 3] = process.argv.slice(2);
const profile = mkdtempSync(join(tmpdir(), "fire-speed-"));
const port = 9335;
const chrome = spawn("chromium", ["--headless=new", `--remote-debugging-port=${port}`, "--no-first-run", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

try {
  let list;
  for (let i = 0; i < 50 && !list; i++) { await sleep(200); list = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json()).catch(() => null); }
  const ws = new WebSocket(list.find(t => t.type === "page").webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener("open", r, { once: true }));
  let id = 0, bytes = 0;
  const waiting = new Map();
  ws.addEventListener("message", e => {
    const m = JSON.parse(e.data);
    if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    if (m.method === "Network.loadingFinished") bytes += m.params.encodedDataLength;
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; waiting.set(n, m => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result))); ws.send(JSON.stringify({ id: n, method, params })); });
  const run = async expr => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
  await send("Page.enable"); await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 });
  // record paints, layout shifts and long tasks from the first byte
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__m = { lcp: 0, cls: 0, long: [] };
    new PerformanceObserver(l => { for (const e of l.getEntries()) __m.lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) __m.cls += e.value; }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver(l => { for (const e of l.getEntries()) __m.long.push([e.startTime, e.duration]); }).observe({ type: "longtask", buffered: true });` });
  const rows = [];
  for (let k = 0; k < +runs; k++) {
    await send("Network.clearBrowserCache");
    bytes = 0;
    await send("Page.navigate", { url: `${url}${url.includes("#") ? "" : "#"}` });
    await sleep(15000);   // the answer, the charts, and the first screen settle well within this on slow 4G
    const m = await run(`(() => {
      const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0;
      const tbt = __m.long.filter(([s]) => s >= fcp).reduce((t, [, d]) => t + Math.max(0, d - 50), 0);
      const answer = document.getElementById("answer")?.textContent || "";
      const kb = [...performance.getEntriesByType("navigation"), ...performance.getEntriesByType("resource")].reduce((s, e) => s + (e.transferSize || 0), 0) / 1024;
      return { fcp, lcp: __m.lcp, cls: __m.cls, tbt, kb, long: __m.long.map(([s, d]) => Math.round(s) + "+" + Math.round(d)).join(" "), answered: /normal/.test(answer) };
    })()`);
    rows.push(m);
  }
  const pick = k => median(rows.map(r => r[k]));
  console.log(`${url}\n  first paint ${(pick("fcp") / 1000).toFixed(2)} s | largest paint ${(pick("lcp") / 1000).toFixed(2)} s | blocking ${Math.round(pick("tbt"))} ms | layout shift ${pick("cls").toFixed(3)} | downloaded ${Math.round(pick("kb"))} KB | answer shown: ${rows.every(r => r.answered)}`);
  if (process.env.LONG) for (const r of rows) console.log("  long tasks (start+ms):", r.long);
  ws.close();
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
