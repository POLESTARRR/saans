/* Saans interface.

   No server. engine.js runs the model in the tab, the outdoor readings are
   static JSON refreshed by a scheduled job, and the home profile lives in
   localStorage and never leaves the device.

   The page recolours itself from the current air quality band. On a severe day
   it goes brown and heavy; on a clean day it clears. A microgram figure means
   nothing to most people and the feeling of the page communicates it before
   anyone reads a word. */

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let DATA = null, CATALOG = null, AIR = null;
let HOME = null;

const STORE_KEY = "saans.home.v1";

/* ============================ drifting haze ============================ */

// Particle density and speed track the AQI. On a clean day there is almost
// nothing on screen; on a severe day the air visibly thickens.
(function haze() {
  const cv = $("#haze");
  const ctx = cv.getContext("2d");
  let W, H, parts = [], density = 90, tint = "251,146,60";

  function resize() {
    W = cv.width = window.innerWidth * devicePixelRatio;
    H = cv.height = window.innerHeight * devicePixelRatio;
    cv.style.width = window.innerWidth + "px";
    cv.style.height = window.innerHeight + "px";
  }
  window.addEventListener("resize", resize);
  resize();

  function seed(n) {
    parts = [];
    for (let i = 0; i < n; i++) {
      parts.push({
        x: Math.random() * W, y: Math.random() * H,
        r: (Math.random() * 2.2 + 0.5) * devicePixelRatio,
        vx: (Math.random() - 0.5) * 0.22 * devicePixelRatio,
        vy: (Math.random() * 0.16 + 0.03) * devicePixelRatio,
        a: Math.random() * 0.4 + 0.08,
      });
    }
  }
  seed(density);

  window.__setHaze = (pm25, rgb) => {
    tint = rgb;
    // Roughly linear in concentration, capped so a severe day stays legible.
    density = Math.min(360, Math.round(45 + pm25 * 1.5));
    seed(density);
  };

  (function frame() {
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy;
      if (p.y > H + 8) { p.y = -8; p.x = Math.random() * W; }
      if (p.x < -8) p.x = W + 8;
      if (p.x > W + 8) p.x = -8;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${tint},${p.a * 0.5})`;
      ctx.fill();
    }
    requestAnimationFrame(frame);
  })();
})();

function hexToRgb(hex) {
  const m = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16)).join(",");
}

/* ============================ boot ============================ */

async function boot() {
  DATA = await (await fetch("data/sources.json")).json();
  CATALOG = await (await fetch("data/purifiers.json")).json();

  HOME = load() || Saans.defaultHome();

  try {
    AIR = await (await fetch("data/air/latest.json")).json();
  } catch (e) {
    // The scheduled fetch may not have run yet, or the network is down. A
    // representative winter figure keeps the page working rather than showing
    // an error where the whole product should be.
    AIR = { fallback: true, cities: { delhi: { pm25: 168, name: "Delhi", updated: null } } };
  }

  buildControls();
  render();
}

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { return null; }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(HOME)); } catch (e) { /* private mode */ }
}

function currentPm25() {
  const c = (AIR.cities || {})[HOME.city];
  return c ? c.pm25 : 168;
}

/* ============================ render ============================ */

function render() {
  const pm = currentPm25();
  const band = Saans.bandFor(pm, DATA.aqi_bands.bands);

  // Recolour everything from the band.
  document.documentElement.style.setProperty("--aqi", band.color);
  document.documentElement.style.setProperty("--aqi-soft", `rgba(${hexToRgb(band.color)},0.18)`);
  window.__setHaze(pm, hexToRgb(band.color));

  const sim = Saans.simulate(HOME, pm, DATA);
  const dose = Saans.doseProfile(HOME, sim, DATA);
  const attr = Saans.attributeDose(HOME, pm, DATA);
  const recs = Saans.recommendations(HOME, pm, DATA);
  const cig = Saans.cigarettes(dose.total_ug, DATA.reference);

  // Is indoor air actually worse than outdoor? Answer honestly, per home.
  const meanIndoor = sim.conc.living.reduce((a, b) => a + b, 0) / 24;
  const meanOutdoor = sim.outdoor.reduce((a, b) => a + b, 0) / 24;
  $("#hero-verdict").textContent = meanIndoor > meanOutdoor
    ? "worse than the air outside"
    : "better than outside, but not by as much as you think";

  const cityName = (AIR.cities[HOME.city] || {}).name || HOME.city;
  const indoorShare = 100 * attr.contributions
    .filter((c) => c.id !== "time_outdoors" && c.id !== "infiltration")
    .reduce((a, c) => a + c.ug, 0) / attr.total_ug;

  $("#readout").innerHTML = `
    <div class="r"><b style="color:${band.color}">${Math.round(pm)}</b>
      <span>µg/m³ outdoors, ${esc(cityName)}</span></div>
    <div class="r"><b style="color:${band.color}">${esc(band.label)}</b>
      <span>CPCB band${AIR.fallback ? ", sample data" : ""}</span></div>
    <div class="r"><b>${Math.round(meanIndoor)}</b>
      <span>µg/m³ average in your rooms</span></div>
    <div class="r"><b>${indoorShare.toFixed(0)}%</b>
      <span>of your dose made indoors</span></div>`;

  renderCigs(cig, band);
  renderAttribution(attr, band);
  renderActions(recs, attr);
  renderDayChart(sim, dose, band);
  renderPurifiers();
  save();
}

function renderCigs(cig, band) {
  const n = Math.min(40, Math.round(cig));
  $("#cig-hero").innerHTML = `
    <div class="cig-big">${cig.toFixed(1)}</div>
    <div class="cig-cap">cigarettes' worth of fine particles, inhaled today</div>
    <div class="cig-sub">${(cig * 365).toFixed(0)} a year at this rate</div>
    <div class="cigs">${Array.from({ length: n }, () => "<i></i>").join("")}</div>`;
}

function renderAttribution(attr, band) {
  const max = Math.max(...attr.contributions.map((c) => c.ug));
  const rows = attr.contributions.map((c) => {
    const pct = 100 * c.ug / attr.total_ug;
    const isOutdoor = c.id === "time_outdoors" || c.id === "infiltration";
    const colour = isOutdoor ? band.color : "#a78bfa";
    return `
      <div class="attr-row">
        <div class="attr-label"><span class="ic">${c.icon}</span>${esc(c.label)}</div>
        <div class="attr-track"><div class="attr-fill" style="width:${(100 * c.ug / max).toFixed(1)}%;background:${colour}"></div></div>
        <div class="attr-num">${pct.toFixed(1)}%</div>
        <div class="attr-note">${esc(c.note)}${
          c.confidence === "low" ? '<span class="conf low">low confidence</span>' : ""}</div>
      </div>`;
  }).join("");
  $("#attribution").innerHTML = `<div class="attr">${rows}</div>`;
}

function renderActions(recs, attr) {
  if (!recs.actions.length) {
    $("#actions").innerHTML = `<p class="body">Nothing left worth changing at this
      profile. Adjust your home below and the list will repopulate.</p>`;
    return;
  }
  $("#actions").innerHTML = recs.actions.slice(0, 6).map((a) => `
    <div class="action">
      <div>
        <h4>${esc(a.label)}<span class="cost-tag ${a.cost_inr === 0 ? "free" : ""}">${
          a.cost_inr === 0 ? "free" : "₹" + a.cost_inr.toLocaleString("en-IN")}</span></h4>
        <p>${esc(a.detail)}</p>
      </div>
      <div class="save">
        <b>−${a.saved_pct.toFixed(0)}%</b>
        <span>${Saans.cigarettes(a.saved_ug, DATA.reference).toFixed(1)} cig/day</span>
      </div>
    </div>`).join("");
}

function renderDayChart(sim, dose, band) {
  const W = 860, H = 300, M = { t: 18, r: 16, b: 42, l: 52 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const series = [
    { name: "outdoors", color: band.color, vals: sim.outdoor },
    { name: "your bedroom", color: "#4dd0ff", vals: sim.conc.bedroom },
    { name: "your kitchen", color: "#a78bfa", vals: sim.conc.kitchen },
  ];
  const maxV = Math.max(...series.flatMap((s) => s.vals)) * 1.08;
  const X = (h) => M.l + (h / 23) * iw;
  const Y = (v) => M.t + ih - (v / maxV) * ih;

  const p = [`<svg class="chart" viewBox="0 0 ${W} ${H}">`];
  for (let i = 0; i <= 4; i++) {
    const v = maxV * i / 4, y = Y(v);
    p.push(`<line x1="${M.l}" y1="${y.toFixed(1)}" x2="${M.l + iw}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,.08)"/>`);
    p.push(`<text x="${M.l - 9}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10.5" font-family="ui-monospace,monospace" fill="#6b7480">${Math.round(v)}</text>`);
  }
  [0, 4, 8, 12, 16, 20].forEach((h) => {
    p.push(`<text x="${X(h).toFixed(1)}" y="${H - 22}" text-anchor="middle" font-size="10.5" font-family="ui-monospace,monospace" fill="#6b7480">${Saans.fmtHour(h)}</text>`);
  });

  // Mark the hours the person is actually breathing hardest, since that is
  // where the dose is really made.
  dose.hourly.forEach((h) => {
    if (h.rate >= DATA.breathing_rate_m3_per_hr.walking) {
      p.push(`<rect x="${X(h.hour) - 6}" y="${M.t}" width="12" height="${ih}" fill="rgba(239,68,68,.10)"/>`);
    }
  });

  series.forEach((s) => {
    const d = s.vals.map((v, i) => `${i ? "L" : "M"} ${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(" ");
    p.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.1" stroke-linejoin="round"/>`);
  });
  p.push(`<text x="${M.l + iw / 2}" y="${H - 5}" text-anchor="middle" font-size="11" fill="#9aa2ad">hour of day  ·  shaded = you are breathing hard</text>`);
  p.push("</svg>");

  $("#daychart").innerHTML = `<div class="chart-scroll">${p.join("")}</div>`;
  $("#daylegend").innerHTML = series.map((s) =>
    `<span><i style="background:${s.color}"></i>${s.name}</span>`).join("");
}

function renderPurifiers() {
  const ranked = Saans.rankPurifiers(HOME, CATALOG, HOME.purifier_room);
  const need = ranked[0].needed_cadr;
  const rows = ranked.slice(0, 10).map((p, i) => `
    <tr class="${i === 0 && p.adequate ? "best" : ""} ${p.adequate ? "" : "toosmall"}">
      <td class="name">${esc(p.brand)} ${esc(p.model)}${
        p.filters_exceed_price ? '<span class="flag">filters &gt; price</span>' : ""}</td>
      <td>${p.cadr_m3_hr}</td>
      <td>₹${p.price_inr.toLocaleString("en-IN")}</td>
      <td>₹${Math.round(p.filter_cost_5yr).toLocaleString("en-IN")}</td>
      <td><b>₹${Math.round(p.total_5yr).toLocaleString("en-IN")}</b></td>
      <td>${p.adequate ? p.ach_delivered.toFixed(1) + "×" : "too small"}</td>
    </tr>`).join("");

  $("#purifiers").innerHTML = `
    <p class="body" style="margin-bottom:16px">
      Your ${esc(HOME.purifier_room)} is
      <b>${Math.round(Saans.volumes(HOME)[HOME.purifier_room])} m³</b>, so you need a
      CADR of about <b>${Math.round(need)} m³/hr</b> to get meaningful air changes.
      Anything below that is decorative.
    </p>
    <div class="chart-scroll"><table>
      <thead><tr><th>Model</th><th>CADR</th><th>Price</th>
        <th>Filters, 5yr</th><th>Total, 5yr</th><th>Air changes</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

/* ============================ controls ============================ */

function buildControls() {
  const h = HOME;
  const sliders = [
    ["bedroom_m2", "Bedroom size", 6, 30, 1, (v) => v + " m²"],
    ["living_m2", "Living room size", 8, 45, 1, (v) => v + " m²"],
    ["kitchen_m2", "Kitchen size", 4, 20, 1, (v) => v + " m²"],
    ["ceiling_m", "Ceiling height", 2.4, 4, 0.1, (v) => Number(v).toFixed(1) + " m"],
  ];

  const cities = Object.keys(AIR.cities || { delhi: 1 });

  $("#controls").innerHTML = `
    <div class="ctrl-grid">
      <div class="ctrl">
        <label>City <output>${esc((AIR.cities[h.city] || {}).name || h.city)}</output></label>
        <select id="c-city">${cities.map((c) =>
          `<option value="${esc(c)}" ${c === h.city ? "selected" : ""}>${esc(AIR.cities[c].name || c)}</option>`).join("")}</select>
      </div>
      <div class="ctrl">
        <label>How draughty is it?</label>
        <select id="c-tight">
          <option value="sealed" ${h.tightness === "sealed" ? "selected" : ""}>Sealed, newish, AC rooms</option>
          <option value="normal" ${h.tightness === "normal" ? "selected" : ""}>Normal</option>
          <option value="draughty" ${h.tightness === "draughty" ? "selected" : ""}>Draughty, old windows</option>
        </select>
      </div>
      ${sliders.map(([k, label, min, max, step]) => `
        <div class="ctrl">
          <label>${label} <output id="o-${k}">${h[k]}</output></label>
          <input type="range" id="c-${k}" min="${min}" max="${max}" step="${step}" value="${h[k]}">
        </div>`).join("")}
      <div class="ctrl">
        <label>Purifier CADR <output id="o-cadr">${h.purifier_cadr || "none"}</output></label>
        <input type="range" id="c-cadr" min="0" max="500" step="10" value="${h.purifier_cadr}">
      </div>
      <div class="ctrl">
        <label>Which room is it in?</label>
        <select id="c-prroom">
          ${["bedroom", "living", "kitchen"].map((r) =>
            `<option value="${r}" ${h.purifier_room === r ? "selected" : ""}>${r}</option>`).join("")}
        </select>
      </div>
      <div class="ctrl">
        <label>Workout, outdoors <output id="o-ex">${h.routine.exercise_minutes} min</output></label>
        <input type="range" id="c-ex" min="0" max="120" step="5" value="${h.routine.exercise_minutes}">
      </div>
      <div class="ctrl">
        <label>Workout starts at <output id="o-exh">${Saans.fmtHour(h.routine.exercise_hour)}</output></label>
        <input type="range" id="c-exh" min="0" max="23" step="1" value="${h.routine.exercise_hour}">
      </div>
    </div>

    <div class="toggles">
      ${toggle("t-coil", "🌀 Mosquito coil at night", h.habits.mosquito_coil)}
      ${toggle("t-exhaust", "💨 Kitchen exhaust", h.kitchen_exhaust)}
      ${toggle("t-door", "🚪 Kitchen door shut while cooking", h.kitchen_door_shut)}
      ${toggle("t-sweep", "🧹 Dry sweeping daily", h.habits.dry_sweep_per_day > 0)}
      ${toggle("t-incense", "🪔 Incense daily", h.habits.incense_per_day > 0)}
      ${toggle("t-smoke", "🚬 Someone smokes indoors", h.habits.smoking_per_day > 0)}
    </div>`;

  const bind = (id, fn, out, fmt) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", () => {
      fn(el.value);
      if (out) document.getElementById(out).textContent = fmt ? fmt(el.value) : el.value;
      render();
    });
  };

  bind("c-city", (v) => { HOME.city = v; });
  bind("c-tight", (v) => { HOME.tightness = v; });
  sliders.forEach(([k, , , , , fmt]) =>
    bind("c-" + k, (v) => { HOME[k] = Number(v); }, "o-" + k, fmt));
  bind("c-cadr", (v) => { HOME.purifier_cadr = Number(v); }, "o-cadr", (v) => Number(v) ? v : "none");
  bind("c-prroom", (v) => { HOME.purifier_room = v; });
  bind("c-ex", (v) => { HOME.routine.exercise_minutes = Number(v); }, "o-ex", (v) => v + " min");
  bind("c-exh", (v) => { HOME.routine.exercise_hour = Number(v); }, "o-exh", (v) => Saans.fmtHour(Number(v)));

  const tog = (id, apply) => {
    const el = document.getElementById(id);
    el.addEventListener("click", () => {
      el.classList.toggle("on");
      apply(el.classList.contains("on"));
      render();
    });
  };
  tog("t-coil", (on) => { HOME.habits.mosquito_coil = on; });
  tog("t-exhaust", (on) => { HOME.kitchen_exhaust = on; });
  tog("t-door", (on) => { HOME.kitchen_door_shut = on; });
  tog("t-sweep", (on) => { HOME.habits.dry_sweep_per_day = on ? 1 : 0; });
  tog("t-incense", (on) => { HOME.habits.incense_per_day = on ? 1 : 0; });
  tog("t-smoke", (on) => { HOME.habits.smoking_per_day = on ? 3 : 0; });
}

function toggle(id, label, on) {
  return `<div class="toggle ${on ? "on" : ""}" id="${id}">${label}</div>`;
}

boot();
