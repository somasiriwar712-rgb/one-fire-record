// Opens the page in headless Chromium for every place, at phone and PC width, and checks what a user would see.
// Usage (page served on port 4180):  node tests/browser-check.mjs [http://localhost:4180/]
// No extra packages: it talks to Chromium's DevTools protocol directly. Exits 1 if anything fails.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.argv[2] || "http://localhost:4180/";
const profile = mkdtempSync(join(tmpdir(), "fire-check-"));
const port = 9334;
const chrome = spawn("chromium", ["--headless=new", `--remote-debugging-port=${port}`, "--no-first-run", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;

try {
  let list;
  for (let i = 0; i < 50 && !list; i++) { await sleep(200); list = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json()).catch(() => null); }
  const ws = new WebSocket(list.find(t => t.type === "page").webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const waiting = new Map(), problems = [];
  ws.addEventListener("message", e => {
    const m = JSON.parse(e.data);
    if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") problems.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(m.params.type)) problems.push(m.params.args.map(a => a.value ?? a.description).join(" "));
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !/favicon/.test(m.params.entry.url || "")) problems.push(`${m.params.entry.text} ${m.params.entry.url || ""}`);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; waiting.set(n, m => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result))); ws.send(JSON.stringify({ id: n, method, params })); });
  const run = async expr => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
  await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });

  const places = await fetch(new URL("data/index.json", base)).then(r => r.json());
  const rows = [];
  for (const width of [390, 1280]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 2, mobile: width < 600 });
    await send("Emulation.setTouchEmulationEnabled", { enabled: width < 600 });
    for (const place of places) {
      problems.length = 0;
      await send("Page.navigate", { url: `${base}?check=${Date.now()}#${place.id}` });
      const ready = await run(`(async () => { for (let i = 0; i < 120; i++) { if (typeof state !== "undefined" && state.d?.id === ${JSON.stringify(place.id)} && state.fires && state.dots) return true; await new Promise(r => setTimeout(r, 100)); } return false; })()`);
      const r = ready ? await run(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms)), d = state.d, out = {};
        out.overflow = document.documentElement.scrollWidth > innerWidth;
        out.answer = /fire activity was (far )?(below|above)? ?normal\\./.test(document.getElementById("answer").textContent);
        const years = +d.first.slice(0, 4), lastYear = years + Math.floor((+d.first.slice(5) - 1 + d.joined.length - 1) / 12);
        out.calendar = document.querySelectorAll("#calendar button").length === (lastYear - years + 1) * 12;
        out.charts = ["#strip svg", "#months svg", "#years svg"].every(s => document.querySelector(s));
        const all = state.dots.age.length;
        document.querySelector('#when input[value="30"]').click(); await wait(200);
        const recent = state.dots.age.length;
        document.querySelector('#when input[value="366"]').click(); await wait(200);
        out.timeSwitch = all > 0 && recent <= all && state.dots.age.length === all;
        const b = document.querySelector(".map-full-button"); b.click(); await wait(200);
        const box = document.getElementById("map").getBoundingClientRect();
        out.fullScreen = Math.round(box.width) === innerWidth && Math.round(box.height) === innerHeight;
        b.click(); await wait(200);
        out.fullScreenCloses = !document.body.classList.contains("map-open");
        state.map.setView(state.map.getCenter(), state.map.getZoom() + 2, { animate: false }); await wait(300);
        document.getElementById("use-view").click(); await wait(400);
        out.area = /your area/.test(document.getElementById("answer").textContent) && !document.getElementById("clear-view").hidden;
        document.getElementById("clear-view").click(); await wait(300);
        out.areaClears = !state.area && !/your area/.test(document.getElementById("answer").textContent);
        out.dots = all;
        return out;
      })()`) : { loaded: false };
      const checks = Object.entries(r).filter(([k]) => k !== "dots" && k !== "overflow");
      const ok = ready && !r.overflow && checks.every(([, v]) => v === true) && problems.length === 0;
      if (!ok) failed++;
      rows.push({ width, place: place.id, ok: ok ? "pass" : "FAIL", dots: r.dots, failed: [...(r.overflow ? ["sideways scroll"] : []), ...checks.filter(([, v]) => v !== true).map(([k]) => k), ...problems].join("; ") });
    }
  }
  console.table(rows);
  console.log(failed ? `${failed} of ${rows.length} runs failed` : `all ${rows.length} runs passed`);
  ws.close();
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
