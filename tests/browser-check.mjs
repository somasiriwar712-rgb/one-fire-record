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
const chrome = spawn("chromium", ["--headless=new", `--remote-debugging-port=${port}`, "--no-first-run", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
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
      const ready = await run(`(async () => {
        const wait = () => new Promise(r => setTimeout(r, 100));
        for (let i = 0; i < 150 && !(typeof state !== "undefined" && state.d?.id === ${JSON.stringify(place.id)} && state.rec); i++) await wait();
        document.getElementById("map").scrollIntoView();   // the globe loads near the screen
        for (let i = 0; i < 300 && !(state.mapReady && state.fires?.id === ${JSON.stringify(place.id)}); i++) await wait();
        return !!(state.mapReady && state.fires);
      })()`);
      const r = ready ? await run(`(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms)), d = state.d, map = state.map, out = {}, $ = id => document.getElementById(id);
        out.overflow = document.documentElement.scrollWidth > innerWidth;
        out.answer = /fire activity was (far )?(below|above)? ?normal\\./.test($("answer").textContent);
        const years = +d.first.slice(0, 4), lastYear = years + Math.floor((+d.first.slice(5) - 1 + d.joined.length - 1) / 12);
        out.calendar = document.querySelectorAll("#calendar button").length === (lastYear - years + 1) * 12;
        out.charts = ["#pace svg", "#strip svg", "#months svg", "#years svg"].every(s => document.querySelector(s));
        out.paceWords = /had [\\d,]+: the/.test($("pace-note").textContent);
        out.seam = document.querySelectorAll("#seam svg").length === 2 && /times more/.test($("seam-note").textContent);
        out.yearsCheck = $("years-check").textContent.length > 20;
        document.querySelector('#strip-view input[value="counted"]').click(); await wait(50);
        out.stripSwitch = document.querySelectorAll("#strip polyline").length >= 2 && /As each sensor counted/.test($("strip-note").textContent);
        document.querySelector('#strip-view input[value="joined"]').click();
        const all = state.shown;
        document.querySelector('#when input[value="30"]').click(); await wait(100);
        const recent = state.shown;
        out.timeSwitch = all > 0 && recent <= all && JSON.stringify(map.getFilter("dots")).includes("30");
        document.querySelector('#when input[value="366"]').click(); await wait(100);
        document.querySelector('#layer input[value="burn"]').click(); await wait(100);
        out.burnLayer = state.cells > 0 && map.getLayoutProperty("cells", "visibility") === "visible" && map.getLayoutProperty("dots", "visibility") === "none";
        document.querySelector('#layer input[value="unusual"]').click(); await wait(100);
        out.unusualLayer = state.cells >= 0 && /compares/.test($("map-note").textContent);
        out.hashLayer = location.hash.includes("layer=unusual");
        document.querySelector('#layer input[value="fires"]').click(); await wait(100);
        out.firesBack = map.getLayoutProperty("dots", "visibility") === "visible" && !location.hash.includes("layer=");
        const b = document.querySelector(".map-full-button"); b.click(); await wait(200);
        const box = $("map").getBoundingClientRect();
        out.fullScreen = Math.round(box.width) === innerWidth && Math.round(box.height) === innerHeight;
        b.click(); await wait(200);
        out.fullScreenCloses = !document.body.classList.contains("map-open");
        map.jumpTo({ zoom: Math.max(5, map.getZoom() + 1.5) }); await wait(300);
        $("use-view").click(); await wait(400);
        out.area = /your area/.test($("answer").textContent) && !$("clear-view").hidden && location.hash.includes("area=");
        $("clear-view").click(); await wait(300);
        out.areaClears = !state.area && !/your area/.test($("answer").textContent);
        out.feed = $("feed").getAttribute("href") === "feed/" + d.id + ".xml" && (await fetch($("feed").href)).ok;
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
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
process.exit(failed ? 1 : 0);
