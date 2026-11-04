/* Clipper Network dashboard. Used by the live page (web/index.html) and by `clipper build`.
   ClipperDashboard.mount(element, data, options) draws everything inside `element`.
   data = { generated, demo, accounts: [...], daily: [[date, account, followers, views_lifetime,
   views_day, likes_total, status, note]], posts: [[account, id, published, title, url, thumb, views,
   likes, comments, shares, views_prev, prev_date, last_seen]] } */
(function () {
  "use strict";
  const MARKUP = `<div class="app" id="dashApp">
  <header class="top">
    <div class="brand">
      <h1>Clipper Network <span class="chip-sample" id="sampleChip" hidden>Sample data</span></h1>
      <p id="subline">Loading…</p>
    </div>
  </header>
  <div class="filters" id="filters" hidden>
    <div class="seg" role="group" aria-label="Date range" id="rangeSeg"></div>
    <div class="plats" role="group" aria-label="Platforms" id="platToggles"></div>
    <select class="group" id="groupSelect" aria-label="Group" hidden></select>
  </div>
  <main id="main" style="display:grid;gap:16px"></main>
  <footer id="footer"></footer>
</div>
<div id="sheetRoot"></div>`;
  let teardown = null;

  function mount(root, D, opts) {
    opts = opts || {};
    if (teardown) { teardown(); teardown = null; }
    root.innerHTML = MARKUP;
    const PLATS = [
      { id: "facebook", label: "Facebook" },
      { id: "tiktok", label: "TikTok" },
      { id: "instagram", label: "Instagram" },
      { id: "youtube", label: "YouTube" },
      { id: "x", label: "X" },
    ];
    const PLAT = Object.fromEntries(PLATS.map(p => [p.id, p]));
    const DARK_INK_FILL = { youtube: true }; // yellow fill takes near-black text
    const RANGES = [
      { id: "7", label: "7D", days: 7 }, { id: "30", label: "30D", days: 30 }, { id: "90", label: "90D", days: 90 },
      { id: "365", label: "1Y", days: 365 }, { id: "all", label: "All", days: Infinity },
    ];

    // ---------- helpers ----------
    const $ = id => document.getElementById(id);
    function h(tag, attrs, ...kids) {
      const el = document.createElement(tag);
      if (attrs) for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k === "style") el.setAttribute("style", v);
        else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? "" : v);
      }
      for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
      return el;
    }
    const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
    const fullFmt = new Intl.NumberFormat("en-US");
    const compact = v => v == null || isNaN(v) ? "–" : (Math.abs(v) < 10000 ? fullFmt.format(Math.round(v)) : compactFmt.format(v));
    const full = v => v == null || isNaN(v) ? "–" : fullFmt.format(Math.round(v));
    const signed = v => v == null ? "–" : (v > 0 ? "+" : v < 0 ? "−" : "") + compact(Math.abs(v));
    const pct = v => v == null || !isFinite(v) ? "–" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0) + "%";
    const toDate = s => new Date(s.slice(0, 10) + "T00:00:00Z");
    const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    const longFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    const fmtDay = s => dayFmt.format(toDate(s));
    const addDays = (s, n) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const color = p => css("--s-" + p);
    function alpha(hex, a) {
      const m = hex.replace("#", ""); const n = parseInt(m.length === 3 ? m.replace(/./g, c => c + c) : m, 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    }
    const initials = name => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
    function store(key, val) { try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch (e) { return null; } }
    function deltaEl(v, base, vsText) {
      const cls = v > 0 ? "up" : v < 0 ? "down" : "flat";
      const arrow = v > 0 ? "▲ " : v < 0 ? "▼ " : "";
      const rel = base ? " (" + pct(v / base) + ")" : "";
      return h("div", { class: "delta " + cls }, arrow + signed(v) + rel, vsText ? h("span", { class: "vs" }, " " + vsText) : null);
    }
    function avatarEl(a) {
      const box = h("div", { class: "avatar", "aria-hidden": "true" });
      if (a.avatar && !D.demo) {
        const img = h("img", { src: a.avatar, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
        img.onerror = () => { box.textContent = initials(a.name); };
        box.append(img);
      } else box.textContent = initials(a.name);
      return box;
    }

    // ---------- data model ----------
    const accounts = D.accounts;
    const byId = Object.fromEntries(accounts.map(a => [a.id, a]));
    const dates = [...new Set(D.daily.map(r => r[0]))].sort();
    const N = dates.length;
    const dIdx = Object.fromEntries(dates.map((d, i) => [d, i]));
    const series = {};
    for (const a of accounts) series[a.id] = { fol: new Array(N).fill(null), vl: new Array(N).fill(null), vd: new Array(N).fill(null), rows: new Array(N).fill(null) };
    for (const r of D.daily) {
      const s = series[r[1]]; if (!s) continue;
      const i = dIdx[r[0]];
      s.rows[i] = r; s.fol[i] = r[2]; s.vl[i] = r[3]; s.vd[i] = r[4];
    }
    for (const a of accounts) {
      const s = series[a.id];
      // Followers: carry the last known value across failed days so totals don't dip.
      s.f = s.fol.slice(); let last = null;
      for (let i = 0; i < N; i++) { if (s.f[i] == null) s.f[i] = last; else last = s.f[i]; }
      // Views per day: the platform's daily figure if given, otherwise growth in lifetime views.
      s.dv = new Array(N).fill(null); let prev = null;
      for (let i = 0; i < N; i++) {
        if (s.vd[i] != null) s.dv[i] = s.vd[i];
        else if (s.vl[i] != null && prev != null) s.dv[i] = Math.max(0, s.vl[i] - prev);
        if (s.vl[i] != null) prev = s.vl[i];
      }
      s.gain = s.f.map((v, i) => (i > 0 && v != null && s.f[i - 1] != null) ? v - s.f[i - 1] : null);
      let latest = null;
      for (let i = N - 1; i >= 0; i--) if (s.rows[i]) { latest = s.rows[i]; break; }
      s.latest = latest;
      s.latestOnLastDay = N && s.rows[N - 1];
    }
    const posts = D.posts.map(p => ({
      account: p[0], id: p[1], published: p[2], title: p[3], url: p[4], thumb: p[5], views: p[6], likes: p[7],
      comments: p[8], shares: p[9], viewsPrev: p[10], prevDate: p[11], lastSeen: p[12],
    })).filter(p => byId[p.account]);
    const groups = [...new Set(accounts.map(a => a.group).filter(Boolean))].sort();
    const platsPresent = PLATS.filter(p => accounts.some(a => a.platform === p.id));

    // ---------- state ----------
    const state = {
      range: store("clipper.range") || "30",
      plats: new Set(platsPresent.map(p => p.id)),
      group: "",
      sort: { key: "views", dir: -1 },
      clipTab: "top",
      clipLimit: 12,
    };
    if (!RANGES.some(r => r.id === state.range)) state.range = "30";

    function scope() {
      const r = RANGES.find(x => x.id === state.range);
      let start = 0;
      if (isFinite(r.days) && N) {
        const from = addDays(dates[N - 1], -(r.days - 1));
        start = dates.findIndex(d => d >= from); if (start < 0) start = 0;
      }
      const accts = accounts.filter(a => state.plats.has(a.platform) && (!state.group || a.group === state.group));
      const days = N ? Math.round((toDate(dates[N - 1]) - toDate(dates[start])) / 864e5) + 1 : 0;
      return { start, end: N - 1, accts, ids: new Set(accts.map(a => a.id)), days, from: dates[start], to: dates[N - 1] };
    }
    function sumRange(arr, a, b) { let t = 0, any = false; for (let i = Math.max(0, a); i <= b; i++) if (arr[i] != null) { t += arr[i]; any = true; } return any ? t : null; }
    function acctStats(a, sc) {
      const s = series[a.id];
      const end = s.f[sc.end];
      let base = sc.start > 0 ? s.f[sc.start - 1] : null;
      if (base == null) { for (let i = sc.start; i <= sc.end; i++) if (s.f[i] != null) { base = s.f[i]; break; } }
      const gained = end != null && base != null ? end - base : null;
      const views = sumRange(s.dv, sc.start, sc.end);
      const clips = posts.filter(p => p.account === a.id && p.published.slice(0, 10) >= sc.from);
      const clipViews = clips.map(p => p.views).filter(v => v != null);
      return {
        followers: end, gained, growth: base ? gained / base : null, views,
        clips: clips.length, avgViews: clipViews.length ? clipViews.reduce((x, y) => x + y, 0) / clipViews.length : null,
        status: s.latestOnLastDay ? s.latestOnLastDay[6] : (s.latest ? "error" : "skipped"),
        note: s.latestOnLastDay ? s.latestOnLastDay[7] : (s.latest ? "No update in the latest run." : "No data collected yet."),
        spark: s.f.slice(sc.start, sc.end + 1),
      };
    }
    function totalsByPlatform(key, sc) {
      const out = {};
      for (const p of platsPresent) out[p.id] = new Array(sc.end - sc.start + 1).fill(0);
      for (const a of sc.accts) {
        const arr = series[a.id][key];
        for (let i = sc.start; i <= sc.end; i++) if (arr[i] != null) out[a.platform][i - sc.start] += arr[i];
      }
      return out;
    }
    // Long ranges are grouped into weeks so bars stay readable.
    function bucket(labels, seriesMap) {
      if (labels.length <= 100) return { labels, seriesMap, unit: "day" };
      const k = 7, outL = [], outS = {};
      for (const key in seriesMap) outS[key] = [];
      for (let i = 0; i < labels.length; i += k) {
        outL.push(labels[i]);
        for (const key in seriesMap) outS[key].push(seriesMap[key].slice(i, i + k).reduce((x, y) => x + y, 0));
      }
      return { labels: outL, seriesMap: outS, unit: "week" };
    }

    // ---------- charts ----------
    const charts = [];
    function destroyCharts(list) { while (list.length) list.pop().destroy(); }
    const crosshair = {
      id: "crosshair",
      afterDatasetsDraw(chart) {
        const act = chart.tooltip && chart.tooltip.getActiveElements();
        if (!act || !act.length) return;
        const x = act[0].element.x, { top, bottom } = chart.chartArea, ctx = chart.ctx;
        ctx.save(); ctx.strokeStyle = css("--axis"); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, top); ctx.lineTo(Math.round(x) + 0.5, bottom); ctx.stroke(); ctx.restore();
      },
    };
    function baseOptions(unit) {
      return {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        layout: { padding: { top: 4 } },
        scales: {
          x: { grid: { display: false }, border: { color: css("--axis") },
               ticks: { color: css("--muted"), maxRotation: 0, autoSkip: true, maxTicksLimit: 7, font: { size: 11 } } },
          y: { grid: { color: css("--grid"), drawTicks: false }, border: { display: false },
               ticks: { color: css("--muted"), padding: 8, maxTicksLimit: 5, font: { size: 11 }, callback: v => compact(v) } },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: css("--raised"), titleColor: css("--muted"), bodyColor: css("--ink"),
            borderColor: css("--ring"), borderWidth: 1, padding: 10, boxPadding: 6, usePointStyle: true,
            titleFont: { weight: "500", size: 12 }, bodyFont: { size: 13 },
            callbacks: {
              title: items => items.length ? (unit === "week" ? "Week of " : "") + longFmt.format(toDate(items[0].label)) : "",
              label: item => `${full(item.parsed.y)}  ${item.dataset.label}`,
              labelPointStyle: () => ({ pointStyle: "line", rotation: 0 }),
            },
            itemSort: (a, b) => b.parsed.y - a.parsed.y,
            filter: item => item.parsed.y !== 0 || item.chart.data.datasets.length === 1,
          },
        },
      };
    }
    function lineChart(canvas, labels, data, label, hue) {
      const opts = baseOptions("day");
      opts.scales.x.ticks.callback = function (v) { return fmtDay(this.getLabelForValue(v)); };
      opts.scales.y.grace = "8%";
      return new Chart(canvas, {
        type: "line",
        data: { labels, datasets: [{
          label, data, borderColor: hue, backgroundColor: alpha(hue, 0.10), fill: "origin", borderWidth: 2,
          pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: hue, pointHoverBorderColor: css("--surface"),
          pointHoverBorderWidth: 2, tension: 0.25, borderJoinStyle: "round", borderCapStyle: "round", spanGaps: true,
        }] },
        options: opts, plugins: [crosshair],
      });
    }
    function stackedBars(canvas, labels, seriesMap, unit) {
      const surface = css("--surface");
      const datasets = platsPresent.filter(p => seriesMap[p.id] && state.plats.has(p.id)).map(p => ({
        label: p.label, data: seriesMap[p.id], backgroundColor: color(p.id), borderColor: surface,
        borderWidth: { top: 2, bottom: 0, left: 0, right: 0 }, borderSkipped: false, stack: "s",
        maxBarThickness: 24, categoryPercentage: 0.86, barPercentage: 0.92,
        borderRadius: ctx => {
          const i = ctx.dataIndex, ds = ctx.chart.data.datasets, v = ds[ctx.datasetIndex].data[i];
          let edge = -1;
          if (v >= 0) { for (let k = ds.length - 1; k >= 0; k--) if (ds[k].data[i] > 0) { edge = k; break; } }
          else { for (let k = ds.length - 1; k >= 0; k--) if (ds[k].data[i] < 0) { edge = k; break; } }
          if (ctx.datasetIndex !== edge) return 0;
          return v >= 0 ? { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 } : { topLeft: 0, topRight: 0, bottomLeft: 4, bottomRight: 4 };
        },
      }));
      const opts = baseOptions(unit);
      opts.scales.x.stacked = true; opts.scales.y.stacked = true;
      opts.scales.x.ticks.callback = function (v) { return fmtDay(this.getLabelForValue(v)); };
      opts.plugins.tooltip.usePointStyle = true;
      opts.plugins.tooltip.callbacks.labelPointStyle = () => ({ pointStyle: "rect", rotation: 0 });
      return new Chart(canvas, { type: "bar", data: { labels, datasets }, options: opts });
    }
    function singleBars(canvas, labels, data, label, hue) {
      const opts = baseOptions("day");
      opts.scales.x.ticks.callback = function (v) { return fmtDay(this.getLabelForValue(v)); };
      return new Chart(canvas, { type: "bar", data: { labels, datasets: [{
        label, data, backgroundColor: hue, borderRadius: { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 },
        borderSkipped: false, maxBarThickness: 24, categoryPercentage: 0.86, barPercentage: 0.92,
      }] }, options: opts });
    }
    function sparkSvg(values, opts = {}) {
      const w = opts.w || 96, ht = opts.h || 26, pad = 3;
      const pts = values.map((v, i) => [i, v]).filter(p => p[1] != null);
      const NS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("viewBox", `0 0 ${w} ${ht}`); svg.setAttribute("width", opts.fluid ? "100%" : w); svg.setAttribute("height", opts.fluid ? "100%" : ht);
      svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("aria-hidden", "true");
      if (pts.length < 2) return svg;
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const sx = i => pad + (i - x0) / ((x1 - x0) || 1) * (w - pad * 2);
      const sy = v => ht - pad - (v - y0) / ((y1 - y0) || 1) * (ht - pad * 2);
      const d = pts.map((p, k) => (k ? "L" : "M") + sx(p[0]).toFixed(1) + " " + sy(p[1]).toFixed(1)).join(" ");
      if (opts.area) {
        const area = document.createElementNS(NS, "path");
        area.setAttribute("d", d + ` L${sx(x1).toFixed(1)} ${ht} L${sx(x0).toFixed(1)} ${ht} Z`);
        area.setAttribute("fill", alpha(opts.hue || css("--ink-2"), 0.10));
        svg.append(area);
      }
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", d); path.setAttribute("fill", "none"); path.setAttribute("stroke", opts.hue || css("--ink-2"));
      path.setAttribute("stroke-width", opts.stroke || 1.5); path.setAttribute("stroke-linejoin", "round"); path.setAttribute("stroke-linecap", "round");
      path.setAttribute("vector-effect", "non-scaling-stroke");
      svg.append(path);
      return svg;
    }

    // ---------- filters ----------
    function renderFilters() {
      $("filters").hidden = false;
      const seg = $("rangeSeg"); seg.replaceChildren();
      for (const r of RANGES) seg.append(h("button", { type: "button", id: "range-" + r.id, "aria-pressed": String(state.range === r.id),
        onclick: () => { state.range = r.id; store("clipper.range", r.id); state.clipLimit = 12; renderFilters(); render(); } }, r.label));
      const pt = $("platToggles"); pt.replaceChildren();
      for (const p of platsPresent) {
        const on = state.plats.has(p.id);
        pt.append(h("button", { type: "button", class: "plat-toggle", id: "plat-" + p.id, "aria-pressed": String(on),
          title: on ? `Hide ${p.label}` : `Show ${p.label}`,
          onclick: () => {
            if (on && state.plats.size === 1) { platsPresent.forEach(q => state.plats.add(q.id)); }
            else if (on) state.plats.delete(p.id); else state.plats.add(p.id);
            renderFilters(); render();
          } }, h("span", { class: "sw", style: `background:${color(p.id)}` }), p.label));
      }
      const gs = $("groupSelect");
      if (groups.length > 1) {
        gs.hidden = false; gs.replaceChildren(h("option", { value: "" }, "All groups"), ...groups.map(g => h("option", { value: g }, g)));
        gs.value = state.group;
        gs.onchange = () => { state.group = gs.value; render(); };
      }
    }

    // ---------- sections ----------
    function renderSummary(sc, stats) {
      const tot = sc.accts.reduce((t, a) => t + (stats[a.id].followers || 0), 0);
      const gained = sc.accts.reduce((t, a) => t + (stats[a.id].gained || 0), 0);
      const views = sc.accts.reduce((t, a) => t + (stats[a.id].views || 0), 0);
      const len = sc.end - sc.start + 1;
      const prevViews = sc.start - len >= 0 ? sc.accts.reduce((t, a) => t + (sumRange(series[a.id].dv, sc.start - len, sc.start - 1) || 0), 0) : null;
      const clips = posts.filter(p => sc.ids.has(p.account) && p.published.slice(0, 10) >= sc.from);
      const cv = clips.map(p => p.views).filter(v => v != null);
      const avg = cv.length ? cv.reduce((x, y) => x + y, 0) / cv.length : null;
      const rangeLabel = state.range === "all" ? "since tracking began" : `in the last ${sc.days} days`;

      const totSeries = totalsByPlatform("f", sc);
      const totalLine = Object.values(totSeries).reduce((acc, arr) => arr.map((v, i) => (acc[i] || 0) + v), []);
      const viewsByDay = totalsByPlatform("dv", sc);
      const viewsLine = Object.entries(viewsByDay).filter(([k]) => state.plats.has(k)).reduce((acc, [, arr]) => arr.map((v, i) => (acc[i] || 0) + v), []);
      const gainLine = Object.entries(totalsByPlatform("gain", sc)).filter(([k]) => state.plats.has(k)).reduce((acc, [, arr]) => arr.map((v, i) => (acc[i] || 0) + v), []);

      const heroSpark = h("div", { class: "hero-spark" }); heroSpark.append(sparkSvg(totalLine, { fluid: true, area: true, hue: css("--s-facebook"), stroke: 2, w: 300, h: 70 }));
      const hero = h("section", { class: "card hero", "aria-label": "Total followers" },
        h("div", { class: "label" }, "Total followers"),
        h("div", { class: "hero-value" }, compact(tot)),
        deltaEl(gained, tot - gained, rangeLabel),
        heroSpark,
        h("div", { class: "sub" }, `${sc.accts.length} accounts across ${new Set(sc.accts.map(a => a.platform)).size} platforms`),
      );
      function tile(label, value, extra, spark) {
        const t = h("section", { class: "card tile", "aria-label": label }, h("div", { class: "label" }, label), h("div", { class: "tile-value" }, value), extra);
        if (spark) { const box = h("div", { class: "tile-spark" }); box.append(sparkSvg(spark, { fluid: true, w: 200, h: 34, hue: css("--ink-2") })); t.append(box); }
        return t;
      }
      const viewsDelta = prevViews ? deltaEl(views - prevViews, prevViews, "vs previous period") : h("div", { class: "sub" }, rangeLabel);
      const tiles = h("div", { class: "tiles" },
        tile("Views", compact(views), viewsDelta, viewsLine),
        tile("New followers", signed(gained), h("div", { class: "sub" }, tot - gained > 0 ? pct(gained / (tot - gained)) + " growth " + rangeLabel : rangeLabel), gainLine),
        tile("Clips posted", full(clips.length), h("div", { class: "sub" }, `${(clips.length / Math.max(1, sc.days)).toFixed(1)} per day across the network`)),
        tile("Avg views per clip", compact(avg), h("div", { class: "sub" }, "clips posted " + rangeLabel.replace("in the ", ""))),
      );
      return h("div", { class: "summary" }, hero, tiles);
    }

    function legendEl(kind) {
      return h("div", { class: "legend" }, platsPresent.filter(p => state.plats.has(p.id)).map(p =>
        h("span", null, h("span", { class: "sw" + (kind === "line" ? " line" : ""), style: `background:${color(p.id)}` }), p.label)));
    }

    function renderTrends(sc, stats) {
      const labels = dates.slice(sc.start, sc.end + 1);
      const tot = totalsByPlatform("f", sc);
      const totalLine = labels.map((_, i) => platsPresent.reduce((t, p) => t + (state.plats.has(p.id) ? tot[p.id][i] : 0), 0));
      const c1 = h("canvas", { "aria-label": "Total followers over time", role: "img" });
      const growth = h("section", { class: "card" },
        h("div", { class: "card-head" }, h("div", null, h("h2", null, "Follower growth"), h("p", { class: "sub" }, "Total followers across the selected accounts, by day"))),
        h("div", { class: "chart-box" }, c1));

      // Platform share
      const byPlat = platsPresent.filter(p => state.plats.has(p.id)).map(p => {
        const as = sc.accts.filter(a => a.platform === p.id);
        return { p, n: as.length, followers: as.reduce((t, a) => t + (stats[a.id].followers || 0), 0),
                 gained: as.reduce((t, a) => t + (stats[a.id].gained || 0), 0), views: as.reduce((t, a) => t + (stats[a.id].views || 0), 0) };
      }).filter(x => x.n);
      const total = byPlat.reduce((t, x) => t + x.followers, 0) || 1;
      const bar = h("div", { class: "segbar", role: "img", "aria-label": "Followers by platform: " + byPlat.map(x => `${x.p.label} ${Math.round(x.followers / total * 100)}%`).join(", ") });
      for (const x of byPlat) {
        if (!x.followers) continue;
        const share = x.followers / total;
        const seg = h("div", { style: `flex:${share} 1 0;background:${color(x.p.id)}`, class: DARK_INK_FILL[x.p.id] ? "dark-ink" : "", title: `${x.p.label}: ${full(x.followers)} (${Math.round(share * 100)}%)` });
        if (share > 0.09) seg.textContent = Math.round(share * 100) + "%";
        bar.append(seg);
      }
      const list = h("div", { class: "plat-list" }, byPlat.map(x => h("div", { class: "plat-row" },
        h("span", { class: "sw", style: `background:${color(x.p.id)}` }),
        h("div", null, h("div", { class: "name" }, x.p.label), h("div", { class: "meta" }, `${x.n} account${x.n === 1 ? "" : "s"} · ${compact(x.views)} views`)),
        h("div", { class: "num" }, h("b", null, compact(x.followers)), h("span", { class: "meta" }, "followers")),
        h("div", { class: "num" }, h("b", { class: "delta " + (x.gained > 0 ? "up" : x.gained < 0 ? "down" : "flat") }, signed(x.gained)), h("span", { class: "meta" }, "gained")),
      )));
      const share = h("section", { class: "card" },
        h("div", { class: "card-head" }, h("div", null, h("h2", null, "Where the audience is"), h("p", { class: "sub" }, "Share of followers by platform"))),
        bar, list);

      // Views + new followers per day
      const vb = bucket(labels, totalsByPlatform("dv", sc));
      const gb = bucket(labels, totalsByPlatform("gain", sc));
      const c2 = h("canvas", { role: "img", "aria-label": "Views per day by platform" });
      const c3 = h("canvas", { role: "img", "aria-label": "New followers per day by platform" });
      const views = h("section", { class: "card" },
        h("div", { class: "card-head" }, h("div", null, h("h2", null, vb.unit === "week" ? "Views per week" : "Views per day"),
          h("p", { class: "sub" }, "Stacked by platform")), legendEl("bar")),
        h("div", { class: "chart-box" }, c2));
      const gains = h("section", { class: "card" },
        h("div", { class: "card-head" }, h("div", null, h("h2", null, gb.unit === "week" ? "New followers per week" : "New followers per day"),
          h("p", { class: "sub" }, "Followers gained minus followers lost")), legendEl("bar")),
        h("div", { class: "chart-box" }, c3));

      queueMicrotask(() => {
        charts.push(lineChart(c1, labels, totalLine, "Total followers", css("--s-facebook")));
        charts.push(stackedBars(c2, vb.labels, vb.seriesMap, vb.unit));
        charts.push(stackedBars(c3, gb.labels, gb.seriesMap, gb.unit));
      });
      return [h("div", { class: "two" }, growth, share), h("div", { class: "two even" }, views, gains)];
    }

    const COLS = [
      { key: "rank", label: "#", l: true, nosort: true },
      { key: "name", label: "Account", l: true },
      { key: "platform", label: "Platform", l: true },
      { key: "followers", label: "Followers" },
      { key: "gained", label: "Gained" },
      { key: "growth", label: "Growth" },
      { key: "views", label: "Views" },
      { key: "avgViews", label: "Avg per clip" },
      { key: "clips", label: "Clips" },
      { key: "trend", label: "Followers trend", nosort: true },
      { key: "status", label: "Status", l: true },
    ];
    function renderTable(sc, stats) {
      const rows = sc.accts.map(a => ({ a, ...stats[a.id], name: a.name.toLowerCase(), platform: a.platform }));
      const { key, dir } = state.sort;
      rows.sort((x, y) => {
        const u = x[key], v = y[key];
        if (u == null && v == null) return 0; if (u == null) return 1; if (v == null) return -1;
        return (typeof u === "string" ? u.localeCompare(v) : u - v) * dir;
      });
      const thead = h("thead", null, h("tr", null, COLS.map(c => {
        if (c.nosort) return h("th", { class: c.l ? "l" : "", scope: "col" }, c.label);
        const sorted = state.sort.key === c.key;
        return h("th", { class: c.l ? "l" : "", scope: "col", "aria-sort": sorted ? (dir < 0 ? "descending" : "ascending") : null },
          h("button", { type: "button", id: "sort-" + c.key, "aria-sort": sorted ? (dir < 0 ? "descending" : "ascending") : null,
            onclick: () => { state.sort = { key: c.key, dir: sorted ? -dir : (c.l ? 1 : -1) }; render(); } }, c.label));
      })));
      const statusLabel = { ok: "Updated", error: "Needs attention", skipped: "Not set up" };
      const tbody = h("tbody", null, rows.map((r, i) => {
        const a = r.a;
        const tr = h("tr", { tabindex: "0", "aria-label": `Open ${a.name} on ${PLAT[a.platform].label}`,
          onclick: () => openSheet(a.id), onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSheet(a.id); } } },
          h("td", { class: "l rank" }, String(i + 1)),
          h("td", { class: "l" }, h("div", { class: "acct" }, avatarEl(a), h("div", null, h("b", null, a.name), h("small", null, [a.handle, a.group].filter(Boolean).join(" · "))))),
          h("td", { class: "l" }, h("span", { class: "status" }, h("span", { class: "sw", style: `background:${color(a.platform)}` }), PLAT[a.platform].label)),
          h("td", null, compact(r.followers)),
          h("td", null, h("span", { class: "delta " + (r.gained > 0 ? "up" : r.gained < 0 ? "down" : "flat") }, signed(r.gained))),
          h("td", null, pct(r.growth)),
          h("td", null, compact(r.views)),
          h("td", null, compact(r.avgViews)),
          h("td", null, r.clips ? full(r.clips) : "–"),
          h("td", null, sparkSvg(r.spark, { w: 96, h: 26 })),
          h("td", { class: "l" }, h("span", { class: "status " + r.status, title: r.note || "" }, h("i"), statusLabel[r.status] || r.status)),
        );
        return tr;
      }));
      return h("section", { class: "card" },
        h("div", { class: "card-head" }, h("div", null, h("h2", null, "Accounts"), h("p", { class: "sub" }, "Click a column to sort. Click an account for its full history."))),
        h("div", { class: "table-wrap" }, h("table", null, thead, tbody)));
    }

    function clipCard(p, rank, metric) {
      const a = byId[p.account];
      const hasImg = !!(p.thumb && !D.demo);
      const thumb = h("div", { class: "thumb" + (hasImg ? "" : " noimg") });
      const ph = h("div", { class: "ph" }, PLAT[a.platform].label);
      thumb.append(ph);
      if (hasImg) {
        const img = h("img", { src: p.thumb, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
        img.onerror = () => { img.remove(); thumb.classList.add("noimg"); };
        thumb.append(img);
      }
      thumb.append(h("span", { class: "rankbadge" }, "#" + rank));
      const gain = p.viewsPrev != null && p.views != null ? p.views - p.viewsPrev : null;
      const main = metric === "gain" ? signed(gain) : compact(p.views);
      const subline = metric === "gain" ? `${compact(p.views)} total views` : (gain ? `${signed(gain)} since ${p.prevDate ? fmtDay(p.prevDate) : "last update"}` : `posted ${fmtDay(p.published)}`);
      const inner = [thumb, h("div", { class: "clip-body" },
        h("div", { class: "clip-views" }, main, h("span", { class: "sub", style: "font-size:12px;font-weight:500;color:var(--muted)" }, metric === "gain" ? " views today" : " views")),
        h("div", { class: "sub", style: "margin:0;font-size:12px;color:var(--ink-2)" }, subline),
        h("div", { class: "clip-title" }, p.title || "Untitled clip"),
        h("div", { class: "clip-meta" }, h("span", { class: "sw", style: `background:${color(a.platform)}` }), h("span", null, `${a.name} · ${fmtDay(p.published)}`)))];
      return p.url ? h("a", { class: "clip", href: p.url, target: "_blank", rel: "noopener noreferrer", "aria-label": `${p.title || "Clip"}, ${full(p.views)} views` }, inner)
                   : h("div", { class: "clip" }, inner);
    }
    function clipLists(sc, ids) {
      const inScope = posts.filter(p => ids.has(p.account));
      const top = inScope.filter(p => p.published.slice(0, 10) >= sc.from && p.views != null).sort((a, b) => b.views - a.views);
      const gaining = inScope.filter(p => p.lastSeen === dates[N - 1] && p.viewsPrev != null && p.views != null && p.views > p.viewsPrev)
        .sort((a, b) => (b.views - b.viewsPrev) - (a.views - a.viewsPrev));
      return { top, gaining };
    }
    function renderClips(sc) {
      const { top, gaining } = clipLists(sc, sc.ids);
      const list = state.clipTab === "top" ? top : gaining;
      const tabs = h("div", { class: "seg", role: "group", "aria-label": "Clip ranking" },
        h("button", { type: "button", id: "clips-top", "aria-pressed": String(state.clipTab === "top"), onclick: () => { state.clipTab = "top"; state.clipLimit = 12; render(); } }, "Most viewed"),
        h("button", { type: "button", id: "clips-gain", "aria-pressed": String(state.clipTab === "gain"), onclick: () => { state.clipTab = "gain"; state.clipLimit = 12; render(); } }, "Gaining fastest"));
      const sub = state.clipTab === "top" ? `Clips posted ${state.range === "all" ? "since tracking began" : "in the last " + sc.days + " days"}, ranked by views` : "Views added since the previous daily update";
      const grid = list.length ? h("div", { class: "clips" }, list.slice(0, state.clipLimit).map((p, i) => clipCard(p, i + 1, state.clipTab)))
        : h("p", { class: "sub" }, state.clipTab === "top" ? "No clips posted in this range yet." : "Needs two daily updates before it can show which clips are gaining.");
      const card = h("section", { class: "card" },
        h("div", { class: "card-head" }, h("div", null, h("h2", null, "Top clips"), h("p", { class: "sub" }, sub)), tabs), grid);
      if (list.length > state.clipLimit) card.append(h("div", { class: "more" }, h("button", { type: "button", class: "btn", id: "clips-more", onclick: () => { state.clipLimit += 24; render(); } }, `Show more (${list.length - state.clipLimit} left)`)));
      return card;
    }

    function renderHealth(sc, stats) {
      const bad = sc.accts.filter(a => stats[a.id].status !== "ok");
      const notes = sc.accts.filter(a => stats[a.id].status === "ok" && stats[a.id].note);
      const body = h("div", { class: "health" });
      if (!bad.length && !notes.length) body.append(h("div", { class: "allgood" }, h("i"), `All ${sc.accts.length} accounts updated on ${longFmt.format(toDate(dates[N - 1]))}.`));
      const statusLabel = { error: "Needs attention", skipped: "Not set up", ok: "Updated with a warning" };
      for (const a of [...bad, ...notes]) {
        const s = stats[a.id];
        const last = series[a.id].latest && series[a.id].rows.findLastIndex ? series[a.id].rows.findLastIndex(r => r && r[6] === "ok") : -1;
        body.append(h("div", { class: "health-row" },
          h("span", { class: "status " + s.status }, h("i"), statusLabel[s.status] || s.status),
          h("div", null, h("b", null, `${a.name} · ${PLAT[a.platform].label}`), h("div", { class: "msg" }, s.note || "No details."),
            last >= 0 ? h("div", { class: "sub" }, `Last good update ${longFmt.format(toDate(dates[last]))}`) : null),
          h("button", { type: "button", class: "btn", onclick: () => openSheet(a.id) }, "Open")));
      }
      return h("section", { class: "card" },
        h("div", { class: "card-head" }, h("div", null, h("h2", null, "Data health"), h("p", { class: "sub" }, "Accounts that didn't update in the latest daily run"))), body);
    }

    // ---------- account sheet ----------
    const sheetCharts = [];
    let sheetFor = null, lastFocus = null;
    function openSheet(id) { lastFocus = document.activeElement; sheetFor = id; renderSheet(); }
    function closeSheet() { sheetFor = null; destroyCharts(sheetCharts); $("sheetRoot").replaceChildren(); document.body.style.overflow = ""; if (lastFocus) lastFocus.focus(); }
    function renderSheet() {
      destroyCharts(sheetCharts);
      const root = $("sheetRoot"); root.replaceChildren();
      if (!sheetFor) return;
      const a = byId[sheetFor], s = series[a.id], sc = scope(), st = acctStats(a, sc);
      const labels = dates.slice(sc.start, sc.end + 1);
      const c1 = h("canvas", { role: "img", "aria-label": "Followers over time" });
      const c2 = h("canvas", { role: "img", "aria-label": "Views per day" });
      const close = h("button", { type: "button", class: "btn close", id: "sheet-close", onclick: closeSheet }, "Close");
      const { top } = clipLists(sc, new Set([a.id]));
      const statusLabel = { ok: "Updated", error: "Needs attention", skipped: "Not set up" };
      const sheet = h("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": `${a.name} on ${PLAT[a.platform].label}` },
        h("div", { class: "sheet-head" }, avatarEl(a),
          h("div", { style: "min-width:0" }, h("h2", null, a.name),
            h("p", null, h("span", { class: "sw", style: `background:${color(a.platform)}` }), PLAT[a.platform].label, " · ", a.handle,
              a.url ? h("a", { href: a.url, target: "_blank", rel: "noopener noreferrer" }, "Open profile ↗") : null)),
          close),
        st.status !== "ok" || st.note ? h("div", { class: "card" }, h("span", { class: "status " + st.status }, h("i"), statusLabel[st.status] || st.status), h("div", { class: "sub", style: "margin-top:4px;color:var(--ink-2)" }, st.note)) : null,
        h("div", { class: "tiles" },
          h("div", { class: "card tile" }, h("div", { class: "label" }, "Followers"), h("div", { class: "tile-value" }, compact(st.followers))),
          h("div", { class: "card tile" }, h("div", { class: "label" }, "Gained"), h("div", { class: "tile-value" }, signed(st.gained)), h("div", { class: "sub" }, pct(st.growth))),
          h("div", { class: "card tile" }, h("div", { class: "label" }, "Views"), h("div", { class: "tile-value" }, compact(st.views)), h("div", { class: "sub" }, `last ${sc.days} days`)),
          h("div", { class: "card tile" }, h("div", { class: "label" }, "Avg per clip"), h("div", { class: "tile-value" }, compact(st.avgViews)), h("div", { class: "sub" }, `${st.clips} clips`))),
        h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Followers")), h("div", { class: "chart-box" }, c1)),
        h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Views per day")), h("div", { class: "chart-box" }, c2)),
        h("section", { class: "card" }, h("div", { class: "card-head" }, h("div", null, h("h2", null, "Top clips"), h("p", { class: "sub" }, "Posted in this range, by views"))),
          top.length ? h("div", { class: "clips" }, top.slice(0, 8).map((p, i) => clipCard(p, i + 1, "top"))) : h("p", { class: "sub" }, "No clips posted in this range yet.")),
      );
      const back = h("div", { class: "sheet-back", onclick: e => { if (e.target === back) closeSheet(); } }, sheet);
      root.append(back);
      document.body.style.overflow = "hidden";
      close.focus();
      sheetCharts.push(lineChart(c1, labels, s.f.slice(sc.start, sc.end + 1), "Followers", color(a.platform)));
      sheetCharts.push(singleBars(c2, labels, s.dv.slice(sc.start, sc.end + 1), "Views", color(a.platform)));
    }
    const onKey = e => { if (e.key === "Escape" && sheetFor) closeSheet(); };
    document.addEventListener("keydown", onKey);

    // ---------- page ----------
    function renderEmpty() {
      $("subline").textContent = accounts.length ? `${accounts.length} accounts set up · waiting for the first daily update` : "No accounts yet";
      const card = h("section", { class: "card empty" },
        h("h2", null, accounts.length ? "The first update hasn't run yet" : "Add your first accounts"),
        h("p", null, accounts.length ? (opts.waitingHint || "Charts appear after the first daily update, and growth lines fill in day by day.")
                                     : (opts.emptyHint || "List each account in config/accounts.toml, then run clipper collect. Charts appear after the first run.")));
      if (opts.onAddAccounts && !accounts.length) card.append(h("div", null, h("button", { type: "button", class: "btn", onclick: opts.onAddAccounts }, "Add accounts")));
      $("main").replaceChildren(card);
    }
    function render() {
      destroyCharts(charts);
      if (!N || !accounts.length) return renderEmpty();
      const sc = scope();
      const stats = Object.fromEntries(accounts.map(a => [a.id, acctStats(a, sc)]));
      const gen = new Date(D.generated);
      $("subline").textContent = `${accounts.length} accounts · ${platsPresent.length} platforms · updated ${gen.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · tracking since ${longFmt.format(toDate(dates[0]))}`;
      const main = $("main");
      if (!sc.accts.length) {
        main.replaceChildren(h("section", { class: "card empty" }, h("h2", null, "No accounts match these filters"), h("p", null, "Turn a platform back on or pick another group.")));
        return;
      }
      main.replaceChildren(renderSummary(sc, stats), ...renderTrends(sc, stats), renderTable(sc, stats), renderClips(sc), renderHealth(sc, stats));
      if (sheetFor) renderSheet();
    }

    $("sampleChip").hidden = !D.demo;
    $("footer").textContent = "Numbers come from each platform's official API and update once a day. Views per day are the platform's daily figure where it gives one (Instagram, Facebook); otherwise they're the growth in total views (YouTube) or in the tracked clips' views (TikTok, X). Days an account fails to update carry its last known follower count.";
    if (window.Chart) {
      Chart.defaults.font.family = css("--font") || "system-ui, sans-serif";
      Chart.defaults.color = css("--muted");
    }
    if (N && accounts.length) renderFilters();
    if (!window.Chart) {
      $("main").replaceChildren(h("section", { class: "card empty" }, h("h2", null, "Charts couldn't load"), h("p", null, "The chart library comes from cdnjs.cloudflare.com. Check the internet connection and reload.")));
    } else render();

    // Re-draw when the viewer switches light/dark so chart colors follow.
    const rerender = () => { if (window.Chart) { if (N && accounts.length) renderFilters(); render(); } };
    const mql = matchMedia("(prefers-color-scheme: dark)");
    try { mql.addEventListener("change", rerender); } catch (e) {}
    const observer = new MutationObserver(rerender);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    teardown = () => {
      destroyCharts(charts); destroyCharts(sheetCharts);
      document.removeEventListener("keydown", onKey);
      try { mql.removeEventListener("change", rerender); } catch (e) {}
      observer.disconnect(); document.body.style.overflow = "";
    };
  }

  window.ClipperDashboard = { mount };
})();
