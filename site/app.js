// One Fire Record. Reads data/<Country>.json (made by pipeline/harmonize.py) and draws every part of the page.
"use strict";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SOURCE = { t: "MODIS Terra, scaled", m: "MODIS, scaled", s: "VIIRS Suomi NPP", n: "VIIRS NOAA-20, scaled" };
const FIRE = [1, 2, 3, 4, 5, 6, 7].map(k => `var(--fire-${k})`);
const BLUE = [1, 2, 3, 4, 5, 6, 7].map(k => `var(--blue-${k})`);
const MAPLIBRE = "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/5.24.1/";
const EOX = "https://tiles.maps.eox.at/wmts/1.0.0/";
const $ = id => document.getElementById(id);
const fmt = n => Math.round(n).toLocaleString("en");
const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const state = { d: null, rec: null, view: "joined", strip: "joined", layer: "fires", when: "366", area: null, cache: {}, map: null, fires: null, lang: "en" };

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
const median = vals => quantile([...vals].sort((a, b) => a - b), 0.5);
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
function oklch(L, C, hue) {   // OKLCH to sRGB hex: equal steps of hue look equally bright, so no month shouts
  const r = hue * Math.PI / 180, a = C * Math.cos(r), b = C * Math.sin(r);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, q = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return "#" + [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * q, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * q, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * q]
    .map(v => { v = Math.min(1, Math.max(0, v)); v = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055; return Math.round(v * 255).toString(16).padStart(2, "0"); }).join("");
}
const MONTH_COLORS = MONTHS.map((_, m) => oklch(0.76, 0.14, 25 + m * 30));   // a colour wheel: neighbouring months get neighbouring colours
const UNUSUAL = [["far below normal", "#2f6fb5"], ["below normal", "#8db8e3"], ["normal", "#d8dcd4"], ["above normal", "#f2995f"], ["far above normal", "#d33a1c"]];
function verdict(v, same) {   // where v falls among the same month in earlier years; the same rule as verdict() in harmonize.py
  const sorted = [...same].sort((a, b) => a - b);
  const rank = (sorted.filter(x => x < v).length + sorted.filter(x => x === v).length / 2) / sorted.length;
  return rank <= 0.1 ? 0 : rank <= 0.25 ? 1 : rank < 0.75 ? 2 : rank < 0.9 ? 3 : 4;
}

// ---------- words: English, Sinhala, Tamil for the main lines ----------
const T = {
  en: {
    area: "your area", lowest: "lowest", highest: "highest", verdicts: ["far below normal", "below normal", "normal", "above normal", "far above normal"], months: FULL,
    answer: (month, where, word) => `${month} in ${where}: fire activity was ${word}.`,
    feel: (r, mon) => r < 0.95 ? `, ${Math.round(r * 100)}% of a normal ${mon}` : r <= 1.05 ? `, about a normal ${mon}` : `, ${r.toFixed(1)} times a normal ${mon}`,
    detail: (v, feel, n, mon, mid, q1, q3) => `${v} fire detections${feel}. In the ${n} earlier ${mon}s on record, the middle year had ${mid} and the middle half of years had ${q1} to ${q3}.`,
    fresh: (mon, y, prov) => prov ? ` ${mon} ${y} is the newest full month and comes from NASA's near-real-time files, so treat it as provisional.` : ` ${mon} ${y} is the newest full month in NASA's science-quality files.`,
  },
  si: {
    place: "ස්ථානය", purpose: "NASA චන්ද්‍රිකා 2000 සිට අභ්‍යවකාශයේ සිට ගිනි ගණන් කරයි. එකිනෙකට වෙනස් ලෙස ගණන් කරන චන්ද්‍රිකා වර්ග දෙකක දත්ත මෙම පිටුව එක් වාර්තාවක් ලෙස එකතු කරයි, එවිට මේ වසර අතීතය සමඟ සාධාරණව සැසඳිය හැක.",
    "pace-h": "මේ කන්නය මෙතෙක්", "map-h": "ගිනි ඇවිලෙන තැන්", "l-fires": "මේ වසරේ ගිනි", "l-burn": "ගිනි ඇවිලෙන කාලය", "l-unusual": "දැන් අසාමාන්‍ය",
    "w-30": "අවසන් දින 30", "w-91": "මාස 3", "w-366": "මුළු වසර", "use-view": "මෙම දර්ශනය මගේ ප්‍රදේශය ලෙස ගන්න", "clear-view": "මුළු රටට ආපසු", share: "මෙම දර්ශනයට සබැඳිය පිටපත් කරන්න",
    "seam-h": "පැරණි වාර්තාව ඉතා සන්සුන් ලෙස පෙනෙන්නේ ඇයි", "strip-h": "එක් වාර්තාවක්, චන්ද්‍රිකා හතරක්", joined: "එකතු කළ", "as-counted": "ගණන් කළ ලෙස",
    "cal-h": "ගිනි දින දර්ශනය", "months-h": "ගිනි ඇවිලෙන මාස", "years-h": "නරකම වසර", "take-h": "රැගෙන යන්න",
    "dl-record": "මාසික වාර්තාව (CSV)", "dl-fires": "මේ වසරේ ගිනි (CSV)", "dl-map": "සිතියම් පින්තූරය (PNG)", feed: "මෙම ස්ථානය අනුගමනය කරන්න (RSS)", "method-h": "අප දන්නේ කෙසේද: ක්‍රමය, පරීක්ෂණ සහ සීමා",
    verdicts: ["සාමාන්‍යයට වඩා බොහෝ අඩු", "සාමාන්‍යයට වඩා අඩු", "සාමාන්‍ය", "සාමාන්‍යයට වඩා වැඩි", "සාමාන්‍යයට වඩා බොහෝ වැඩි"],
    answer: (month, where, word) => `${month}, ${where}: ගිනි ක්‍රියාකාරිත්වය ${word} විය.`,
    names: { Sri_Lanka: "ශ්‍රී ලංකාව", Nepal: "නේපාලය", Thailand: "තායිලන්තය", Kenya: "කෙන්යාව", Greece: "ග්‍රීසිය", Portugal: "පෘතුගාලය", Chile: "චිලී", Argentina: "ආර්ජන්ටිනාව" },
    area: "ඔබේ ප්‍රදේශය", lowest: "අඩුම", highest: "වැඩිම",
    feel: (r, mon) => r < 0.95 ? `, සාමාන්‍ය ${mon} මාසයක ${Math.round(r * 100)}%` : r <= 1.05 ? `, සාමාන්‍ය ${mon} මාසයක් පමණ` : `, සාමාන්‍ය ${mon} මාසයක ${r.toFixed(1)} ගුණයක්`,
    detail: (v, feel, n, mon, mid, q1, q3) => `ගිනි හඳුනාගැනීම් ${v}ක්${feel}. වාර්තාවේ ඇති පෙර ${mon} මාස ${n} තුළ, මැද වසරේ ${mid}ක් ද, වසරවලින් මැද භාගයේ ${q1} සිට ${q3} දක්වා ද විය.`,
    fresh: (mon, y, prov) => prov ? ` ${mon} ${y} නවතම සම්පූර්ණ මාසයයි. එය NASA හි ආසන්න තත්‍ය කාලීන දත්තවලින් පැමිණෙන බැවින් තාවකාලික ලෙස සලකන්න.` : ` ${mon} ${y} යනු NASA හි විද්‍යාත්මක තත්ත්වයේ දත්තවල නවතම සම්පූර්ණ මාසයයි.`,
    months: ["ජනවාරි", "පෙබරවාරි", "මාර්තු", "අප්‍රේල්", "මැයි", "ජූනි", "ජූලි", "අගෝස්තු", "සැප්තැම්බර්", "ඔක්තෝබර්", "නොවැම්බර්", "දෙසැම්බර්"],
  },
  ta: {
    place: "இடம்", purpose: "NASA 2000 முதல் விண்வெளியிலிருந்து தீயைக் கணக்கிடுகிறது, மிகவும் வேறுபட்ட முறையில் கணக்கிடும் இரண்டு வகை செயற்கைக்கோள்களுடன். இந்தப் பக்கம் அவற்றை ஒரே பதிவாக இணைக்கிறது, அதனால் இந்த ஆண்டை கடந்த காலத்துடன் நியாயமாக ஒப்பிடலாம்.",
    "pace-h": "இந்தப் பருவம் இதுவரை", "map-h": "எங்கே எரிகிறது", "l-fires": "இந்த ஆண்டின் தீ", "l-burn": "எப்போது எரிகிறது", "l-unusual": "இப்போது வழக்கத்திற்கு மாறானது",
    "w-30": "கடைசி 30 நாட்கள்", "w-91": "3 மாதங்கள்", "w-366": "முழு ஆண்டு", "use-view": "இந்தக் காட்சியை என் பகுதியாகப் பயன்படுத்து", "clear-view": "முழு நாட்டிற்குத் திரும்பு", share: "இந்தக் காட்சிக்கான இணைப்பை நகலெடு",
    "seam-h": "பழைய பதிவு ஏன் மிகவும் அமைதியாகத் தெரிகிறது", "strip-h": "ஒரே பதிவு, நான்கு செயற்கைக்கோள்கள்", joined: "இணைக்கப்பட்டது", "as-counted": "கணக்கிட்டபடி",
    "cal-h": "தீ நாட்காட்டி", "months-h": "எந்த மாதங்கள் எரிகின்றன", "years-h": "மோசமான ஆண்டுகள்", "take-h": "எடுத்துச் செல்லுங்கள்",
    "dl-record": "மாதாந்திரப் பதிவு (CSV)", "dl-fires": "இந்த ஆண்டின் தீ (CSV)", "dl-map": "வரைபடப் படம் (PNG)", feed: "இந்த இடத்தைப் பின்தொடருங்கள் (RSS)", "method-h": "நாங்கள் எப்படி அறிவோம்: முறை, சோதனைகள், வரம்புகள்",
    verdicts: ["இயல்பை விட மிகக் குறைவு", "இயல்பை விடக் குறைவு", "இயல்பானது", "இயல்பை விட அதிகம்", "இயல்பை விட மிக அதிகம்"],
    answer: (month, where, word) => `${month}, ${where}: தீ செயல்பாடு ${word}.`,
    names: { Sri_Lanka: "இலங்கை", Nepal: "நேபாளம்", Thailand: "தாய்லாந்து", Kenya: "கென்யா", Greece: "கிரீஸ்", Portugal: "போர்ச்சுகல்", Chile: "சிலி", Argentina: "அர்ஜென்டினா" },
    area: "உங்கள் பகுதி", lowest: "குறைந்தது", highest: "அதிகம்",
    feel: (r, mon) => r < 0.95 ? `, வழக்கமான ${mon} மாதத்தின் ${Math.round(r * 100)}%` : r <= 1.05 ? `, ஏறக்குறைய வழக்கமான ${mon} மாதம் போல` : `, வழக்கமான ${mon} மாதத்தின் ${r.toFixed(1)} மடங்கு`,
    detail: (v, feel, n, mon, mid, q1, q3) => `${v} தீ கண்டறிதல்கள்${feel}. பதிவில் உள்ள முந்தைய ${n} ${mon} மாதங்களில், நடு ஆண்டில் ${mid}; ஆண்டுகளின் நடுப் பாதியில் ${q1} முதல் ${q3} வரை.`,
    fresh: (mon, y, prov) => prov ? ` ${mon} ${y} மிகச் சமீபத்திய முழு மாதம்; இது NASA-வின் கிட்டத்தட்ட நிகழ்நேரத் தரவிலிருந்து வருவதால், தற்காலிகமானதாகக் கருதுங்கள்.` : ` ${mon} ${y} NASA-வின் அறிவியல் தரத் தரவில் மிகச் சமீபத்திய முழு மாதம்.`,
    months: ["ஜனவரி", "பிப்ரவரி", "மார்ச்", "ஏப்ரல்", "மே", "ஜூன்", "ஜூலை", "ஆகஸ்ட்", "செப்டம்பர்", "அக்டோபர்", "நவம்பர்", "டிசம்பர்"],
  },
};
// the notes under each chart, in all three languages; a missing line falls back to English
Object.assign(T.en, {
  area: "your area", hint: "Tap a gold country to open its fire record",
  paceNote: (start, from, to, where, n, rank, pct) => `Each thin line is one fire year, counted from ${start}, the quietest month here, so a season is never cut in two; dashed lines are years estimated from MODIS. From ${from} to ${to}, ${where} had ${n}: ${rank}, ${pct}% of a middle year.`,
  rankMost: (r, total) => `the ${r === 1 ? "" : ordinal(r) + " "}most of ${total} fire years`,
  rankFewest: (r, total) => `the ${r === 1 ? "" : ordinal(r) + " "}fewest of ${total} fire years`,
  outlook: (n, a, c, mid, q1, q3) => `<b>What usually comes next:</b> in the ${n} earlier years, ${a} to ${c} brought ${mid} detections in the middle year (middle half of years: ${q1} to ${q3}). This is the past, not a forecast.`,
  stripCounted: f => `As each sensor counted, with no joining. MODIS (blue) since 2000, VIIRS (orange) since 2012. The jump between them is the sensor, not the fire: VIIRS sees about ${f} times more here.`,
  stripJoined: (lo, hi) => `Fire detections per month, in VIIRS units. Before 2012 each month is estimated from MODIS; the grey band shows the likely range. In a busy month the real value was usually between ${lo}% below and ${hi}% above the estimate.`,
  seam: (name, date, gap, k) => `The same fire in ${name} on ${date}, seen by both satellites ${gap ? `${gap} minutes apart` : "in the same minute"}. Each square is one pixel that NASA marked as fire, drawn at its real size. VIIRS counted ${k} times more for the same burning. Put the two records side by side without joining them, and every year before 2012 looks far calmer than it was.`,
  calJoined: "Each square is one month. A cut corner means the value is an estimate scaled from MODIS.",
  calModis: f => `MODIS as counted, not scaled. Compare its colours with the joined view: the same fires, about ${f} times fewer detections.`,
  calViirs: "VIIRS as counted. It starts in 2012, so on its own it cannot say what is normal over 25 years.",
  perMonth: x => `${x}+ detections a month`, estMODIS: "estimated from MODIS", noData: "no data", byVIIRS: "measured by VIIRS",
  worstMeasured: y => `The worst year, ${y}, was measured by VIIRS, not estimated.`,
  worstArea: y => `The worst year, ${y}, is an estimate from MODIS. Read it with its range.`,
  worstCheck: (y, v) => `Check: the worst year, ${y}, is an estimate from MODIS. Terra, the one satellite that flew all of 2001 to 2021, counted with no scaling at all, ranks ${y} ${v}.`,
  rank1: "first too", rankTop: (r, n) => `${ordinal(r)} of ${n}, so it was a bad year whatever the method`, rankLow: (r, n) => `only ${ordinal(r)} of ${n}, so treat this peak with care`,
  periods: { 30: "30 days", 91: "3 months" },
  mapFires: (n, name, year, period, until, m, prov) => `${n} spots where NASA's NOAA-20 satellite saw fire in ${name}${year ? ` in ${year}` : `, ${period} up to ${until}`}. Zoomed out, they glow as a heat map; zoom in and each dot is one satellite pixel, about ${m} m. Tap a dot for its date. A dot is a spot that was burning when the satellite passed: often a field being cleared or a grass fire, sometimes a wildfire. Most are too small to make the news.${prov ? ` Fires from ${prov} on are near-real-time data, so provisional.` : ""}`,
  mapBurn: km => `Each square of about ${km} km is coloured by the month it burns most, from 26 years of the joined record; stronger colour means more fire. Tap a square for its numbers.`,
  mapUnusual: (km, mon, y, prov) => `Each square of about ${km} km compares ${mon} ${y} with the same month in the years before${prov ? " (near-real-time data, provisional)" : ""}. Squares with almost no fire either way are left out.`,
  mapLoading: "Loading this year's fires…", mapError: "This year's fires could not load. The charts above are not affected.",
  zoomIn: "Zoom in to a region first: the area must be smaller than a continent.",
  ages: ["last 7 days of data", "8 to 30 days before", "1 to 3 months before", "earlier in the year"],
});
Object.assign(T.si, {
  hint: "ගිනි වාර්තාව විවෘත කිරීමට රන්වන් රටක් තට්ටු කරන්න",
  "months-note": "සෑම දින දර්ශන මාසයකම සාමාන්‍ය ගිනි හඳුනාගැනීම් ගණන. තීරුව මැද වසරයි; රේඛාව වසරවලින් මැද භාගය පෙන්වයි.",
  "years-note": "වසරකට ගිනි හඳුනාගැනීම්. ලා තීරු MODIS ඇස්තමේන්තු වේ; ඒවායේ රේඛාව පරීක්ෂණ දෝෂය පෙන්වයි.",
  "table-sum": "දින දර්ශනය වගුවක් ලෙස කියවන්න",
  paceNote: (start, from, to, where, n, rank, pct) => `සෑම තුනී රේඛාවක්ම එක් ගිනි වසරකි. එය මෙහි නිහඬම මාසය වන ${start} සිට ගණන් කෙරේ, එවිට කන්නයක් දෙකට නොකැඩේ; කඩ ඉරි රේඛා MODIS වලින් ඇස්තමේන්තු කළ වසර වේ. ${from} සිට ${to} දක්වා ${where} හි ගිනි හඳුනාගැනීම් ${n}ක් විය: ${rank}, මැද වසරක ${pct}%.`,
  rankMost: (r, total) => `ගිනි වසර ${total} අතරින් ${r === 1 ? "" : r + " වැනි "}වැඩිම`,
  rankFewest: (r, total) => `ගිනි වසර ${total} අතරින් ${r === 1 ? "" : r + " වැනි "}අඩුම`,
  outlook: (n, a, c, mid, q1, q3) => `<b>සාමාන්‍යයෙන් ඊළඟට එන්නේ:</b> පෙර වසර ${n} තුළ, ${a} සිට ${c} දක්වා මැද වසරේ ගිනි හඳුනාගැනීම් ${mid}ක් විය (වසරවලින් මැද භාගය: ${q1} සිට ${q3}). මෙය අතීතයයි, අනාවැකියක් නොවේ.`,
  stripCounted: f => `එකතු නොකර, එක් එක් සංවේදකය ගණන් කළ ලෙස. MODIS (නිල්) 2000 සිට, VIIRS (තැඹිලි) 2012 සිට. ඒ දෙක අතර පැනීම ඇත්තේ සංවේදකය නිසා මිස ගින්න නිසා නොවේ: මෙහි VIIRS ${f} ගුණයක් පමණ වැඩියෙන් දකී.`,
  stripJoined: (lo, hi) => `මසකට ගිනි හඳුනාගැනීම්, VIIRS ඒකක වලින්. 2012 ට පෙර සෑම මාසයක්ම MODIS වලින් ඇස්තමේන්තු කර ඇත; අළු පටිය විය හැකි පරාසය පෙන්වයි. කාර්යබහුල මාසයක සැබෑ අගය සාමාන්‍යයෙන් ඇස්තමේන්තුවට වඩා ${lo}% අඩු සහ ${hi}% වැඩි අතර විය.`,
  seam: (name, date, gap, k) => `${date} දින ${name} හි එකම ගින්න, චන්ද්‍රිකා දෙකම ${gap ? `මිනිත්තු ${gap}ක පරතරයකින්` : "එකම මිනිත්තුවේ"} දුටුවේය. සෑම කොටුවක්ම NASA ගින්නක් ලෙස සලකුණු කළ එක් පික්සලයක් වන අතර එය සැබෑ ප්‍රමාණයෙන් ඇඳ ඇත. එකම ගින්න සඳහා VIIRS ${k} ගුණයක් වැඩියෙන් ගණන් කළේය. වාර්තා දෙක එකතු නොකර පැත්තකින් තැබුවොත්, 2012 ට පෙර සෑම වසරක්ම ඇත්තට වඩා බොහෝ සන්සුන් ලෙස පෙනේ.`,
  calJoined: "සෑම කොටුවක්ම එක් මාසයකි. කැපූ කොනක් යනු එම අගය MODIS වලින් පරිමාණය කළ ඇස්තමේන්තුවක් බවයි.",
  calModis: f => `MODIS ගණන් කළ ලෙස, පරිමාණය නොකර. එහි වර්ණ එකතු කළ දර්ශනය සමඟ සසඳන්න: එකම ගිනි, හඳුනාගැනීම් ${f} ගුණයක් පමණ අඩුයි.`,
  calViirs: "VIIRS ගණන් කළ ලෙස. එය 2012 දී ආරම්භ වන නිසා, තනිවම වසර 25ක් පුරා සාමාන්‍ය කුමක්දැයි කිව නොහැක.",
  perMonth: x => `මසකට හඳුනාගැනීම් ${x}+`, estMODIS: "MODIS වලින් ඇස්තමේන්තු කළ", noData: "දත්ත නැත", byVIIRS: "VIIRS මගින් මනින ලද",
  worstMeasured: y => `නරකම වසර වන ${y} VIIRS මගින් මනින ලදී, ඇස්තමේන්තු කළේ නැත.`,
  worstArea: y => `නරකම වසර වන ${y} MODIS ඇස්තමේන්තුවකි. එය එහි පරාසය සමඟ කියවන්න.`,
  worstCheck: (y, v) => `පරීක්ෂාව: නරකම වසර වන ${y} MODIS ඇස්තමේන්තුවකි. 2001 සිට 2021 දක්වා මුළු කාලයම පියාසර කළ එකම චන්ද්‍රිකාව වන Terra, කිසිදු පරිමාණයකින් තොරව ගණන් කළ විට, ${y} ${v}.`,
  rank1: "පළමු ස්ථානයේම තබයි", rankTop: (r, n) => `වසර ${n} අතරින් ${r} වැනි ස්ථානයේ තබයි, එබැවින් ක්‍රමය කුමක් වුවත් එය නරක වසරක් විය`, rankLow: (r, n) => `වසර ${n} අතරින් ${r} වැනි ස්ථානයේ පමණක් තබයි, එබැවින් මෙම උච්චය ප්‍රවේශමෙන් සලකන්න`,
  periods: { 30: "දින 30", 91: "මාස 3" },
  mapFires: (n, name, year, period, until, m, prov) => `${name} හි NASA හි NOAA-20 චන්ද්‍රිකාව ගිනි දුටු ස්ථාන ${n}ක්${year ? ` (${year})` : `, ${until} දක්වා ${period}`}. දුරින් බලන විට ඒවා තාප සිතියමක් ලෙස දිලිසේ; ළං කළ විට සෑම තිතක්ම මීටර් ${m}ක් පමණ වූ එක් චන්ද්‍රිකා පික්සලයකි. දිනය බැලීමට තිතක් තට්ටු කරන්න. තිතක් යනු චන්ද්‍රිකාව යන විට ගිනි ගනිමින් තිබූ ස්ථානයකි: බොහෝ විට එළි කරන කුඹුරක් හෝ ඉඩමක්, නැතහොත් තණකොළ ගින්නක්, සමහර විට වල් ගින්නක්. බොහොමයක් පුවත්වලට එන තරම් විශාල නැත.${prov ? ` ${prov} සිට ගිනි ආසන්න තත්‍ය කාලීන දත්ත බැවින් තාවකාලිකය.` : ""}`,
  mapBurn: km => `කි.මී. ${km}ක් පමණ වූ සෑම කොටුවක්ම වැඩිපුරම ගිනි ගන්නා මාසය අනුව වර්ණ ගන්වා ඇත, එකතු කළ වාර්තාවේ වසර 26කින්; තද වර්ණය යනු වැඩි ගින්නකි. අංක බැලීමට කොටුවක් තට්ටු කරන්න.`,
  mapUnusual: (km, mon, y, prov) => `කි.මී. ${km}ක් පමණ වූ සෑම කොටුවක්ම ${y} ${mon} පෙර වසරවල එම මාසය සමඟ සසඳයි${prov ? " (ආසන්න තත්‍ය කාලීන දත්ත, තාවකාලික)" : ""}. දෙපැත්තෙන්ම ගිනි නැති තරම් කොටු ඉවත් කර ඇත.`,
  mapLoading: "මේ වසරේ ගිනි පූරණය වෙමින්…", mapError: "මේ වසරේ ගිනි පූරණය කළ නොහැකි විය. ඉහත ප්‍රස්ථාරවලට බලපෑමක් නැත.",
  zoomIn: "පළමුව ප්‍රදේශයකට ළං කරන්න: ප්‍රදේශය මහාද්වීපයකට වඩා කුඩා විය යුතුය.",
  ages: ["දත්තවල අවසන් දින 7", "දින 8 සිට 30 කට පෙර", "මාස 1 සිට 3 කට පෙර", "වසරේ කලින්"],
});
Object.assign(T.ta, {
  hint: "தீப் பதிவைத் திறக்க ஒரு தங்க நிற நாட்டைத் தட்டுங்கள்",
  "months-note": "ஒவ்வொரு மாதத்திலும் வழக்கமான தீ கண்டறிதல்களின் எண்ணிக்கை. பட்டை நடு ஆண்டு; கோடு ஆண்டுகளின் நடுப் பாதியைக் காட்டுகிறது.",
  "years-note": "ஆண்டுக்கு தீ கண்டறிதல்கள். வெளிர் பட்டைகள் MODIS மதிப்பீடுகள்; அவற்றின் கோடு சோதனைப் பிழையைக் காட்டுகிறது.",
  "table-sum": "நாட்காட்டியை அட்டவணையாகப் படிக்கவும்",
  paceNote: (start, from, to, where, n, rank, pct) => `ஒவ்வொரு மெல்லிய கோடும் ஒரு தீ ஆண்டு. இங்கே மிக அமைதியான மாதமான ${start} முதல் எண்ணப்படுகிறது, அதனால் ஒரு பருவம் இரண்டாகப் பிரிவதில்லை; புள்ளிக் கோடுகள் MODIS இலிருந்து மதிப்பிடப்பட்ட ஆண்டுகள். ${from} முதல் ${to} வரை ${where} இல் ${n} தீ கண்டறிதல்கள்: ${rank}, நடு ஆண்டின் ${pct}%.`,
  rankMost: (r, total) => `${total} தீ ஆண்டுகளில் ${r === 1 ? "மிக" : r + "-ஆவது"} அதிகம்`,
  rankFewest: (r, total) => `${total} தீ ஆண்டுகளில் ${r === 1 ? "மிகக்" : r + "-ஆவது"} குறைவு`,
  outlook: (n, a, c, mid, q1, q3) => `<b>வழக்கமாக அடுத்து வருவது:</b> முந்தைய ${n} ஆண்டுகளில், ${a} முதல் ${c} வரை நடு ஆண்டில் ${mid} தீ கண்டறிதல்கள் (ஆண்டுகளின் நடுப் பாதி: ${q1} முதல் ${q3} வரை). இது கடந்த காலம், முன்னறிவிப்பு அல்ல.`,
  stripCounted: f => `இணைக்காமல், ஒவ்வொரு உணரியும் கணக்கிட்டபடி. MODIS (நீலம்) 2000 முதல், VIIRS (ஆரஞ்சு) 2012 முதல். அவற்றுக்கிடையிலான தாவல் உணரியால் வருவது, தீயால் அல்ல: இங்கே VIIRS சுமார் ${f} மடங்கு அதிகமாகக் காண்கிறது.`,
  stripJoined: (lo, hi) => `மாதத்திற்கு தீ கண்டறிதல்கள், VIIRS அலகுகளில். 2012க்கு முன் ஒவ்வொரு மாதமும் MODIS இலிருந்து மதிப்பிடப்பட்டது; சாம்பல் பட்டை சாத்தியமான வரம்பைக் காட்டுகிறது. பரபரப்பான மாதத்தில் உண்மையான மதிப்பு பொதுவாக மதிப்பீட்டை விட ${lo}% குறைவுக்கும் ${hi}% அதிகத்துக்கும் இடையில் இருந்தது.`,
  seam: (name, date, gap, k) => `${date} அன்று ${name} இல் ஒரே தீ, இரண்டு செயற்கைக்கோள்களும் ${gap ? `${gap} நிமிட இடைவெளியில்` : "ஒரே நிமிடத்தில்"} கண்டன. ஒவ்வொரு சதுரமும் NASA தீ என்று குறித்த ஒரு பிக்சல், அதன் உண்மையான அளவில் வரையப்பட்டது. அதே தீக்கு VIIRS ${k} மடங்கு அதிகமாகக் கணக்கிட்டது. இணைக்காமல் இரண்டு பதிவுகளையும் அருகருகே வைத்தால், 2012க்கு முந்தைய ஒவ்வொரு ஆண்டும் உண்மையை விட மிகவும் அமைதியாகத் தெரியும்.`,
  calJoined: "ஒவ்வொரு சதுரமும் ஒரு மாதம். வெட்டப்பட்ட மூலை என்றால் அந்த மதிப்பு MODIS இலிருந்து அளவிடப்பட்ட மதிப்பீடு.",
  calModis: f => `MODIS கணக்கிட்டபடி, அளவிடாமல். அதன் நிறங்களை இணைக்கப்பட்ட காட்சியுடன் ஒப்பிடுங்கள்: அதே தீ, சுமார் ${f} மடங்கு குறைவான கண்டறிதல்கள்.`,
  calViirs: "VIIRS கணக்கிட்டபடி. இது 2012 இல் தொடங்குவதால், தனியாக 25 ஆண்டுகளில் எது இயல்பு என்று சொல்ல முடியாது.",
  perMonth: x => `மாதத்திற்கு ${x}+ கண்டறிதல்கள்`, estMODIS: "MODIS இலிருந்து மதிப்பிடப்பட்டது", noData: "தரவு இல்லை", byVIIRS: "VIIRS அளந்தது",
  worstMeasured: y => `மோசமான ஆண்டான ${y}, VIIRS ஆல் அளக்கப்பட்டது, மதிப்பிடப்படவில்லை.`,
  worstArea: y => `மோசமான ஆண்டான ${y}, MODIS மதிப்பீடு. அதன் வரம்புடன் படியுங்கள்.`,
  worstCheck: (y, v) => `சோதனை: மோசமான ஆண்டான ${y}, MODIS மதிப்பீடு. 2001 முதல் 2021 வரை முழுவதும் பறந்த ஒரே செயற்கைக்கோளான Terra, எந்த அளவிடலும் இல்லாமல் கணக்கிட்டால், ${y} ஐ ${v}.`,
  rank1: "முதலிடத்திலேயே வைக்கிறது", rankTop: (r, n) => `${n} இல் ${r}-ஆவது இடத்தில் வைக்கிறது, எனவே எந்த முறையிலும் அது மோசமான ஆண்டு`, rankLow: (r, n) => `${n} இல் ${r}-ஆவது இடத்தில் மட்டுமே வைக்கிறது, எனவே இந்த உச்சத்தைக் கவனமாகக் கருதுங்கள்`,
  periods: { 30: "30 நாட்கள்", 91: "3 மாதங்கள்" },
  mapFires: (n, name, year, period, until, m, prov) => `${name} இல் NASA வின் NOAA-20 செயற்கைக்கோள் தீயைக் கண்ட ${n} இடங்கள்${year ? ` (${year})` : `, ${until} வரை ${period}`}. தொலைவில் இருந்து பார்த்தால் அவை வெப்ப வரைபடமாக ஒளிர்கின்றன; பெரிதாக்கினால் ஒவ்வொரு புள்ளியும் சுமார் ${m} மீ அளவுள்ள ஒரு செயற்கைக்கோள் பிக்சல். தேதியைப் பார்க்க ஒரு புள்ளியைத் தட்டுங்கள். ஒரு புள்ளி என்பது செயற்கைக்கோள் கடந்தபோது எரிந்துகொண்டிருந்த இடம்: பெரும்பாலும் சுத்தம் செய்யப்படும் வயல் அல்லது புல் தீ, சில நேரங்களில் காட்டுத் தீ. பெரும்பாலானவை செய்திகளில் வரும் அளவுக்குப் பெரியவை அல்ல.${prov ? ` ${prov} முதல் உள்ள தீ கிட்டத்தட்ட நிகழ்நேரத் தரவு, எனவே தற்காலிகமானது.` : ""}`,
  mapBurn: km => `சுமார் ${km} கி.மீ. அளவுள்ள ஒவ்வொரு சதுரமும் அது அதிகம் எரியும் மாதத்தின்படி நிறமிடப்பட்டுள்ளது, இணைக்கப்பட்ட பதிவின் 26 ஆண்டுகளிலிருந்து; அடர்ந்த நிறம் என்றால் அதிக தீ. எண்களைப் பார்க்க ஒரு சதுரத்தைத் தட்டுங்கள்.`,
  mapUnusual: (km, mon, y, prov) => `சுமார் ${km} கி.மீ. அளவுள்ள ஒவ்வொரு சதுரமும் ${y} ${mon} ஐ முந்தைய ஆண்டுகளின் அதே மாதத்துடன் ஒப்பிடுகிறது${prov ? " (கிட்டத்தட்ட நிகழ்நேரத் தரவு, தற்காலிகமானது)" : ""}. இரு பக்கத்திலும் தீ கிட்டத்தட்ட இல்லாத சதுரங்கள் விடப்பட்டுள்ளன.`,
  mapLoading: "இந்த ஆண்டின் தீ ஏற்றப்படுகிறது…", mapError: "இந்த ஆண்டின் தீயை ஏற்ற முடியவில்லை. மேலே உள்ள வரைபடங்கள் பாதிக்கப்படவில்லை.",
  zoomIn: "முதலில் ஒரு பகுதிக்குப் பெரிதாக்குங்கள்: பகுதி ஒரு கண்டத்தை விடச் சிறியதாக இருக்க வேண்டும்.",
  ages: ["தரவின் கடைசி 7 நாட்கள்", "8 முதல் 30 நாட்களுக்கு முன்", "1 முதல் 3 மாதங்களுக்கு முன்", "ஆண்டின் முன்பகுதியில்"],
});
const words = () => ({ ...T.en, ...T[state.lang] });
const placeName = d => T[state.lang].names?.[d.id] ?? d.name;
function applyLang() {
  const t = T[state.lang];
  document.documentElement.lang = state.lang;
  document.querySelectorAll("#place option").forEach(o => { o.textContent = T[state.lang].names?.[o.value] ?? o.value.replace(/_/g, " "); });
  document.querySelectorAll("[data-t]").forEach(e => {
    e.dataset.en ??= e.textContent;
    e.textContent = t[e.dataset.t] ?? e.dataset.en;
  });
}

// ---------- the record ----------
const ym = (d, i) => { const k = +d.first.slice(5) - 1 + i; return { y: +d.first.slice(0, 4) + Math.floor(k / 12), m: k % 12 }; };
const label = (d, i) => { const { y, m } = ym(d, i); return `${MONTHS[m]} ${y}`; };
const provisional = (d, i) => { const { y, m } = ym(d, i); return !!d.provisional_from && `${y}-${String(m + 1).padStart(2, "0")}` >= d.provisional_from; };
const source = (d, i) => SOURCE[d.src[i]] + (provisional(d, i) ? ", near-real-time (provisional)" : "");
const newest = d => Math.max(d.src.lastIndexOf("s"), d.src.lastIndexOf("n"));

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
const factorOf = (d, i) => (d.src[i] === "t" && d.factor.terra_by_month ? d.factor.terra_by_month : d.factor.by_month)[ym(d, i).m];
function join(d, c) {         // the same rule as join() in pipeline/harmonize.py
  const joined = [], lo = [], hi = [];
  for (let i = 0; i < c.modis.length; i++) {
    const src = d.src[i];
    let v, band = [1, 1];
    if (src === "s") v = c.snpp[i] || 0;
    else if (src === "n") v = (c.n20[i] || 0) * d.factor.handover;
    else {
      v = c.modis[i] * factorOf(d, i);
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
function byYear(d, values) {  // {year: [12 monthly values or null]}
  const out = {};
  values.forEach((v, i) => { const { y, m } = ym(d, i); (out[y] ??= Array(12).fill(null))[m] = v; });
  return out;
}

// ---------- tooltip ----------
const mouseOnly = f => e => { if (e.pointerType !== "touch") f(e); };   // a finger lifting is not "leaving": on a phone the tip stays until the next tap
function hideTips() { tip(); document.querySelectorAll(".cross").forEach(c => c.setAttribute("visibility", "hidden")); }
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
  return `<b>${fmt(v)} detections</b>${label(d, i)}<br><small>${estimated(d, i) ? `estimated from ${fmt(rec.modis[i])} MODIS detections, likely ${fmt(rec.lo[i])} to ${fmt(rec.hi[i])}` : source(d, i)}</small>`;
}
function hoverTips(svg, W, find) {   // one pointer handler for a whole chart: find(x, y in chart units) returns [anchor rect, html] or null
  const move = e => {
    const r = svg.getBoundingClientRect(), k = W / r.width, hit = find((e.clientX - r.left) * k, (e.clientY - r.top) * k);
    hit ? tip({ left: e.clientX, right: e.clientX, top: e.clientY - 20, bottom: e.clientY + 20, width: 0 }, hit) : tip();
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointerleave", mouseOnly(() => tip()));
}

// ---------- is this month normal ----------
function drawAnswer(d, rec) {
  const i = newest(d), { y, m } = ym(d, i), v = rec.joined[i];
  const same = [];
  for (let k = i - 12; k >= 0; k -= 12) same.push(rec.joined[k]);
  same.sort((a, b) => a - b);
  const cls = verdict(v, same), t = T[state.lang], mon = t.months[m];
  const [q1, mid, q3] = [0.25, 0.5, 0.75].map(q => Math.round(quantile(same, q)));
  const where = state.area ? (state.lang === "en" ? `your area in ${d.name}` : `${t.area}, ${placeName(d)}`) : placeName(d);
  $("answer").textContent = t.answer(`${mon} ${y}`, where, t.verdicts[cls]);
  $("answer-detail").textContent = t.detail(fmt(v), mid ? t.feel(v / mid, mon) : "", same.length, mon, fmt(mid), fmt(q1), fmt(q3)) + t.fresh(mon, y, provisional(d, i));
  const max = Math.max(same[same.length - 1], v, 1), pct = x => (x / max * 100).toFixed(1) + "%";
  const range = $("range");
  range.setAttribute("aria-label", `Range of ${FULL[m]} values: lowest ${fmt(same[0])}, middle ${fmt(mid)}, highest ${fmt(same[same.length - 1])}; this year ${fmt(v)}.`);
  range.replaceChildren(
    h("div", { class: "line" }),
    h("div", { class: "box", style: `left:${pct(q1)};width:${pct(q3 - q1)}` }),
    h("div", { class: "mid", style: `left:${pct(mid)}` }),
    h("div", { class: "now", style: `left:${pct(v)}` }),
    h("span", { style: "left:0", text: `${t.lowest} ${fmt(same[0])}` }),
    h("span", { style: "right:0", text: `${t.highest} ${fmt(same[same.length - 1])}` }));
}

// ---------- this season so far: every fire year as a running total ----------
// A fire year starts in the place's quietest month, so a season that runs across New Year (Chile, Kenya) is never cut in two.
function quietMonth(d) {
  const by = MONTHS.map(() => []);
  d.joined.forEach((v, i) => by[ym(d, i).m].push(v));
  const med = by.map(median);
  return med.indexOf(Math.min(...med));
}
function drawPace(d, rec) {
  const box = $("pace"), start = quietMonth(d), n = rec.joined.length, last = ym(d, n - 1);
  const fyOf = ({ y, m }) => (m >= start ? y : y - 1), pos = m => (m - start + 12) % 12, nowFy = fyOf(last), nowP = pos(last.m);
  const fyName = fy => (start ? `${fy}–${String(fy + 1).slice(2)}` : String(fy));
  const runs = {};
  rec.joined.forEach((v, i) => { const t = ym(d, i); (runs[fyOf(t)] ??= Array(12).fill(null))[pos(t.m)] = v; });
  for (const a of Object.values(runs)) { let s = 0; a.forEach((v, k) => (a[k] = v === null ? null : (s += v))); }
  const past = Object.keys(runs).map(Number).filter(fy => fy !== nowFy && runs[fy].every(v => v !== null));
  const order = MONTHS.map((_, k) => (start + k) % 12);
  const W = Math.max(300, box.clientWidth), H = 260, pad = { l: 8, r: 52, t: 18, b: 24 }, plotH = H - pad.t - pad.b;
  const cur = runs[nowFy] ? runs[nowFy].slice(0, nowP + 1) : [];
  const top = niceUp(Math.max(1, ...past.map(fy => runs[fy][11]), cur[nowP] ?? 0));
  const x = k => pad.l + (k + 1) / 12 * (W - pad.l - pad.r), y = v => pad.t + plotH - v / top * plotH;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  for (const t of [0.5, 1]) svg.append(s("line", { x1: pad.l, x2: W - pad.r, y1: y(top * t), y2: y(top * t), stroke: "var(--rule)" }), s("text", { x: pad.l + 2, y: y(top * t) - 3, class: "tick" }, fmt(top * t)));
  const path = a => "M" + pad.l + "," + y(0) + a.map((v, k) => `L${x(k).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const band = order.map((_, k) => { const vals = past.map(fy => runs[fy][k]).sort((a, b) => a - b); return [quantile(vals, 0.25), quantile(vals, 0.5), quantile(vals, 0.75)]; });
  svg.append(s("path", { d: "M" + band.map((b, k) => `${x(k).toFixed(1)},${y(b[2]).toFixed(1)}`).join("L") + "L" + band.map((b, k) => `${x(k).toFixed(1)},${y(b[0]).toFixed(1)}`).reverse().join("L") + "Z", fill: "var(--fire-1)" }));
  const estMonths = fy => Math.max(0, Math.min(12, 2012 * 12 + 1 - (fy * 12 + start)));   // months before February 2012: estimated from MODIS
  const est = fy => estMonths(fy) > 6;
  for (const fy of past) svg.append(s("path", { d: path(runs[fy]), fill: "none", stroke: est(fy) ? "var(--ink-3)" : "var(--ink-2)", "stroke-width": 0.8, opacity: 0.35, "stroke-dasharray": est(fy) ? "3 2" : null }));
  svg.append(s("path", { d: path(band.map(b => b[1])), fill: "none", stroke: "var(--ink)", "stroke-width": 1.25, "stroke-dasharray": "5 3" }));
  svg.append(s("text", { x: x(11) + 4, y: y(band[11][1]) + 4, class: "label" }, "middle"));
  const worst = past.reduce((a, b) => (runs[b][11] > runs[a][11] ? b : a));
  svg.append(s("text", { x: x(11) + 4, y: y(runs[worst][11]) + 4, class: "tick" }, fyName(worst)));
  if (cur.length) {
    svg.append(s("path", { d: path(cur), fill: "none", stroke: "var(--fire-6)", "stroke-width": 2.5, "stroke-linejoin": "round" }));
    svg.append(s("circle", { cx: x(nowP), cy: y(cur[nowP]), r: 4, fill: "var(--fire-6)", stroke: "var(--paper)", "stroke-width": 2 }));
    const right = nowP > 8;
    svg.append(s("text", { x: x(nowP) + (right ? -6 : 6), y: y(cur[nowP]) - 8, class: "label", "text-anchor": right ? "end" : "start" }, fyName(nowFy)));
  }
  order.forEach((m, k) => svg.append(s("text", { x: x(k), y: H - 6, "text-anchor": "middle" }, MONTHS[m][0])));
  svg.append(s("line", { x1: pad.l, x2: W - pad.r, y1: y(0), y2: y(0), stroke: "var(--ink)" }));
  hoverTips(svg, W, (px, py) => {
    const k = Math.max(0, Math.min(11, Math.round((px - pad.l) / (W - pad.l - pad.r) * 12 - 1)));
    const all = [...past.map(fy => [fy, runs[fy][k]]), ...(k <= nowP && cur.length ? [[nowFy, cur[k]]] : [])];
    const [fy, v] = all.reduce((a, b) => (Math.abs(y(b[1]) - py) < Math.abs(y(a[1]) - py) ? b : a));
    return `<b>${fyName(fy)}: ${fmt(v)}</b>detections from ${FULL[start]} to the end of ${FULL[order[k]]}${estMonths(fy) === 12 ? "<br><small>estimated from MODIS</small>" : estMonths(fy) ? `<br><small>${estMonths(fy)} of 12 months estimated from MODIS</small>` : ""}`;
  });
  box.replaceChildren(svg);
  const w = words(), where = state.area ? w.area : placeName(d);
  if (!cur.length) { $("pace-note").textContent = ""; $("outlook").textContent = ""; return; }
  const sofar = cur[nowP], others = past.map(fy => runs[fy][nowP]).sort((a, b) => a - b), rank = others.filter(v => v > sofar).length + 1, mid = quantile(others, 0.5), total = past.length + 1;
  svg.setAttribute("aria-label", `Running total of fire detections in each fire year in ${where}, from ${FULL[start]}. ${fyName(nowFy)} so far: ${fmt(sofar)}; a middle year had ${fmt(mid)} by the end of ${FULL[last.m]}.`);
  $("pace-note").textContent = w.paceNote(w.months[start], `${w.months[start]} ${nowFy}`, `${w.months[last.m]} ${last.y}`, where, fmt(sofar),
    rank <= total / 2 ? w.rankMost(rank, total) : w.rankFewest(total + 1 - rank, total), mid ? Math.round(sofar / mid * 100) : 0);
  // what usually comes next: the three months after the newest, in every earlier year
  const next = [1, 2, 3].map(k => (last.m + k) % 12), sums = [];
  for (let i = 0; i + 3 < n; i++) if (ym(d, i).m === next[0] && i < n - 12) sums.push(rec.joined[i] + rec.joined[i + 1] + rec.joined[i + 2]);
  sums.sort((a, b) => a - b);
  $("outlook").innerHTML = sums.length ? w.outlook(sums.length, w.months[next[0]], w.months[next[2]], fmt(quantile(sums, 0.5)), fmt(quantile(sums, 0.25)), fmt(quantile(sums, 0.75))) : "";
}
const ordinal = n => n === 1 ? "" : n + (n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : n % 10 === 1 && n % 100 !== 11 ? "st" : "th");

// ---------- the 25-year trace with its sensor tape ----------
function drawStrip(d, rec) {
  const box = $("strip"), W = Math.max(300, box.clientWidth), H = 250, pad = { l: 8, r: 8, t: 22, b: 0 }, plotH = 128, n = rec.joined.length;
  const counted = state.strip === "counted", viirs = rec.snpp.map((v, i) => v ?? rec.n20[i]);
  const x = i => pad.l + i / (n - 1) * (W - pad.l - pad.r);
  const top = niceUp(Math.max(...rec.joined, ...(counted ? viirs.filter(v => v !== null) : []), 1)), y = v => pad.t + plotH - Math.min(v, top) / top * plotH;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": counted ? `MODIS and VIIRS fire detections per month in ${d.name}, as each sensor counted them.` : `Joined monthly fire detections in ${d.name}, ${label(d, 0)} to ${label(d, n - 1)}. The table under the calendar holds every value.` });
  for (const t of [0.5, 1]) svg.append(s("line", { x1: pad.l, x2: W - pad.r, y1: y(top * t), y2: y(top * t), stroke: "var(--rule)", "stroke-width": 1 }), s("text", { x: pad.l + 2, y: y(top * t) - 3, class: "tick" }, fmt(top * t)));
  const line = (vals, attrs) => {
    const parts = []; let cur = [];
    vals.forEach((v, i) => { if (v === null) { if (cur.length) parts.push(cur); cur = []; } else cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`); });
    if (cur.length) parts.push(cur);
    for (const p of parts) svg.append(s("polyline", { points: p.join(" "), fill: "none", "stroke-linejoin": "round", ...attrs }));
  };
  if (counted) {
    line(rec.modis, { stroke: "var(--modis)", "stroke-width": 1.25 });
    line(viirs, { stroke: "var(--viirs)", "stroke-width": 1.25 });
  } else {
    const est = [...d.src].map((c, i) => i).filter(i => estimated(d, i));
    if (est.length) svg.append(s("path", { d: "M" + est.map(i => `${x(i).toFixed(1)},${y(rec.hi[i]).toFixed(1)}`).join("L") + "L" + est.reverse().map(i => `${x(i).toFixed(1)},${y(rec.lo[i]).toFixed(1)}`).join("L") + "Z", fill: "var(--ink)", opacity: 0.13 }));
    svg.append(s("polyline", { points: rec.joined.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" "), fill: "none", stroke: "var(--ink)", "stroke-width": 1.25, "stroke-linejoin": "round", pathLength: 1, class: state.drawIn ? "trace draw" : "trace" }));
    state.drawIn = false;
  }
  svg.append(s("line", { x1: pad.l, x2: W - pad.r, y1: y(0), y2: y(0), stroke: "var(--ink)", "stroke-width": 1 }));
  const first = +d.first.slice(0, 4);
  for (let yr = Math.ceil((first + 1) / 5) * 5; yr <= ym(d, n - 1).y; yr += 5) {
    const i = (yr - first) * 12 - (+d.first.slice(5) - 1);
    svg.append(s("line", { x1: x(i), x2: x(i), y1: y(0), y2: y(0) + 4, stroke: "var(--ink)" }), s("text", { x: x(i), y: y(0) + 15, "text-anchor": "middle" }, yr));
  }
  // the tape: one channel per sensor, thick where that sensor writes the record
  const firstOf = c => d.src.indexOf(c), lastOf = c => d.src.lastIndexOf(c);
  const channels = [
    ["MODIS (Terra, Aqua from 2002)", "var(--modis)", 0, rec.modis.findLastIndex(v => v !== null), 0, Math.max(lastOf("m"), lastOf("t"))],
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
  const cross = s("line", { class: "cross", y1: pad.t, y2: pad.t + plotH, stroke: "var(--pen)", "stroke-width": 1, visibility: "hidden" });
  const hit = s("rect", { x: 0, y: 0, width: W, height: pad.t + plotH + 20, fill: "transparent" });
  const move = e => {
    const r = svg.getBoundingClientRect(), i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width * W - pad.l) / (W - pad.l - pad.r) * (n - 1))));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
    const html = counted ? `<b>${label(d, i)}</b>MODIS ${rec.modis[i] === null ? "–" : fmt(rec.modis[i])}, VIIRS ${viirs[i] === null ? "–" : fmt(viirs[i])}<br><small>as each sensor counted, not joined</small>` : monthTip(d, rec, i);
    tip({ left: e.clientX, right: e.clientX, top: r.top + pad.t, bottom: r.top + pad.t + 40, width: 0 }, html);
  };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerdown", move);
  hit.addEventListener("pointerleave", mouseOnly(hideTips));
  svg.append(cross, hit);
  box.replaceChildren(svg);
  const b = d.test.band.busy;
  $("strip-note").textContent = counted ? words().stripCounted(d.factor.all.toFixed(1)) : words().stripJoined(Math.round((1 - b[0]) * 100), Math.round((b[1] - 1) * 100));
}

// ---------- the seam: one fire, both sensors, the same afternoon ----------
async function drawSeam(d) {
  const box = $("seam");
  let seam;
  try { seam = await getJSON(`data/${d.id}.seam.json`); } catch { box.replaceChildren(); $("seam-note").textContent = ""; return; }
  if (state.d !== d) return;
  const all = [...seam.modis, ...seam.viirs], lat0 = median(all.map(p => p[0])), lon0 = median(all.map(p => p[1])), kx = 111.32 * Math.cos(lat0 * Math.PI / 180), ky = 110.57;
  const rects = list => list.map(([la, lo, sc, tr]) => ({ x: (lo - lon0) * kx - sc / 2, y: -(la - lat0) * ky - tr / 2, w: sc, h: tr }));
  const M = rects(seam.modis), V = rects(seam.viirs), every = [...M, ...V];
  const x0 = Math.min(...every.map(r => r.x)) - 1, x1 = Math.max(...every.map(r => r.x + r.w)) + 1, y0 = Math.min(...every.map(r => r.y)) - 1, y1 = Math.max(...every.map(r => r.y + r.h)) + 1;
  const span = Math.max(x1 - x0, y1 - y0), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, P = 220;
  const panel = (list, color, title, size, count) => {
    const svg = s("svg", { viewBox: `0 0 ${P} ${P}`, "aria-hidden": "true" });
    const sc = P / span, tx = v => (v - cx) * sc + P / 2, ty = v => (v - cy) * sc + P / 2;
    svg.append(s("rect", { x: 0, y: 0, width: P, height: P, fill: "#1b2330", rx: 4 }));
    for (const r of list) svg.append(s("rect", { x: tx(r.x), y: ty(r.y), width: r.w * sc, height: r.h * sc, fill: color, "fill-opacity": 0.55, stroke: color, "stroke-width": 0.8 }));
    const bar = nice(span / 4);
    svg.append(s("line", { x1: 10, x2: 10 + bar * sc, y1: P - 10, y2: P - 10, stroke: "#fff", "stroke-width": 2 }), s("text", { x: 10, y: P - 15, fill: "#fff", class: "on-dark" }, `${bar} km`));
    return h("figure", {}, svg, h("figcaption", {}, h("b", { text: title }), `${count} fire pixels, ${size} each`));
  };
  const date = new Date(seam.date + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const gap = Math.abs((+seam.modis_time.slice(0, 2) * 60 + +seam.modis_time.slice(2)) - (+seam.viirs_time.slice(0, 2) * 60 + +seam.viirs_time.slice(2)));
  box.replaceChildren(panel(M, "#5aa2ff", "MODIS on Aqua", "about 1 km", M.length), panel(V, "#ff8a4c", "VIIRS on Suomi NPP", "about 375 m", V.length));
  $("seam-note").textContent = words().seam(placeName(d), date, gap, (V.length / M.length).toFixed(1));
}

// ---------- burning calendar, its legend and its table ----------
function drawCalendar(d, rec) {
  const view = state.view, n = rec.joined.length, values = rec.joined.map((_, i) => shown(d, rec, view, i));
  const br = breaks(values.filter(v => v !== null)), colors = view === "modis" ? BLUE : FIRE;
  const cal = $("calendar"), cells = [h("span"), ...MONTHS.map(m => h("span", { class: "head", text: m[0], title: m }))];
  const table = $("table").closest("details").open, rows = [h("tr", {}, h("th", { text: "Year" }), ...MONTHS.map(m => h("th", { text: m })))];   // the table is built only when its fold is open
  const first = ym(d, 0), last = ym(d, n - 1);
  for (let yr = first.y; yr <= last.y; yr++) {
    cells.push(h("span", { class: "year", text: yr }));
    const tr = table && h("tr", {}, h("th", { text: yr }));
    for (let m = 0; m < 12; m++) {
      const i = (yr - first.y) * 12 + m - first.m, v = i >= 0 && i < n ? values[i] : null, est = v !== null && view === "joined" && estimated(d, i);
      const b = h("button", { type: "button", tabindex: -1, class: v === null ? "none" : est ? "est" : "", "aria-label": v === null ? `${MONTHS[m]} ${yr}: no data` : `${MONTHS[m]} ${yr}: ${fmt(v)} detections${est ? ", estimated from MODIS" : ""}` });
      if (v) b.style.background = ramp(classOf(v, br), br, colors);
      if (i >= 0 && i < n) b.dataset.i = i;
      cells.push(b);
      if (table) tr.append(h("td", { class: est ? "est" : "", text: v === null ? "–" : fmt(v) }));
    }
    if (table) rows.push(tr);
  }
  cal.replaceChildren(...cells);
  cal.querySelector("button[data-i]").tabIndex = 0;
  if (table) $("table").replaceChildren(...rows);
  const w = words();
  $("calendar-note").textContent = view === "joined" ? w.calJoined : view === "modis" ? w.calModis(d.factor.all.toFixed(0)) : w.calViirs;
  const key = (cls, text) => h("span", { class: "key" }, h("i", { class: cls }), text);
  const legend = [h("span", { class: "ramp" }, "1", ...br.map((_, k) => h("i", { style: `background:${ramp(k, br, colors)}`, title: `up to ${fmt(br[k])}` })), h("i", { style: `background:${ramp(br.length, br, colors)}`, title: `more than ${fmt(br[br.length - 1])}` }), w.perMonth(fmt(br[br.length - 1])))];
  if (view === "joined") legend.push(key("est", w.estMODIS));
  legend.push(key("none", w.noData));
  $("legend").replaceChildren(...legend);
}
function calendarEvents() {
  const cal = $("calendar"), cell = e => e.target.closest("button[data-i]");
  const show = e => { const b = cell(e); b ? tip(b, monthTip(state.d, state.rec, +b.dataset.i, state.view)) : tip(); };
  cal.addEventListener("pointerover", show);
  cal.addEventListener("focusin", show);
  cal.addEventListener("pointerleave", mouseOnly(() => tip()));
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
  const top = niceUp(Math.max(1, ...items.map(it => Math.max(it.v, it.hi ?? 0)))), step = (W - pad.l - pad.r) / items.length, bw = Math.max(2, Math.min(22, step - 2));
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
    if (it === best) svg.append(s("text", { x: cx, y: y(Math.max(it.v, it.hi ?? 0)) - 5, "text-anchor": cx < W * 0.2 ? "start" : cx > W * 0.8 ? "end" : "middle", class: "label tick" }, `${it.long ?? it.name}: ${fmt(it.v)}`));
    g.addEventListener("pointerenter", () => tip(g, it.tip));
    g.addEventListener("focus", () => tip(g, it.tip));
    g.addEventListener("pointerleave", mouseOnly(() => tip()));
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
    return { name: MONTHS[m][0], long: MONTHS[m], v, lo, hi, color: "var(--fire-5)", tip: `<b>${fmt(v)} detections</b>${FULL[m]}, middle year<br><small>middle half of years: ${fmt(lo)} to ${fmt(hi)}</small>` };
  }), {});
}
function drawYears(d, rec) {
  const years = {}, err = d.test.monthly.year_err_max / 100;
  rec.joined.forEach((v, i) => { const y = ym(d, i).y, o = (years[y] ??= { v: 0, n: 0, est: 0 }); o.v += v; o.n++; o.est += estimated(d, i); });
  const full = Object.entries(years).filter(([, o]) => o.n === 12);
  const items = full.map(([y, o]) => {
    const est = o.est > 6;   // 2012 has one MODIS month (January) and eleven VIIRS months
    return {
      name: y, v: o.v, color: est ? "var(--fire-3)" : "var(--fire-5)", ...(est ? { lo: o.v * (1 - err), hi: o.v * (1 + err) } : {}),
      tip: `<b>${fmt(o.v)} detections</b>${y}<br><small>${est ? `estimated from MODIS; in the test a hidden year was off by up to ${d.test.monthly.year_err_max}%` : o.est ? `measured by VIIRS, except ${o.est} month estimated from MODIS` : "measured by VIIRS"}</small>`,
    };
  });
  const key = (color, text) => h("span", { class: "key" }, h("i", { style: `background:${color}` }), text);
  bars($("years"), items, { labelEvery: 5, legend: h("div", { class: "legend", style: "margin:0;padding:0.4rem 0.5rem" }, key("var(--fire-3)", words().estMODIS), key("var(--fire-5)", words().byVIIRS)) });
  // the check a scientist asks for: is the worst year only an artefact of the scaling? Terra flew 2001 to 2021 alone and unchanged.
  const worst = items.reduce((a, b) => (b.v > a.v ? b : a)), note = $("years-check");
  const w = words();
  if (worst.color !== "var(--fire-3)") { note.textContent = w.worstMeasured(worst.name); return; }
  if (state.area) { note.textContent = w.worstArea(worst.name); return; }
  const terra = byYear(d, d.terra);
  const totals = Object.entries(terra).filter(([y, a]) => y >= 2001 && y <= 2021 && a.every(v => v !== null)).map(([y, a]) => [+y, a.reduce((p, q) => p + q, 0)]).sort((a, b) => b[1] - a[1]);
  const rank = totals.findIndex(([y]) => y === +worst.name) + 1;
  note.textContent = w.worstCheck(worst.name, rank === 1 ? w.rank1 : rank <= 3 ? w.rankTop(rank, totals.length) : w.rankLow(rank, totals.length));
}

// ---------- the map: a globe drawn on the graphics chip ----------
let mapLib;
function loadMapLib() {     // MapLibre is 1 MB, so it loads only when the map is near the screen
  return mapLib ??= new Promise((resolve, reject) => {
    document.head.append(h("link", { rel: "stylesheet", href: MAPLIBRE + "maplibre-gl.min.css", integrity: "sha512-KIMsMWIdnoG9OwZa+oaIafmbDonqck1UCmq+/zcUi2aaZ97N9QE6TqpTM+n36EO40HGh64hU/375zxtjx7WTyQ==", crossorigin: "anonymous", referrerpolicy: "no-referrer" }));
    const sc = h("script", { src: MAPLIBRE + "maplibre-gl.min.js", integrity: "sha512-Ktl9Zvfa9ZNMY92eXRPU5/bEglvxKBLdiVPIyBJ5ubyCkggk64Kdl7AhiDc00p70+OxDzbj5TryToLw82/yb+A==", crossorigin: "anonymous", referrerpolicy: "no-referrer" });
    sc.onload = () => resolve(window.maplibregl);
    sc.onerror = reject;
    document.head.append(sc);
  });
}
const AGES = [[7, "#fff6b4", "last 7 days of data"], [30, "#ffc43c", "8 to 30 days before"], [91, "#ff781e", "1 to 3 months before"], [Infinity, "#dc2d19", "earlier in the year"]];
const empty = { type: "FeatureCollection", features: [] };
async function makeMap() {
  const gl = await loadMapLib();
  const map = new gl.Map({
    container: "map",
    style: {
      version: 8,
      projection: { type: "globe" },
      sky: { "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 7, 0] },
      sources: {
        sat: { type: "raster", tiles: [EOX + "s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg"], tileSize: 256, maxzoom: 15, attribution: '<a href="https://s2maps.eu">Sentinel-2 cloudless 2020</a> by EOX' },
        names: { type: "raster", tiles: [EOX + "overlay_bright_3857/default/g/{z}/{y}/{x}.png"], tileSize: 256, maxzoom: 15, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
        countries: { type: "geojson", data: "data/countries.json", attribution: "Natural Earth" },
        fires: { type: "geojson", data: empty, attribution: '<a href="https://firms.modaps.eosdis.nasa.gov/">NASA FIRMS</a>' },
        cells: { type: "geojson", data: empty },
        area: { type: "geojson", data: empty },
        outline: { type: "geojson", data: empty },
      },
      layers: [
        { id: "sat", type: "raster", source: "sat" },
        { id: "cells", type: "fill", source: "cells", paint: { "fill-color": ["get", "c"], "fill-opacity": ["get", "o"] } },
        { id: "heat", type: "heatmap", source: "fires", maxzoom: 6.5, paint: {   // the globe and continents: a glow, never a blob
          "heatmap-weight": 1,
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 0.15, 6, 0.5],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 1.5, 4, 3, 6, 5],
          "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(220,45,25,0)", 0.15, "rgba(220,45,25,0.55)", 0.4, "#ff781e", 0.7, "#ffc43c", 1, "#fff6b4"],
          "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0.95, 6, 0] } },
        { id: "dots", type: "circle", source: "fires", minzoom: 4, paint: {   // a country and closer: every fire spot
          "circle-radius": ["interpolate", ["exponential", 2], ["zoom"], 4, 0.8, 7, 1.2, 10, 1.8, 16, 80],   // about one VIIRS pixel (375 m) once zoomed in
          "circle-color": ["step", ["get", "age"], AGES[0][1], 7, AGES[1][1], 30, AGES[2][1], 91, AGES[3][1]],
          "circle-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0, 5.5, 0.9] } },
        { id: "borders", type: "line", source: "countries", paint: {
          "line-color": ["case", ["==", ["get", "has"], 1], "#ffd27a", "rgba(255,255,255,0.35)"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 1, ["case", ["==", ["get", "has"], 1], 1.2, 0.4], 6, ["case", ["==", ["get", "has"], 1], 2, 0.8]],
          "line-opacity": ["interpolate", ["linear"], ["zoom"], 5, 1, 9, 0.3] } },
        { id: "countries", type: "fill", source: "countries", filter: ["==", ["get", "has"], 1], paint: { "fill-color": "#ffd27a", "fill-opacity": ["interpolate", ["linear"], ["zoom"], 1, 0.4, 3, 0.25, 4.5, 0.04, 6, 0] } },
        { id: "selected", type: "line", source: "outline", paint: { "line-color": "#ffd27a", "line-width": ["interpolate", ["linear"], ["zoom"], 1, 1.5, 6, 2.5, 12, 3.5], "line-opacity": ["interpolate", ["linear"], ["zoom"], 6, 1, 10, 0.5] } },
        { id: "area", type: "line", source: "area", paint: { "line-color": "#fbfcf8", "line-width": 2, "line-dasharray": [3, 2] } },
        { id: "names", type: "raster", source: "names" },
      ],
    },
    center: [80.7, 7.8], zoom: 1.4, maxZoom: 16, attributionControl: { compact: true },
    canvasContextAttributes: { preserveDrawingBuffer: true }, preserveDrawingBuffer: true,   // so the map can be saved as a picture
  });
  state.map = map;
  map.addControl(new gl.NavigationControl({ visualizePitch: false }), "top-right");
  if (gl.GlobeControl) map.addControl(new gl.GlobeControl(), "top-right");
  map.addControl({
    onAdd() {
      const b = this.b = h("button", { type: "button", class: "map-full-button", "aria-pressed": "false", text: "Full screen" });
      b.addEventListener("click", () => toggleFull(b));
      return h("div", { class: "maplibregl-ctrl" }, b);
    },
    onRemove() {},
  }, "top-left");
  addEventListener("keydown", e => { if (e.key === "Escape" && document.body.classList.contains("map-open")) toggleFull(document.querySelector(".map-full-button")); });
  map.on("click", e => onMapClick(gl, e));
  map.on("mousemove", e => { map.getCanvas().style.cursor = hitAt(e.point) ? "pointer" : ""; });
  map.on("moveend", () => { if (state.mapReady) writeHash(); });
  const hint = h("p", { class: "map-hint", "data-t": "hint", "data-en": T.en.hint, text: words().hint });
  map.getContainer().append(hint);
  const showHint = () => hint.classList.toggle("on", map.getZoom() < 3.2);   // only on the globe view, where countries are small
  map.on("zoom", showHint);
  map.once("idle", showHint);
  await new Promise(r => map.once("load", r));
  $("map-wait")?.remove();
  map.getContainer().querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");   // credits fold to an (i) until tapped
  state.mapReady = true;
}
function hitAt(point, layers = ["dots", "cells", "countries"]) {
  const map = state.map, live = layers.filter(l => map.getLayer(l) && map.getLayoutProperty(l, "visibility") !== "none");
  const f = map.queryRenderedFeatures([[point.x - 10, point.y - 10], [point.x + 10, point.y + 10]], { layers: live });
  return f.find(x => x.layer.id === "dots") || f.find(x => x.layer.id === "cells") || f.find(x => x.layer.id === "countries");
}
function onMapClick(gl, e) {
  const f = hitAt(e.point);
  if (!f) return;
  const p = f.properties;
  if (f.layer.id === "countries") {
    if (p.id !== state.d.id) { $("place").value = p.id; load(p.id, { fly: true }); }
    else state.map.fitBounds(countryBounds(state.d), { padding: 24, duration: calm() ? 0 : 1200 });
    return;
  }
  const html = f.layer.id === "dots"
    ? `<b>Fire seen ${dayLabel(state.fires.year, p.day)}</b><br>${p.n === 1 ? "1 detection" : `${p.n} detections`} at this spot this year, by NOAA-20 VIIRS<br>${f.geometry.coordinates[1].toFixed(3)}°, ${f.geometry.coordinates[0].toFixed(3)}°`
    : p.html;
  new gl.Popup({ maxWidth: "260px" }).setLngLat(e.lngLat).setHTML(html).addTo(state.map);
}
function toggleFull(button) {
  const open = document.body.classList.toggle("map-open");
  $("map").classList.toggle("full", open);
  button.textContent = open ? "Close full screen" : "Full screen";
  button.setAttribute("aria-pressed", String(open));
  state.map.resize();
}
const dayLabel = (year, day) => new Date(Date.UTC(year, 0, day)).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

const countryBounds = d => d.bounds;   // 98% of the country's fire (pipeline: fire_bounds)
async function withMap(d) {   // the map squares and layers: a separate file, so the first screen loads without them
  if (!d.grid) Object.assign(d, await getJSON(`data/${d.id}.map.json`));
  return d;
}
async function drawMap(d, { fly = false, view = null } = {}) {
  if (!state.mapReady) return;
  const map = state.map;
  map.setFilter("borders", ["!=", ["get", "id"], d.id]);   // the open country gets its detailed outline instead
  map.getSource("outline").setData(empty);
  getJSON(`data/${d.id}.outline.json`).then(o => { if (state.d === d) map.getSource("outline").setData(o); }).catch(() => map.setFilter("borders", null));
  if (view) map.jumpTo(view);
  else map.fitBounds(countryBounds(d), { padding: 24, duration: fly && !calm() ? 2200 : 0, essential: false });
  $("map-note").textContent = words().mapLoading;
  try {
    await withMap(d);
    if (state.d !== d) return;
    drawCells();
    const fires = state.fires && state.fires.id === d.id ? state.fires : await getJSON(`data/${d.id}.fires.json`);
    if (state.d !== d) return;   // the place changed while the file loaded
    fires.id = d.id;
    const [y, m] = fires.to.split("-").map(Number);
    fires.last = Math.round((Date.UTC(y, m, 0) - Date.UTC(y, 0, 0)) / 864e5);   // ages count back from the last day of the data, not from today
    state.fires = fires;
    const features = [];
    for (let k = 0; k < fires.pts.length; k += 4) features.push({ type: "Feature", properties: { day: fires.pts[k + 2], n: fires.pts[k + 3], age: fires.last - fires.pts[k + 2] }, geometry: { type: "Point", coordinates: [fires.pts[k + 1] / fires.scale, fires.pts[k] / fires.scale] } });
    features.sort((a, b) => b.properties.age - a.properties.age);   // oldest first, so the newest are drawn on top
    map.getSource("fires").setData({ type: "FeatureCollection", features });
    drawFires();
  } catch { $("map-note").textContent = words().mapError; }
}
function fireFilter() { return ["<", ["get", "age"], +state.when]; }
function drawFires() {
  const d = state.d, fires = state.fires, map = state.map;
  if (!fires || !state.mapReady) return;
  map.setFilter("heat", fireFilter()); map.setFilter("dots", fireFilter());
  if (state.layer !== "fires") return;
  let shown = 0;
  for (let k = 2; k < fires.pts.length; k += 4) if (fires.last - fires.pts[k] < +state.when) shown++;
  state.shown = shown;
  const until = dayLabel(fires.year, fires.last);
  const w = words();
  $("map-note").textContent = w.mapFires(fmt(shown), placeName(d), state.when === "366" ? fires.year : null, w.periods[state.when], until, Math.round(111320 / fires.scale), d.provisional_from ? w.months[+d.provisional_from.slice(5) - 1] : "");
  $("map-key").replaceChildren(...AGES.map(([, color], i) => [color, w.ages[i], i]).filter(([, , i]) => i === 0 || AGES[i - 1][0] < +state.when).map(([color, text]) => h("span", { class: "key" }, h("i", { class: "dot", style: `background:${color}` }), text)));
}
function square(x0, y0, size) { return { type: "Polygon", coordinates: [[[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size], [x0, y0]]] }; }
function drawCells() {        // "when it burns" and "unusual now": the country's own map squares, coloured
  const d = state.d, map = state.map, layer = state.layer;
  if (!state.mapReady || !d.grid) return;   // drawMap calls again once the map file is in
  for (const l of ["heat", "dots"]) map.setLayoutProperty(l, "visibility", layer === "fires" ? "visible" : "none");
  map.setLayoutProperty("cells", "visibility", layer === "fires" ? "none" : "visible");
  $("when").hidden = layer !== "fires";
  if (layer === "fires") { map.getSource("cells").setData(empty); drawFires(); return; }
  const features = [];
  if (layer === "burn") {   // each 0.2-degree square, coloured by the calendar month it burns most (pipeline: map_layers)
    const c = d.burn_deg, totals = d.burn.map(([, , ...by]) => by.reduce((a, b) => a + b, 0)), top = Math.log1p(quantile([...totals].sort((a, b) => a - b), 0.99));
    d.burn.forEach(([x, y, ...by], k) => {
      const t = totals[k], peak = by.indexOf(Math.max(...by)), share = Math.round(by[peak] / t * 100);
      features.push({ type: "Feature", geometry: square(x * c, y * c, c), properties: { c: MONTH_COLORS[peak], o: Math.min(0.9, 0.15 + 0.75 * Math.log1p(t) / top), html: `<b>Burns most in ${FULL[peak]}</b>${share}% of this square's fire since 2000 came in ${FULL[peak]}.<br>About ${fmt(t / 26)} detections a year.` } });
    });
    const w = words();
    $("map-note").textContent = w.mapBurn(Math.round(c * 111));
    $("map-key").replaceChildren(h("span", { class: "wheel" }, ...MONTHS.map((mo, m) => h("span", { class: "key" }, h("i", { style: `background:${MONTH_COLORS[m]}` }), state.lang === "en" ? mo : w.months[m]))));
  } else {                  // each 0.5-degree square: the newest month against the same month in earlier years
    const c = d.same_deg, { y, m } = ym(d, d.same_month);
    for (const [x, yy, ...vals] of d.same) {
      const now = vals[vals.length - 1], past = vals.slice(0, -1), mid = median(past);
      if (Math.max(now, mid) < 3) continue;   // too few fires either way to call anything unusual
      const cls = verdict(now, past);
      features.push({ type: "Feature", geometry: square(x * c, yy * c, c), properties: { c: UNUSUAL[cls][1], o: cls === 2 ? 0.35 : 0.8, html: `<b>${FULL[m]} ${y}: ${UNUSUAL[cls][0]}</b>${fmt(now)} detections here; the middle ${FULL[m]} of the ${past.length} years before had ${fmt(mid)}.` } });
    }
    const w = words();
    $("map-note").textContent = w.mapUnusual(Math.round(c * 111), w.months[m], y, provisional(d, d.same_month));
    $("map-key").replaceChildren(...UNUSUAL.map(([, color], i) => h("span", { class: "key" }, h("i", { style: `background:${color}` }), w.verdicts[i])));
  }
  state.cells = features.length;
  map.getSource("cells").setData({ type: "FeatureCollection", features });
}

function downloadFires() {
  const d = state.d, fires = state.fires;
  if (!fires) return;
  const lines = ["latitude,longitude,last_seen,detections_this_year"];
  for (let k = 0; k < fires.pts.length; k += 4) {
    const day = fires.pts[k + 2];
    if (fires.last - day >= +state.when) continue;
    lines.push([(fires.pts[k] / fires.scale).toFixed(4), (fires.pts[k + 1] / fires.scale).toFixed(4), new Date(Date.UTC(fires.year, 0, day)).toISOString().slice(0, 10), fires.pts[k + 3]].join(","));
  }
  save(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }), `${d.id}-fires-${fires.year}.csv`);
}
function saveMap() {          // the map canvas with a caption strip
  if (!state.mapReady) return;
  const src = state.map.getCanvas(), out = document.createElement("canvas"), g = out.getContext("2d"), bar = 26 * (src.width / src.clientWidth);
  out.width = src.width; out.height = src.height + bar;
  g.drawImage(src, 0, 0);
  g.fillStyle = "#14181f"; g.fillRect(0, src.height, out.width, bar);
  g.fillStyle = "#fff"; g.font = `${Math.round(bar * 0.48)}px system-ui, sans-serif`;
  g.fillText(`${state.d.name}: NASA FIRMS fire data, One Fire Record. Map: Sentinel-2 cloudless by EOX, OpenStreetMap.`, bar * 0.4, src.height + bar * 0.68);
  out.toBlob(b => b && save(b, `${state.d.id}-fire-map.png`), "image/png");
}
function save(blob, name) {
  const a = h("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function setArea(area, { scroll = true } = {}) {
  if (area) await withMap(state.d);
  state.area = area;
  state.drawIn = true;
  state.map?.getSource("area")?.setData(area ? { type: "Feature", geometry: { type: "LineString", coordinates: [[area.w, area.s], [area.e, area.s], [area.e, area.n], [area.w, area.n], [area.w, area.s]] } } : empty);
  $("clear-view").hidden = !area;
  render();
  writeHash();
  if (area && scroll) $("answer").scrollIntoView({ behavior: calm() ? "auto" : "smooth", block: "center" });
}

// ---------- the link holds what you see, so it can be sent on ----------
function writeHash() {
  if (!state.d) return;
  const p = new URLSearchParams();
  if (state.area) p.set("area", [state.area.w, state.area.s, state.area.e, state.area.n].map(v => v.toFixed(3)).join(","));
  if (state.layer !== "fires") p.set("layer", state.layer);
  if (state.when !== "366") p.set("fires", state.when);
  if (state.view !== "joined") p.set("cal", state.view);
  if (state.strip !== "joined") p.set("trace", state.strip);
  if (state.lang !== "en") p.set("lang", state.lang);
  if (state.mapReady && state.mapMoved) { const c = state.map.getCenter(); p.set("map", [c.lat.toFixed(3), c.lng.toFixed(3), state.map.getZoom().toFixed(2)].join(",")); }
  const q = p.toString();   // not p.size: Safari before iOS 17 has no size, and the link would lose its settings
  history.replaceState(null, "", `#${state.d.id}${q ? "&" + q : ""}`);
}
function readHash() {
  let raw = location.hash.slice(1);
  try { raw = decodeURIComponent(raw); } catch { /* a cut link with a stray %: read it as it is */ }
  const [id, ...rest] = raw.split("&"), p = new URLSearchParams(rest.join("&")), out = { id };
  const nums = k => (p.get(k) || "").split(",").map(Number);
  if (p.has("area")) { const [w, s, e, n] = nums("area"); if ([w, s, e, n].every(Number.isFinite) && w < e && s < n) out.area = { w, s, e, n }; }
  if (["burn", "unusual"].includes(p.get("layer"))) out.layer = p.get("layer");
  if (["30", "91"].includes(p.get("fires"))) out.when = p.get("fires");
  if (["modis", "viirs"].includes(p.get("cal"))) out.view = p.get("cal");
  if (p.get("trace") === "counted") out.strip = "counted";
  if (["si", "ta"].includes(p.get("lang"))) out.lang = p.get("lang");
  if (p.has("map")) { const [lat, lng, zoom] = nums("map"); if ([lat, lng, zoom].every(Number.isFinite)) out.map = { center: [lng, lat], zoom }; }
  return out;
}
const setRadio = (name, value) => { const r = document.querySelector(`input[name="${name}"][value="${value}"]`); if (r) r.checked = true; };

// ---------- method ----------
function drawMethod(d) {
  const f = d.factor, t = d.test, pct = v => (v > 0 ? "+" : "") + v + "%";
  const drift = Object.entries(d.drift), list = key => drift.map(([y, o]) => `${pct(o[key])} in ${y}`).join(", ");
  const name = h("span", { text: d.name }).innerHTML, spot = d.spot || 300;
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
      <li>A month before 2012 is an estimate. In a busy month the real value was usually within ${Math.round((1 - t.band.busy[0]) * 100)}% below to ${Math.round((t.band.busy[1] - 1) * 100)}% above it; in a quiet month (under 10 MODIS detections) the range is much wider, ${t.band.thin[0]}× to ${t.band.thin[1]}×.</li>
      <li>Before July 2002 only Terra was flying. Those months use a Terra-only factor and are the weakest part of the record: in a busy month the real value fell between ${t.band_terra.busy[0]}× and ${t.band_terra.busy[1]}× the estimate in 8 of 10 tests.</li>
      <li>Since 2022 the Terra and Aqua orbits have drifted. With the factors learned before the drift, MODIS misses the real VIIRS total by ${list("modis")}. Terra alone: ${list("terra")}. MODIS should not be used alone for trends any more.</li>
      <li>A detection is not a fire and not a burned area. One fire can give many detections, and clouds and smoke hide fires from both sensors.</li>
      <li>Suomi NPP had gaps in June to August 2026 and stopped on 2 November 2026, so from January 2026 the record is NOAA-20, scaled by ${f.handover.toFixed(2)} (measured on 2019 to 2025).</li>
      <li>The factors are learned for the whole country. A small area uses the same factors, so its estimates are less certain.</li>
      <li>We found no other public tool that joins the two sensors into one fire calendar. That is not proof that none exists.</li>
    </ul>
    <h3>Sources</h3>
    <ul>
      <li><a href="https://firms.modaps.eosdis.nasa.gov/country/">NASA FIRMS yearly country files</a>, science-quality MODIS Collection 6.1 and VIIRS 375 m active fire detections. ${fmt(d.rows_read.modis + d.rows_read.snpp + d.rows_read.n20)} rows read for ${name}.</li>
      ${ym(d, d.joined.length - 1).y > 2025 ? `<li><a href="https://firms.modaps.eosdis.nasa.gov/api/area/">NASA FIRMS area API</a>, NOAA-20 VIIRS for ${ym(d, d.joined.length - 1).y}: science-quality where NASA has it${d.provisional_from ? `, near-real-time from ${FULL[+d.provisional_from.slice(5) - 1]} ${d.provisional_from.slice(0, 4)} (provisional)` : ""}. A detection counts for ${name} when it falls inside its <a href="https://www.naturalearthdata.com/">Natural Earth</a> border; on eight past months this matched NASA's own country files to within 1.4%.</li>` : ""}
      <li><a href="https://www.earthdata.nasa.gov/news/blog/transitioning-from-suomi-npp-viirs-omps-what-firms-users-need-know">NASA FIRMS, October 2026</a>: the end of Suomi NPP and the move to NOAA-20 and NOAA-21.</li>
      <li><a href="https://www.earthdata.nasa.gov/data/alerts-outages/transition-from-modis-viirs">NASA Earthdata, May 2025</a>: Terra and Aqua shut down from late 2026 and are drifting.</li>
      <li><a href="https://essd.copernicus.org/articles/18/7535/2026/">Chen et al. 2026</a>: region-specific scaling between VIIRS and MODIS fire records, the published method closest to ours.</li>
      <li><a href="https://doi.org/10.1016/j.rse.2016.02.054">Giglio et al. 2016</a> and <a href="https://doi.org/10.1016/j.rse.2013.12.008">Schroeder et al. 2014</a>: the MODIS and VIIRS fire algorithms.</li>
      <li>Map: the fire dots are this year's NOAA-20 detections, rounded to 1/${spot} degree (about ${Math.round(111320 / spot)} m, one VIIRS pixel). The area tool, "when it burns" and "unusual now" use our own ${d.coarse_deg.toFixed(d.coarse_deg < 1 ? 1 : 2)} degree squares.</li>
      <li>The seam picture: Aqua MODIS and Suomi NPP VIIRS detections of one day from the yearly country files, each drawn with NASA's scan and track size.</li>
    </ul>`;
}

// ---------- download ----------
function download() {
  const d = state.d, rec = state.rec;
  const lines = ["month,modis_detections,viirs_snpp_detections,viirs_noaa20_detections,joined_viirs_equivalent,likely_low,likely_high,source"];
  rec.joined.forEach((v, i) => {
    const { y, m } = ym(d, i);
    lines.push([`${y}-${String(m + 1).padStart(2, "0")}`, rec.modis[i], rec.snpp[i] ?? "", rec.n20[i] ?? "", v, rec.lo[i], rec.hi[i], `"${source(d, i)}"`].join(","));
  });
  save(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }), `one-fire-record-${d.id}${state.area ? "-area" : ""}.csv`);
}

// ---------- wiring ----------
async function getJSON(url) {       // "no-cache" asks the server if the file changed, so a rebuilt record is never shown stale
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}
function render() {
  const d = state.d, rec = state.rec = join(d, counts(d, state.area)), token = state.renderToken = {};
  drawAnswer(d, rec);
  drawPace(d, rec);
  // the charts further down, one short task each, so a slow phone never freezes while the first screen appears
  const rest = [drawStrip, drawCalendar, drawMonths, drawYears];
  const next = () => { if (state.renderToken === token && rest.length) { rest.shift()(d, rec); setTimeout(next, 0); } };
  setTimeout(next, 0);
}
async function load(id, { fly = false, area = null, view = null } = {}) {
  document.body.classList.add("busy");
  let d;
  try {
    const early = window.firstRecord?.id === id ? await window.firstRecord.data : null;   // started in the page head
    d = state.cache[id] ??= early || await getJSON(`data/${id}.json`);
  } catch {
    $("answer").textContent = "The fire record could not load.";
    $("answer-detail").textContent = "Check the connection, then pick the place again.";
    document.body.classList.remove("busy");
    return;
  }
  document.body.classList.remove("busy");
  state.d = d;
  state.drawIn = true;
  state.area = area;
  state.map?.getSource("area")?.setData(empty);
  $("clear-view").hidden = !area;
  $("feed").href = `feed/${id}.xml`;
  const check = join(d, counts(d, null)).joined;
  console.assert(check.every((v, i) => v === d.joined[i]), "page join differs from pipeline join");
  if (area) await setArea(area, { scroll: false }); else render();
  if ($("method-box").open) drawMethod(d); else $("method").replaceChildren();   // built when the fold opens
  drawSeam(d);
  state.mapMoved = !!view;
  await drawMap(d, { fly, view });
  writeHash();
}
async function start() {
  const places = (await window.firstRecord?.index) || await getJSON("data/index.json"), select = $("place"), want = readHash();
  select.replaceChildren(...places.map(p => h("option", { value: p.id, text: p.name })));
  select.value = places.some(p => p.id === want.id) ? want.id : places.some(p => p.id === "Sri_Lanka") ? "Sri_Lanka" : places[0].id;
  for (const k of ["layer", "when", "view", "strip", "lang"]) if (want[k]) state[k] = want[k];
  setRadio("layer", state.layer); setRadio("when", state.when); setRadio("view", state.view); setRadio("strip", state.strip); setRadio("lang", state.lang);
  applyLang();
  select.addEventListener("change", () => load(select.value, { fly: true }));
  addEventListener("hashchange", () => { if (places.some(p => p.id === readHash().id)) location.reload(); });   // a pasted link: reload so its area, layer and view all apply (the skip link #answer is not a place)
  $("view").addEventListener("change", e => { state.view = e.target.value; drawCalendar(state.d, state.rec); writeHash(); });
  $("strip-view").addEventListener("change", e => { state.strip = e.target.value; drawStrip(state.d, state.rec); writeHash(); });
  $("layer").addEventListener("change", e => { state.layer = e.target.value; drawCells(); writeHash(); });
  $("when").addEventListener("change", e => { state.when = e.target.value; drawFires(); writeHash(); });
  $("lang").addEventListener("change", e => { state.lang = e.target.value; applyLang(); render(); drawSeam(state.d); drawCells(); writeHash(); });
  $("use-view").addEventListener("click", () => {
    if (!state.mapReady) return;
    if (state.map.getZoom() < 4) { $("map-note").textContent = words().zoomIn; return; }
    const b = state.map.getBounds();
    setArea({ w: b.getWest(), e: b.getEast(), s: b.getSouth(), n: b.getNorth() });
  });
  $("clear-view").addEventListener("click", () => setArea(null));
  $("share").addEventListener("click", async () => {
    state.mapMoved = state.mapReady; writeHash();
    const url = location.href, b = $("share");
    try {
      if (navigator.share && matchMedia("(pointer: coarse)").matches) await navigator.share({ title: document.title, url });
      else { await navigator.clipboard.writeText(url); b.textContent = "Link copied"; setTimeout(() => applyLang(), 1800); }
    } catch { /* the user closed the share sheet */ }
  });
  $("download").addEventListener("click", download);
  $("download-fires").addEventListener("click", downloadFires);
  $("save-map").addEventListener("click", saveMap);
  calendarEvents();
  $("method-box").addEventListener("toggle", e => { if (e.target.open && !$("method").firstChild) drawMethod(state.d); });
  $("table").closest("details").addEventListener("toggle", e => { if (e.target.open) drawCalendar(state.d, state.rec); });
  addEventListener("pointerdown", e => { if (!e.target.closest("#calendar, svg")) hideTips(); });
  addEventListener("scroll", hideTips, { passive: true });
  let width = innerWidth;
  addEventListener("resize", () => { if (innerWidth !== width) { width = innerWidth; render(); } });
  await load(select.value, { area: want.area || null, view: want.map || null });
  // the globe loads when it comes near the screen, or at once when the link points at a map view
  const mapStart = () => makeMap().then(() => { state.map.on("dragstart", () => (state.mapMoved = true)); state.map.on("zoomstart", e => { if (e.originalEvent) state.mapMoved = true; }); return drawMap(state.d, { fly: !want.map && !calm(), view: want.map || null }); }).then(() => { if (state.area) setArea(state.area, { scroll: false }); })
    .catch(() => { $("map").replaceChildren(h("p", { class: "note map-wait", text: "The map could not load (it needs WebGL). The charts still cover the whole country." })); $("use-view").hidden = true; });
  if (want.map || want.layer) mapStart();
  else new IntersectionObserver((entries, io) => { if (entries.some(e => e.isIntersecting)) { io.disconnect(); mapStart(); } }, { rootMargin: "400px" }).observe($("map"));
}
start().catch(err => { $("answer").textContent = "The fire record could not be loaded."; $("answer-detail").textContent = String(err.message || err); });
