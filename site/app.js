// One Fire Record. Reads data/<Country>.json (made by pipeline/harmonize.py) and draws every part of the page.
"use strict";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SOURCE = { t: "MODIS Terra, scaled", m: "MODIS, scaled", s: "VIIRS Suomi NPP", n: "VIIRS NOAA-20, scaled" };
const FIRE = [1, 2, 3, 4, 5, 6, 7].map(k => `var(--fire-${k})`);
const BLUE = [1, 2, 3, 4, 5, 6, 7].map(k => `var(--blue-${k})`);
const $ = id => document.getElementById(id);
const fmt = n => Math.round(n).toLocaleString("en");
const state = { d: null, rec: null, view: "joined", area: null, cache: {}, map: null, layers: null };

// ---------- small builders ----------
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k === "text" ? (e.textContent = v) : e.setAttribute(k, v);
  e.append(...kids);
  return e;
}
function s(tag, attrs = {}, text) {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}
function quantile(sorted, q) {
  const pos = q * (sorted.length - 1), lo = Math.floor(pos);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (pos - lo);
}
function nice(x) {            // 1, 2, 5, 10, 20, 50 ... at or near x
  if (x < 1) return 1;
  const p = 10 ** Math.floor(Math.log10(x)), r = x / p;
  return (r < 1.5 ? 1 : r < 3.5 ? 2 : r < 7.5 ? 5 : 10) * p;
}
function niceUp(x) {          // the first round number that is not below x: an axis top
  const p = 10 ** Math.floor(Math.log10(Math.max(x, 1)));
  return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(k => k * p >= x) * p;
}
function breaks(values) {     // up to six class limits, closer together at the low end where most months sit
  const nz = values.filter(v => v > 0).sort((a, b) => a - b);
  if (!nz.length) return [1];
  const top = quantile(nz, 0.98);
  return [...new Set([1, 2, 3, 4, 5, 6].map(k => nice(top * (k / 6.5) ** 2)))];
}
const classOf = (v, br) => br.filter(b => b < v).length;                 // 0 .. br.length
const ramp = (cls, br, colors) => colors[Math.round(cls * 6 / br.length)];

// ---------- the record ----------
const ym = (d, i) => { const k = +d.first.slice(5) - 1 + i; return { y: +d.first.slice(0, 4) + Math.floor(k / 12), m: k % 12 }; };
const label = (d, i) => { const { y, m } = ym(d, i); return `${MONTHS[m]} ${y}`; };

function counts(d, area) {    // monthly detections per sensor: the whole country, or the squares inside an area
  if (!area) return { modis: d.modis, snpp: d.snpp, n20: d.n20 };
  const out = { modis: d.modis.map(() => 0), snpp: d.modis.map(() => 0), n20: d.modis.map(() => 0) };
  for (const [x, y, modis, snpp, n20] of d.grid) {
    const lon = (x + 0.5) * d.coarse_deg, lat = (y + 0.5) * d.coarse_deg;
    if (lon < area.w || lon > area.e || lat < area.s || lat > area.n) continue;
    for (const [src, key] of [[modis, "modis"], [snpp, "snpp"], [n20, "n20"]]) for (const i in src) out[key][i] += src[i];
  }
  for (const key in out) out[key] = out[key].map((v, i) => (d[key][i] === null ? null : v));   // not flying is not zero
  return out;
}

function join(d, c) {         // the same rule as join() in pipeline/harmonize.py
  const f = d.factor, joined = [], lo = [], hi = [];
  for (let i = 0; i < c.modis.length; i++) {
    const src = d.src[i], mo = ym(d, i).m;
    let v, band = [1, 1];
    if (src === "s") v = c.snpp[i] || 0;
    else if (src === "n") v = (c.n20[i] || 0) * f.handover;
    else {
      v = c.modis[i] * (src === "t" && f.terra_by_month ? f.terra_by_month : f.by_month)[mo];
      band = d.test[src === "t" ? "band_terra" : "band"][c.modis[i] >= 10 ? "busy" : "thin"];
    }
    joined.push(Math.round(v)); lo.push(Math.round(v * band[0])); hi.push(Math.round(v * band[1]));
  }
  return { ...c, joined, lo, hi };
}
const estimated = (d, i) => d.src[i] === "m" || d.src[i] === "t";
function shown(d, rec, view, i) {   // the value a view shows for month i, or null when that sensor has nothing
  if (view === "joined") return rec.joined[i];
  if (view === "modis") return rec.modis[i];
  return rec.snpp[i] ?? rec.n20[i];
}

// ---------- tooltip ----------
function tip(target, html) {
  const t = $("tip");
  if (!html) { t.hidden = true; return; }
  t.innerHTML = html;
  t.hidden = false;
  const r = target.getBoundingClientRect ? target.getBoundingClientRect() : target, w = t.offsetWidth;
  t.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
  t.style.top = (r.top - t.offsetHeight - 8 < 8 ? r.bottom + 8 : r.top - t.offsetHeight - 8) + "px";
}
function monthTip(d, rec, i, view = "joined") {
  const v = shown(d, rec, view, i);
  if (v === null) return `<b>${label(d, i)}</b>${view === "modis" ? "No MODIS data" : "VIIRS was not flying yet"}`;
  if (view !== "joined") return `<b>${fmt(v)} detections</b>${label(d, i)}, ${view === "modis" ? "MODIS" : "VIIRS"} as counted`;
  return `<b>${fmt(v)} detections</b>${label(d, i)}<br><small>${estimated(d, i) ? `estimated from ${fmt(rec.modis[i])} MODIS detections, likely ${fmt(rec.lo[i])} to ${fmt(rec.hi[i])}` : SOURCE[d.src[i]]}</small>`;
}

// ---------- is this month normal ----------
function drawAnswer(d, rec) {
  const i = Math.max(d.src.lastIndexOf("s"), d.src.lastIndexOf("n")), { y, m } = ym(d, i), v = rec.joined[i];
  const same = [];
  for (let k = i - 12; k >= 0; k -= 12) same.push(rec.joined[k]);
  same.sort((a, b) => a - b);
  const rank = (same.filter(x => x < v).length + same.filter(x => x === v).length / 2) / same.length;
  const word = rank <= 0.1 ? "far below normal" : rank <= 0.25 ? "below normal" : rank < 0.75 ? "normal" : rank < 0.9 ? "above normal" : "far above normal";
  const [q1, mid, q3] = [0.25, 0.5, 0.75].map(q => Math.round(quantile(same, q)));
  const where = state.area ? `your area in ${d.name}` : d.name;
  $("answer").textContent = `${FULL[m]} ${y} in ${where}: fire activity was ${word}.`;
  $("answer-detail").textContent = `${fmt(v)} fire detections. In the ${same.length} earlier ${FULL[m]}s on record, the middle year had ${fmt(mid)} and the middle half of years had ${fmt(q1)} to ${fmt(q3)}. ${FULL[m]} ${y} is the newest full month` +
    (d.provisional_from && `${y}-${String(m + 1).padStart(2, "0")}` >= d.provisional_from
      ? `. It comes from NASA's near-real-time files, so treat it as provisional until NASA's science-quality data replace it.`
      : ` in NASA's science-quality files.`);
  const max = Math.max(same[same.length - 1], v, 1), pct = x => (x / max * 100).toFixed(1) + "%";
  const range = $("range");
  range.setAttribute("aria-label", `Range of ${FULL[m]} values: lowest ${fmt(same[0])}, middle ${fmt(mid)}, highest ${fmt(same[same.length - 1])}; this year ${fmt(v)}.`);
  range.replaceChildren(
    h("div", { class: "line" }),
    h("div", { class: "box", style: `left:${pct(q1)};width:${pct(q3 - q1)}` }),
    h("div", { class: "mid", style: `left:${pct(mid)}` }),
    h("div", { class: "now", style: `left:${pct(v)}` }),
    h("span", { style: "left:0", text: `lowest ${fmt(same[0])}` }),
    h("span", { style: "right:0", text: `highest ${fmt(same[same.length - 1])}` }));
}

// ---------- the 25-year trace with its sensor tape ----------
function drawStrip(d, rec) {
  const box = $("strip"), W = Math.max(300, box.clientWidth), H = 250, pad = { l: 8, r: 8, t: 22, b: 0 }, plotH = 128, n = rec.joined.length;
  const x = i => pad.l + i / (n - 1) * (W - pad.l - pad.r);
  const top = niceUp(Math.max(...rec.joined, 1)), y = v => pad.t + plotH - Math.min(v, top) / top * plotH;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Monthly fire detections in ${d.name}, ${label(d, 0)} to ${label(d, n - 1)}. The table under the calendar holds every value.` });
  for (const t of [0.5, 1]) svg.append(s("line", { x1: pad.l, x2: W - pad.r, y1: y(top * t), y2: y(top * t), stroke: "var(--rule)", "stroke-width": 1 }), s("text", { x: pad.l + 2, y: y(top * t) - 3, class: "tick" }, fmt(top * t)));
  const est = [...d.src].map((c, i) => i).filter(i => estimated(d, i));
  if (est.length) svg.append(s("path", { d: "M" + est.map(i => `${x(i).toFixed(1)},${y(rec.hi[i]).toFixed(1)}`).join("L") + "L" + est.reverse().map(i => `${x(i).toFixed(1)},${y(rec.lo[i]).toFixed(1)}`).join("L") + "Z", fill: "var(--ink)", opacity: 0.13 }));
  svg.append(s("polyline", { points: rec.joined.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" "), fill: "none", stroke: "var(--ink)", "stroke-width": 1.25, "stroke-linejoin": "round" }));
  svg.append(s("line", { x1: pad.l, x2: W - pad.r, y1: y(0), y2: y(0), stroke: "var(--ink)", "stroke-width": 1 }));
  const first = +d.first.slice(0, 4);
  for (let yr = Math.ceil((first + 1) / 5) * 5; yr <= ym(d, n - 1).y; yr += 5) {
    const i = (yr - first) * 12 - (+d.first.slice(5) - 1);
    svg.append(s("line", { x1: x(i), x2: x(i), y1: y(0), y2: y(0) + 4, stroke: "var(--ink)" }), s("text", { x: x(i), y: y(0) + 15, "text-anchor": "middle" }, yr));
  }
  // the tape: one channel per sensor, thick where that sensor writes the record
  const firstOf = c => d.src.indexOf(c), lastOf = c => d.src.lastIndexOf(c);
  const channels = [
    ["MODIS (Terra, Aqua from 2002)", "var(--modis)", 0, rec.modis.length - 1, 0, Math.max(lastOf("m"), lastOf("t"))],
    ["VIIRS Suomi NPP", "var(--viirs)", rec.snpp.findIndex(v => v !== null), rec.snpp.findLastIndex(v => v !== null), firstOf("s"), lastOf("s")],
    ["VIIRS NOAA-20", "var(--n20)", rec.n20.findIndex(v => v !== null), rec.n20.findLastIndex(v => v !== null), firstOf("n"), lastOf("n")],
  ];
  channels.forEach(([name, color, from, to, w0, w1], k) => {
    if (from < 0) return;
    const cy = pad.t + plotH + 44 + k * 22;
    svg.append(s("line", { x1: x(from), x2: x(to), y1: cy, y2: cy, stroke: color, "stroke-width": 2 }));
    if (w0 >= 0) svg.append(s("line", { x1: x(w0), x2: x(w1), y1: cy, y2: cy, stroke: color, "stroke-width": 7, "stroke-linecap": "butt" }));
    const right = x(from) > W * 0.6;
    svg.append(s("text", { x: right ? x(to) : x(from), y: cy - 7, class: "label", "text-anchor": right ? "end" : "start" }, name));
  });
  const cross = s("line", { y1: pad.t, y2: pad.t + plotH, stroke: "var(--pen)", "stroke-width": 1, visibility: "hidden" });
  const hit = s("rect", { x: 0, y: 0, width: W, height: pad.t + plotH + 20, fill: "transparent" });
  const move = e => {
    const r = svg.getBoundingClientRect(), i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width * W - pad.l) / (W - pad.l - pad.r) * (n - 1))));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
    tip({ left: e.clientX, right: e.clientX, top: r.top + pad.t, bottom: r.top + pad.t + 40, width: 0 }, monthTip(d, rec, i));
  };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerdown", move);
  hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); tip(); });
  svg.append(cross, hit);
  box.replaceChildren(svg);
}

// ---------- burning calendar, its legend and its table ----------
function drawCalendar(d, rec) {
  const view = state.view, n = rec.joined.length, values = rec.joined.map((_, i) => shown(d, rec, view, i));
  const br = breaks(values.filter(v => v !== null)), colors = view === "modis" ? BLUE : FIRE;
  const cal = $("calendar"), cells = [h("span"), ...MONTHS.map(m => h("span", { class: "head", text: m[0], title: m }))];
  const rows = [h("tr", {}, h("th", { text: "Year" }), ...MONTHS.map(m => h("th", { text: m })))];
  const first = ym(d, 0), last = ym(d, n - 1);
  for (let yr = first.y; yr <= last.y; yr++) {
    cells.push(h("span", { class: "year", text: yr }));
    const tr = h("tr", {}, h("th", { text: yr }));
    for (let m = 0; m < 12; m++) {
      const i = (yr - first.y) * 12 + m - first.m, v = i >= 0 && i < n ? values[i] : null, est = v !== null && view === "joined" && estimated(d, i);
      const b = h("button", { type: "button", tabindex: -1, class: v === null ? "none" : est ? "est" : "", "aria-label": v === null ? `${MONTHS[m]} ${yr}: no data` : `${MONTHS[m]} ${yr}: ${fmt(v)} detections${est ? ", estimated from MODIS" : ""}` });
      if (v) b.style.background = ramp(classOf(v, br), br, colors);
      if (i >= 0 && i < n) b.dataset.i = i;
      cells.push(b);
      tr.append(h("td", { class: est ? "est" : "", text: v === null ? "–" : fmt(v) }));
    }
    rows.push(tr);
  }
  cal.replaceChildren(...cells);
  cal.querySelector("button[data-i]").tabIndex = 0;
  $("table").replaceChildren(...rows);
  $("calendar-note").textContent = view === "joined"
    ? "Each square is one month. A cut corner means the value is an estimate scaled from MODIS."
    : view === "modis" ? "MODIS as counted, not scaled. Compare its colours with the joined view: the same fires, about " + d.factor.all.toFixed(0) + " times fewer detections."
    : "VIIRS as counted. It starts in 2012, so on its own it cannot say what is normal over 25 years.";
  const key = (cls, text) => h("span", { class: "key" }, h("i", { class: cls }), text);
  const legend = [h("span", { class: "ramp" }, "1", ...br.map((_, k) => h("i", { style: `background:${ramp(k, br, colors)}`, title: `up to ${fmt(br[k])}` })), h("i", { style: `background:${ramp(br.length, br, colors)}`, title: `more than ${fmt(br[br.length - 1])}` }), `${fmt(br[br.length - 1])}+ detections a month`)];
  if (view === "joined") legend.push(key("est", "estimated from MODIS"));
  legend.push(key("none", "no data"));
  $("legend").replaceChildren(...legend);
}
function calendarEvents() {
  const cal = $("calendar"), cell = e => e.target.closest("button[data-i]");
  const show = e => { const b = cell(e); b ? tip(b, monthTip(state.d, state.rec, +b.dataset.i, state.view)) : tip(); };
  cal.addEventListener("pointerover", show);
  cal.addEventListener("focusin", show);
  cal.addEventListener("pointerleave", () => tip());
  cal.addEventListener("focusout", () => tip());
  cal.addEventListener("keydown", e => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -12, ArrowDown: 12 }[e.key], b = cell(e);
    if (!step || !b) return;
    const next = cal.querySelector(`button[data-i="${+b.dataset.i + step}"]`);
    if (next) { e.preventDefault(); b.tabIndex = -1; next.tabIndex = 0; next.focus(); }
  });
}

// ---------- months and years ----------
function bars(box, items, { labelEvery = 1, legend }) {   // items: {name, v, lo, hi, color, tip}
  const W = Math.max(280, box.clientWidth), H = 200, pad = { l: 8, r: 8, t: 26, b: 22 }, plotH = H - pad.t - pad.b;
  const top = niceUp(Math.max(1, ...items.map(it => it.v))), step = (W - pad.l - pad.r) / items.length, bw = Math.max(2, Math.min(22, step - 2));
  const y = v => pad.t + plotH - Math.min(v, top) / top * plotH;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}` });
  const best = items.reduce((a, b) => (b.v > a.v ? b : a)), ticksRight = items.indexOf(best) < items.length / 2;
  for (const t of [0.5, 1]) svg.append(s("line", { x1: pad.l, x2: W - pad.r, y1: y(top * t), y2: y(top * t), stroke: "var(--rule)" }), s("text", { x: ticksRight ? W - pad.r - 2 : pad.l + 2, y: y(top * t) - 3, "text-anchor": ticksRight ? "end" : "start", class: "tick" }, fmt(top * t)));
  items.forEach((it, k) => {
    const cx = pad.l + step * (k + 0.5), g = s("g", { tabindex: 0, role: "img", "aria-label": it.tip.replace(/<[^>]+>/g, " ") });
    g.append(s("rect", { x: cx - step / 2, y: pad.t, width: step, height: plotH, fill: "transparent" }));
    g.append(s("path", { d: `M${cx - bw / 2},${y(0)}V${y(it.v) + 2}q0,-2 2,-2h${bw - 4}q2,0 2,2V${y(0)}Z`, fill: it.color }));
    if (it.lo !== undefined) g.append(s("line", { x1: cx, x2: cx, y1: y(it.lo), y2: y(it.hi), stroke: "var(--ink)", "stroke-width": 1.5 }));
    if (k % labelEvery === 0) svg.append(s("text", { x: cx, y: H - 6, "text-anchor": "middle" }, it.name));
    if (it === best) svg.append(s("text", { x: Math.min(W - 30, Math.max(30, cx)), y: y(Math.max(it.v, it.hi ?? 0)) - 5, "text-anchor": "middle", class: "label tick" }, fmt(it.v)));
    g.addEventListener("pointerenter", () => tip(g, it.tip));
    g.addEventListener("focus", () => tip(g, it.tip));
    g.addEventListener("pointerleave", () => tip());
    g.addEventListener("blur", () => tip());
    svg.append(g);
  });
  svg.append(s("line", { x1: pad.l, x2: W - pad.r, y1: y(0), y2: y(0), stroke: "var(--ink)" }));
  box.replaceChildren(svg, ...(legend ? [legend] : []));
}
function drawMonths(d, rec) {
  const by = MONTHS.map(() => []);
  rec.joined.forEach((v, i) => by[ym(d, i).m].push(v));
  bars($("months"), by.map((vals, m) => {
    vals.sort((a, b) => a - b);
    const [lo, v, hi] = [0.25, 0.5, 0.75].map(q => Math.round(quantile(vals, q)));
    return { name: MONTHS[m][0], v, lo, hi, color: "var(--fire-5)", tip: `<b>${fmt(v)} detections</b>${FULL[m]}, middle year<br><small>middle half of years: ${fmt(lo)} to ${fmt(hi)}</small>` };
  }), {});
}
function drawYears(d, rec) {
  const years = {}, err = d.test.monthly.year_err_mean / 100;
  rec.joined.forEach((v, i) => { const y = ym(d, i).y, o = (years[y] ??= { v: 0, n: 0, est: 0 }); o.v += v; o.n++; o.est += estimated(d, i); });
  const items = Object.entries(years).filter(([, o]) => o.n === 12).map(([y, o]) => {
    const est = o.est > 6;   // 2012 has one MODIS month (January) and eleven VIIRS months
    return {
      name: y, v: o.v, color: est ? "var(--fire-3)" : "var(--fire-5)", ...(est ? { lo: o.v * (1 - err), hi: o.v * (1 + err) } : {}),
      tip: `<b>${fmt(o.v)} detections</b>${y}<br><small>${est ? `estimated from MODIS, typical miss ${d.test.monthly.year_err_mean}%` : o.est ? `measured by VIIRS, except ${o.est} month estimated from MODIS` : "measured by VIIRS"}</small>`,
    };
  });
  const key = (color, text) => h("span", { class: "key" }, h("i", { style: `background:${color}` }), text);
  bars($("years"), items, { labelEvery: 5, legend: h("div", { class: "legend", style: "margin:0;padding:0.4rem 0.5rem" }, key("var(--fire-3)", "estimated from MODIS"), key("var(--fire-5)", "measured by VIIRS")) });
}

// ---------- map and area ----------
function drawMap(d) {
  if (!window.L) return;
  if (!state.map) {
    state.map = L.map("map", { preferCanvas: true, scrollWheelZoom: false, minZoom: 2 });
    L.tileLayer("https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg", { maxNativeZoom: 8, maxZoom: 11, attribution: "NASA GIBS, Blue Marble" }).addTo(state.map);
    state.layers = L.layerGroup().addTo(state.map);
  }
  state.layers.clearLayers();
  const f = d.factor, c = d.coarse_deg, totals = d.grid.map(([, , modis, snpp, n20]) => {
    let t = 0;
    for (const i in modis) if (estimated(d, i)) t += modis[i] * f.by_month[ym(d, +i).m];
    for (const i in snpp) if (d.src[i] === "s") t += snpp[i];
    for (const i in n20) if (d.src[i] === "n") t += n20[i] * f.handover;
    return t;
  });
  const br = breaks(totals), all = totals.reduce((a, b) => a + b, 0);
  const edge = (axis, q) => {   // the edge below which a share q of the fire lies, so a far island with little fire does not zoom the map out
    let sum = 0;
    for (const k of [...totals.keys()].sort((a, b) => d.grid[a][axis] - d.grid[b][axis])) if ((sum += totals[k]) >= all * q) return d.grid[k][axis] * c;
  };
  const bounds = L.latLngBounds([[edge(1, 0.01), edge(0, 0.01)], [edge(1, 0.99) + c, edge(0, 0.99) + c]]);
  d.grid.forEach(([x, y], k) => {
    if (!totals[k]) return;
    const b = [[y * c, x * c], [(y + 1) * c, (x + 1) * c]];
    const color = getComputedStyle(document.documentElement).getPropertyValue(`--fire-${Math.round(classOf(totals[k], br) * 6 / br.length) + 1}`).trim();
    L.rectangle(b, { stroke: false, fillColor: color, fillOpacity: 0.9 }).bindTooltip(`${fmt(totals[k])} detections since ${d.first.slice(0, 4)}`).addTo(state.layers);
  });
  state.map.invalidateSize();
  state.map.fitBounds(bounds, { padding: [12, 12], animate: false });
  $("map-note").textContent = `Move and zoom the map, then use the view as your area. Every chart above redraws for it, with the factors learned for the whole country. Each square is about ${fmt(c * 111)} km wide; darker means more fire since ${d.first.slice(0, 4)}.`;
}
function setArea(area) {
  state.area = area;
  if (state.outline) state.outline.remove();
  state.outline = area ? L.rectangle([[area.s, area.w], [area.n, area.e]], { color: "#fbfcf8", weight: 2, fill: false, dashArray: "6 4" }).addTo(state.map) : null;
  $("clear-view").hidden = !area;
  render();
  if (area) $("answer").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
}

// ---------- method ----------
function drawMethod(d) {
  const f = d.factor, t = d.test, pct = v => (v > 0 ? "+" : "") + v + "%";
  const drift = Object.entries(d.drift), list = key => drift.map(([y, o]) => `${pct(o[key])} in ${y}`).join(", ");
  const name = h("span", { text: d.name }).innerHTML;
  $("method").innerHTML = `
    <p>NASA has watched fires with two kinds of sensor. MODIS, on the Terra and Aqua satellites, since 2000, with 1 km pixels. VIIRS, on Suomi NPP and then NOAA-20, since 2012, with 375 m pixels. VIIRS sees smaller fires, so it reports far more detections for the same burning. Until that gap is closed, the two cannot be read as one record.</p>
    <ul class="figures">
      <li><strong>${f.all.toFixed(1)}×</strong>more detections from VIIRS than from MODIS in ${name}, 2012 to 2021</li>
      <li><strong>${Math.min(...f.by_month).toFixed(1)}× to ${Math.max(...f.by_month).toFixed(1)}×</strong>how that gap moves through the year, so we use one factor per calendar month</li>
      <li><strong>${t.monthly.year_err_mean}%</strong>average miss on a hidden year's total. With one fixed factor: ${t.fixed.year_err_mean}%</li>
      <li><strong>${t.monthly.month_err}%</strong>average miss on a hidden month. With one fixed factor: ${t.fixed.month_err}%</li>
    </ul>
    <h3>What we did</h3>
    <ol>
      <li>Kept vegetation fires only and dropped low-confidence detections, the same way for both sensors.</li>
      <li>On the years both flew before the MODIS orbits drifted (2012 to 2021), measured how many detections VIIRS had for each MODIS detection, in each calendar month.</li>
      <li>Multiplied the MODIS-only years by those factors. From February 2012 the record is VIIRS itself.</li>
      <li>Tested it: hid one shared year at a time, rebuilt it from MODIS alone, and compared it with what VIIRS really saw. The figures above are that test.</li>
    </ol>
    <h3>What this record cannot tell you</h3>
    <ul>
      <li>A scaled month is an estimate. In a quiet month (under 10 MODIS detections) the real value fell between ${t.band.thin[0]}× and ${t.band.thin[1]}× our estimate in 8 of 10 tests; in a busy month, between ${t.band.busy[0]}× and ${t.band.busy[1]}×.</li>
      <li>Before July 2002 only Terra was flying. Those months use a Terra-only factor and are the weakest part of the record: in a busy month the real value fell between ${t.band_terra.busy[0]}× and ${t.band_terra.busy[1]}× the Terra-only estimate in 8 of 10 tests.</li>
      <li>Since 2022 the Terra and Aqua orbits have drifted. With the factors learned before the drift, MODIS misses the real VIIRS total by ${list("modis")}. Terra alone: ${list("terra")}. MODIS should not be used alone for trends any more.</li>
      <li>A detection is not a fire and not a burned area. One fire can give many detections, and clouds and smoke hide fires from both sensors.</li>
      <li>Suomi NPP stopped on 2 November 2026. After its last month the record continues with NOAA-20, scaled by ${f.handover.toFixed(2)} (measured on 2019 to 2025).</li>
      <li>The factors are learned for the whole country. A small area uses the same factors, so its estimates are less certain.</li>
      <li>We found no other public tool that joins the two sensors into one fire calendar. That is not proof that none exists.</li>
    </ul>
    <h3>Sources</h3>
    <ul>
      <li><a href="https://firms.modaps.eosdis.nasa.gov/country/">NASA FIRMS yearly country files</a>, science-quality MODIS Collection 6.1 and VIIRS 375 m active fire detections. ${fmt(d.rows_read.modis + d.rows_read.snpp + d.rows_read.n20)} rows read for ${name}.</li>
      ${ym(d, d.joined.length - 1).y > 2025 ? `<li><a href="https://firms.modaps.eosdis.nasa.gov/api/area/">NASA FIRMS area API</a>, NOAA-20 VIIRS for ${ym(d, d.joined.length - 1).y}: science-quality where NASA has it${d.provisional_from ? `, near-real-time from ${FULL[+d.provisional_from.slice(5) - 1]} ${d.provisional_from.slice(0, 4)} (provisional)` : ""}. Kept when it falls in a 0.1 degree square where ${name} has had VIIRS fires before.</li>` : ""}
      <li><a href="https://www.earthdata.nasa.gov/news/blog/transitioning-from-suomi-npp-viirs-omps-what-firms-users-need-know">NASA FIRMS, October 2026</a>: the end of Suomi NPP and the move to NOAA-20 and NOAA-21.</li>
      <li><a href="https://www.earthdata.nasa.gov/data/alerts-outages/transition-from-modis-viirs">NASA Earthdata, May 2025</a>: Terra and Aqua shut down from late 2026 and are drifting.</li>
      <li><a href="https://essd.copernicus.org/articles/18/7535/2026/">Chen et al. 2026</a>: region-specific scaling between VIIRS and MODIS fire records, the published method closest to ours.</li>
      <li><a href="https://doi.org/10.1016/j.rse.2016.02.054">Giglio et al. 2016</a> and <a href="https://doi.org/10.1016/j.rse.2013.12.008">Schroeder et al. 2014</a>: the MODIS and VIIRS fire algorithms.</li>
      <li>Country outlines are not drawn; the map squares are our own 0.1 degree grid.</li>
    </ul>`;
}

// ---------- download ----------
function download() {
  const d = state.d, rec = state.rec;
  const lines = ["month,modis_detections,viirs_snpp_detections,viirs_noaa20_detections,joined_viirs_equivalent,likely_low,likely_high,source"];
  rec.joined.forEach((v, i) => {
    const { y, m } = ym(d, i);
    lines.push([`${y}-${String(m + 1).padStart(2, "0")}`, rec.modis[i], rec.snpp[i] ?? "", rec.n20[i] ?? "", v, rec.lo[i], rec.hi[i], `"${SOURCE[d.src[i]]}"`].join(","));
  });
  const a = h("a", { href: URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" })), download: `one-fire-record-${d.id}${state.area ? "-area" : ""}.csv` });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- wiring ----------
async function getJSON(url) {       // "no-cache" asks the server if the file changed, so a rebuilt record is never shown stale
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}
function render() {
  const d = state.d;
  state.rec = join(d, counts(d, state.area));
  drawAnswer(d, state.rec);
  drawStrip(d, state.rec);
  drawCalendar(d, state.rec);
  drawMonths(d, state.rec);
  drawYears(d, state.rec);
}
async function load(id) {
  const d = state.cache[id] ??= await getJSON(`data/${id}.json`);
  state.d = d;
  state.area = null;
  if (state.outline) { state.outline.remove(); state.outline = null; }
  $("clear-view").hidden = true;
  const check = join(d, counts(d, null)).joined;
  console.assert(check.every((v, i) => v === d.joined[i]), "page join differs from pipeline join");
  render();
  drawMethod(d);
  drawMap(d);
  history.replaceState(null, "", `#${id}`);
}
async function start() {
  const places = await getJSON("data/index.json"), select = $("place");
  select.replaceChildren(...places.map(p => h("option", { value: p.id, text: p.name })));
  const wanted = decodeURIComponent(location.hash.slice(1));
  select.value = places.some(p => p.id === wanted) ? wanted : places.some(p => p.id === "Sri_Lanka") ? "Sri_Lanka" : places[0].id;
  select.addEventListener("change", () => load(select.value));
  addEventListener("hashchange", () => { const id = decodeURIComponent(location.hash.slice(1)); if (id !== state.d.id && places.some(p => p.id === id)) { select.value = id; load(id); } });
  $("view").addEventListener("change", e => { state.view = e.target.value; drawCalendar(state.d, state.rec); });
  if (!window.L) document.querySelector(".map").replaceChildren(h("p", { class: "note", text: "The map could not load. The charts above still cover the whole country." }));
  $("use-view").hidden = !window.L;
  $("use-view").addEventListener("click", () => { if (!state.map) return; const b = state.map.getBounds(); setArea({ w: b.getWest(), e: b.getEast(), s: b.getSouth(), n: b.getNorth() }); });
  $("clear-view").addEventListener("click", () => setArea(null));
  $("download").addEventListener("click", download);
  calendarEvents();
  let width = innerWidth;
  addEventListener("resize", () => { if (innerWidth !== width) { width = innerWidth; render(); state.map?.invalidateSize(); } });
  await load(select.value);
}
start().catch(err => { $("answer").textContent = "The fire record could not be loaded."; $("answer-detail").textContent = String(err.message || err); });
