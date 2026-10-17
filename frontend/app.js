/* Saans interface.

   Readings are live. Open-Meteo's air quality API is free, needs no key, and
   sends CORS headers, so the browser fetches real hourly PM2.5 for the selected
   location directly. Nothing here is seeded or illustrative.

   That also removes an assumption that was quietly wrong. An earlier version
   used a hard-coded winter inversion curve with a dawn peak, which is right for
   Delhi in January and backwards in August, when the peak is in the evening.
   Using the real hourly series means the ventilation and exercise advice is
   correct for the actual day rather than for the season the model was written
   in.

   No server, no account, no database. The home profile lives in this browser
   and never leaves the device. */

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const inr = (n) => "₹" + Math.round(n).toLocaleString("en-IN");

let DATA, CATALOG, CITIES, HOME;
let AIR = { hourly: null, mean: null, updated: null, live: false };

const STORE_KEY = "saans.home.v2";

/* ============================== the haze ============================== */

(function haze() {
  const cv = $("#haze"), ctx = cv.getContext("2d");
  let W, H, parts = [], tint = "148,163,184";

  function resize() {
    const d = Math.min(devicePixelRatio || 1, 2);
    W = cv.width = innerWidth * d; H = cv.height = innerHeight * d;
    cv.style.width = innerWidth + "px"; cv.style.height = innerHeight + "px";
  }
  addEventListener("resize", resize); resize();

  function seed(n) {
    parts = [];
    const d = Math.min(devicePixelRatio || 1, 2);
    for (let i = 0; i < n; i++) {
      parts.push({
        x: Math.random() * W, y: Math.random() * H,
        r: (Math.random() * 1.9 + 0.4) * d,
        vx: (Math.random() - 0.5) * 0.16 * d,
        vy: (Math.random() * 0.12 + 0.02) * d,
        a: Math.random() * 0.32 + 0.05,
      });
    }
  }
  seed(60);

  // Density tracks the actual concentration, so the page visibly thickens as
  // the air does. On a clean day there is almost nothing on screen.
  window.__setHaze = (pm, rgb) => { tint = rgb; seed(Math.min(300, Math.round(25 + pm * 1.35))); };

  (function frame() {
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy;
      if (p.y > H + 6) { p.y = -6; p.x = Math.random() * W; }
      if (p.x < -6) p.x = W + 6; else if (p.x > W + 6) p.x = -6;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832);
      ctx.fillStyle = `rgba(${tint},${p.a * 0.42})`; ctx.fill();
    }
    requestAnimationFrame(frame);
  })();
})();

const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16)).join(",");

/* ================================ boot ================================ */

async function boot() {
  [DATA, CATALOG, CITIES] = await Promise.all([
    fetch("data/sources.json").then((r) => r.json()),
    fetch("data/purifiers.json").then((r) => r.json()),
    fetch("data/cities.json").then((r) => r.json()),
  ]);

  HOME = load() || Saans.defaultHome();
  if (!findCity(HOME.city)) HOME.city = "new-delhi";

  buildControls();
  await loadAir();
  render();
}

function allCities() {
  return CITIES.groups.flatMap((g) => g.cities);
}
function findCity(id) {
  return allCities().find((c) => c.id === id);
}

async function loadAir() {
  const c = findCity(HOME.city);
  setStatus(`fetching live readings for ${c.name}…`);
  try {
    const url = "https://air-quality-api.open-meteo.com/v1/air-quality"
      + `?latitude=${c.lat}&longitude=${c.lon}`
      + "&hourly=pm2_5&timezone=Asia%2FKolkata&forecast_days=1";
    const d = await fetch(url).then((r) => r.json());
    const raw = d.hourly.pm2_5;
    // Carry the last known value across any gaps rather than dropping hours,
    // which would silently shorten the day.
    const hourly = []; let last = null;
    for (let i = 0; i < 24; i++) {
      const v = raw[i];
      if (v != null) last = v;
      hourly.push(last == null ? 0 : last);
    }
    AIR = {
      hourly,
      mean: hourly.reduce((a, b) => a + b, 0) / 24,
      updated: new Date(),
      live: true,
    };
    setStatus("");
  } catch (e) {
    AIR = { hourly: null, mean: 90, updated: null, live: false };
    setStatus("could not reach the air quality service, showing a typical day instead");
  }
}

function setStatus(msg) {
  const el = $("#status");
  if (el) { el.textContent = msg; el.style.display = msg ? "block" : "none"; }
}

const load = () => { try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { return null; } };
const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(HOME)); } catch (e) {} };

/* =============================== render =============================== */

function render() {
  const series = AIR.hourly || AIR.mean;
  const pmNow = AIR.hourly ? AIR.hourly[new Date().getHours()] : AIR.mean;
  const band = Saans.bandFor(pmNow, DATA.aqi_bands.bands);
  const city = findCity(HOME.city);

  document.documentElement.style.setProperty("--aqi", band.color);
  document.documentElement.style.setProperty("--aqi-soft", `rgba(${hexToRgb(band.color)},0.16)`);
  window.__setHaze(pmNow, hexToRgb(band.color));

  const sim = Saans.simulate(HOME, series, DATA);
  const dose = Saans.doseProfile(HOME, sim, DATA);
  const attr = Saans.attributeDose(HOME, series, DATA);
  const recs = Saans.recommendations(HOME, series, DATA);
  const cig = Saans.cigarettes(dose.total_ug, DATA.reference);

  const meanIndoor = sim.conc.living.reduce((a, b) => a + b, 0) / 24;
  const meanOutdoor = Saans.meanOf(series);
  const indoorShare = 100 * attr.contributions
    .filter((c) => !["time_outdoors", "infiltration"].includes(c.id))
    .reduce((a, c) => a + c.ug, 0) / attr.total_ug;

  $("#hero-verdict").textContent = meanIndoor > meanOutdoor * 0.95
    ? "about as bad as the air outside"
    : "cleaner than outside, but not by as much as you would hope";

  $("#readout").innerHTML = [
    [Math.round(pmNow), "µg/m³ outside right now", band.color],
    [band.label, "CPCB band", band.color],
    [Math.round(meanIndoor), "µg/m³ average in your rooms", null],
    [cig.toFixed(1), "cigarettes inhaled today", null],
    [indoorShare.toFixed(0) + "%", "of that made inside your home", null],
  ].map(([v, l, c]) => `<div class="r"><b${c ? ` style="color:${c}"` : ""}>${v}</b><span>${l}</span></div>`).join("");

  $("#place").textContent = city.name;
  $("#freshness").innerHTML = AIR.live
    ? `Live reading · Open-Meteo · updated ${AIR.updated.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`
    : `Offline · showing a typical day`;

  renderCigs(cig);
  renderAttribution(attr, band);
  renderActions(recs);
  renderDayChart(sim, dose, band, series);
  renderBestPurifier(series);
  renderPurifierTable(series);
  renderMiniResult(cig, indoorShare, recs);
  save();
}

function renderCigs(cig) {
  const n = Math.max(1, Math.min(60, Math.round(cig)));
  $("#cig-hero").innerHTML = `
    <div class="cig-big">${cig.toFixed(1)}</div>
    <div class="cig-cap">cigarettes' worth of fine particles, breathed in today</div>
    <div class="cigs">${Array.from({ length: n }, () => "<i></i>").join("")}</div>
    <div class="cig-sub">${Math.round(cig * 365).toLocaleString("en-IN")} a year if every day looked like this</div>`;
}

function renderAttribution(attr, band) {
  const max = Math.max(...attr.contributions.map((c) => c.ug));
  $("#attribution").innerHTML = `<div class="attr">` + attr.contributions.map((c) => {
    const pct = 100 * c.ug / attr.total_ug;
    const outdoor = ["time_outdoors", "infiltration"].includes(c.id);
    return `
      <div class="attr-row">
        <div class="attr-label"><span class="ic">${c.icon}</span>${esc(c.label)}</div>
        <div class="attr-track"><div class="attr-fill" style="width:${(100 * c.ug / max).toFixed(1)}%;background:${outdoor ? band.color : "#a78bfa"}"></div></div>
        <div class="attr-num">${pct.toFixed(1)}%</div>
        <div class="attr-note">${esc(c.note)}</div>
      </div>`;
  }).join("") + `</div>`;
}

function renderActions(recs) {
  if (!recs.actions.length) {
    $("#actions").innerHTML = `<p class="body">Nothing significant left to change at this profile.</p>`;
    return;
  }
  $("#actions").innerHTML = recs.actions.slice(0, 7).map((a, i) => `
    <div class="action${i === 0 ? " top" : ""}">
      <div class="rank">${i + 1}</div>
      <div>
        <h4>${esc(a.label)}<span class="cost-tag ${a.cost_inr === 0 ? "free" : ""}">${a.cost_inr === 0 ? "free" : inr(a.cost_inr)}</span></h4>
        <p>${esc(a.detail)}</p>
      </div>
      <div class="save"><b>−${a.saved_pct.toFixed(0)}%</b><span>of your daily dose</span></div>
    </div>`).join("");
}

function renderBestPurifier(series) {
  const ranked = Saans.rankPurifiers(HOME, CATALOG, HOME.purifier_room, series, DATA);
  const V = Math.round(Saans.volumes(HOME)[HOME.purifier_room]);
  const need = Math.round(ranked.needed_cadr);

  // Nothing in the catalogue is big enough for the room.
  if (!ranked.any_adequate) {
    const p = ranked.pair;
    $("#best-purifier").innerHTML = `
      <div class="pick warn">
        <div class="pick-label">One machine will not do this room</div>
        <h3>Your ${esc(HOME.purifier_room)} is ${V} m³ and needs about ${need} CADR</h3>
        <p class="pick-note" style="border:0;padding-top:12px;margin-top:6px">
          The largest single unit here manages ${ranked[0].cadr_m3_hr}, which leaves the room
          under-filtered however long you run it.
          ${p ? `Two of the <b>${esc(p.model.brand)} ${esc(p.model.model)}</b> gives you
            <b>${p.combined_cadr} CADR</b> for ${inr(p.total_5yr)} over five years, and puts
            clean air at both ends of the room instead of one corner.`
              : `Splitting the space or filtering the part you actually sleep in is the
                 realistic answer.`}
        </p>
      </div>`;
    return;
  }

  const pk = ranked.picks;
  const best = pk.value;

  // A purifier in a room you are barely in cannot help, whatever it costs.
  if (best.dose_cut_pct < 1) {
    const rooms = ["bedroom", "living", "kitchen"]
      .map((r) => ({ r, cut: Saans.rankPurifiers(HOME, CATALOG, r, series, DATA).picks?.value.dose_cut_pct || 0 }))
      .sort((a, b) => b.cut - a.cut);
    $("#best-purifier").innerHTML = `
      <div class="pick warn">
        <div class="pick-label">Do not buy one for this room</div>
        <h3>A purifier in the ${esc(HOME.purifier_room)} would cut your dose by ${best.dose_cut_pct.toFixed(1)}%</h3>
        <p class="pick-note" style="border:0;padding-top:12px;margin-top:6px">
          You spend too little time in there for it to matter, and filtering a room
          nobody is standing in is the most common way this money is wasted.
          ${rooms[0].cut > 1 ? `Put it in the <b>${esc(rooms[0].r)}</b> instead, where the
            same money is worth about <b>${rooms[0].cut.toFixed(0)}%</b> of your daily dose.`
            : `On this profile a purifier is not the right purchase at all.`}
        </p>
      </div>`;
    return;
  }

  const card = (tag, p, figure, sub, lead) => `
    <div class="pick-card${lead ? " lead" : ""}">
      <div class="pick-label">${tag}</div>
      <h4>${esc(p.brand)} ${esc(p.model)}</h4>
      <div class="pc-fig">${figure}</div>
      <div class="pc-sub">${sub}</div>
      <div class="pc-meta">${p.cadr_m3_hr} CADR · ${p.noise_db} dB · cuts ${p.dose_cut_pct.toFixed(0)}%</div>
    </div>`;

  const same = pk.upfront.model === best.model && pk.quiet.model === best.model;

  $("#best-purifier").innerHTML = `
    <p class="pick-intro">Your ${esc(HOME.purifier_room)} is <b>${V} m³</b>, so it needs about
      <b>${need} CADR</b> to get real air changes. ${ranked.filter((r) => r.adequate).length}
      of ${ranked.length} machines clear that. These are the picks on the three things
      people actually decide on.</p>
    <div class="pick-row">
      ${card("Best to own", best, inr(best.total_5yr), "over five years, all in", true)}
      ${card("Cheapest today", pk.upfront, inr(pk.upfront.price_inr), `to buy · ${inr(pk.upfront.total_5yr)} over five years`)}
      ${card("Quietest", pk.quiet, pk.quiet.noise_db + " dB", `you sleep beside it · ${inr(pk.quiet.total_5yr)} over five years`)}
    </div>
    ${same ? `<p class="pick-note">The same machine wins all three, which happens when one
      product is simply better value than the rest of the market rather than because the
      comparison is broken.</p>`
      : pk.upfront.total_5yr > best.total_5yr ? `<p class="pick-note">
        The ${esc(pk.upfront.brand)} ${esc(pk.upfront.model)} is ${inr(best.price_inr - pk.upfront.price_inr)}
        cheaper on the shelf and <em>${inr(pk.upfront.total_5yr - best.total_5yr)} more expensive</em>
        over five years, because its filters cost more. That is the trap the sticker price sets.</p>` : ""}`;
}

function renderPurifierTable(series) {
  const ranked = Saans.rankPurifiers(HOME, CATALOG, HOME.purifier_room, series, DATA);
  $("#purifiers").innerHTML = `<div class="chart-scroll"><table>
    <thead><tr><th>Model</th><th>CADR</th><th>Price</th><th>Filters 5yr</th><th>Total 5yr</th><th>Cuts your dose</th></tr></thead>
    <tbody>${ranked.map((p, i) => `
      <tr class="${i === 0 && p.adequate ? "best" : ""} ${p.adequate ? "" : "toosmall"}">
        <td class="name">${esc(p.brand)} ${esc(p.model)}${p.filters_exceed_price ? '<span class="flag">filters cost more</span>' : ""}</td>
        <td>${p.cadr_m3_hr}</td><td>${inr(p.price_inr)}</td>
        <td>${inr(p.filter_cost_5yr)}</td><td><b>${inr(p.total_5yr)}</b></td>
        <td>${p.dose_cut_pct > 0.05 ? "−" + p.dose_cut_pct.toFixed(1) + "%" : "-"}</td>
      </tr>`).join("")}</tbody></table></div>`;
}

function renderMiniResult(cig, indoorShare, recs) {
  // Sits directly under the controls so a change is visible without scrolling
  // back up. The absence of this was why editing the profile felt like it did
  // nothing at all.
  const top = recs.actions[0];
  $("#mini-result").innerHTML = `
    <div class="mini">
      <div><b>${cig.toFixed(1)}</b><span>cigarettes today</span></div>
      <div><b>${indoorShare.toFixed(0)}%</b><span>made indoors</span></div>
      <div class="mini-do"><span>biggest win</span><b>${top ? esc(top.label) : "nothing left"}</b>
        ${top ? `<i>−${top.saved_pct.toFixed(0)}%</i>` : ""}</div>
    </div>`;
}

/* ============================== day chart ============================== */

function renderDayChart(sim, dose, band, series) {
  const W = 880, H = 320, M = { t: 22, r: 18, b: 46, l: 54 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const out = Saans.outdoorProfile(series);
  const lines = [
    { name: "outside", color: band.color, vals: out, fill: true },
    { name: "your bedroom", color: "#5eead4", vals: sim.conc.bedroom },
    { name: "your kitchen", color: "#c084fc", vals: sim.conc.kitchen },
  ];
  const maxV = Math.max(...lines.flatMap((s) => s.vals)) * 1.1;
  const X = (h) => M.l + (h / 23) * iw;
  const Y = (v) => M.t + ih - (v / maxV) * ih;
  const p = [`<svg class="chart" viewBox="0 0 ${W} ${H}">`];

  p.push(`<defs><linearGradient id="og" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="${band.color}" stop-opacity=".28"/>
    <stop offset="100%" stop-color="${band.color}" stop-opacity="0"/></linearGradient></defs>`);

  for (let i = 0; i <= 4; i++) {
    const v = maxV * i / 4, y = Y(v);
    p.push(`<line x1="${M.l}" y1="${y.toFixed(1)}" x2="${M.l + iw}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,.07)"/>`);
    p.push(`<text x="${M.l - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10.5" font-family="ui-monospace,monospace" fill="#6b7480">${Math.round(v)}</text>`);
  }
  [0, 6, 12, 18, 23].forEach((h) =>
    p.push(`<text x="${X(h).toFixed(1)}" y="${H - 24}" text-anchor="middle" font-size="10.5" font-family="ui-monospace,monospace" fill="#6b7480">${Saans.fmtHour(h)}</text>`));

  dose.hourly.forEach((h) => {
    if (h.rate >= DATA.breathing_rate_m3_per_hr.walking) {
      p.push(`<rect x="${(X(h.hour) - 7).toFixed(1)}" y="${M.t}" width="14" height="${ih}" fill="rgba(248,113,113,.13)"/>`);
    }
  });

  const nowH = new Date().getHours();
  p.push(`<line x1="${X(nowH).toFixed(1)}" y1="${M.t}" x2="${X(nowH).toFixed(1)}" y2="${M.t + ih}" stroke="#fff" stroke-opacity=".35" stroke-dasharray="3,4"/>`);
  p.push(`<text x="${X(nowH).toFixed(1)}" y="${M.t - 7}" text-anchor="middle" font-size="10" font-family="ui-monospace,monospace" fill="rgba(255,255,255,.6)">now</text>`);

  lines.forEach((s) => {
    const d = s.vals.map((v, i) => `${i ? "L" : "M"} ${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(" ");
    if (s.fill) p.push(`<path d="${d} L ${X(23).toFixed(1)} ${(M.t + ih).toFixed(1)} L ${X(0).toFixed(1)} ${(M.t + ih).toFixed(1)} Z" fill="url(#og)"/>`);
    p.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`);
  });
  p.push(`<text x="${M.l + iw / 2}" y="${H - 6}" text-anchor="middle" font-size="11" fill="#8a929c">hour of day · red bands are when you are breathing hardest</text>`);
  p.push("</svg>");

  $("#daychart").innerHTML = `<div class="chart-scroll">${p.join("")}</div>`;
  $("#daylegend").innerHTML = lines.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join("");
}

/* ============================== controls ============================== */

function buildControls() {
  const h = HOME;
  const opts = CITIES.groups.map((g) =>
    `<optgroup label="${esc(g.name)}">` + g.cities.map((c) =>
      `<option value="${esc(c.id)}"${c.id === h.city ? " selected" : ""}>${esc(c.name)}</option>`).join("") + `</optgroup>`).join("");

  const sliders = [
    ["bedroom_m2", "Bedroom", 6, 30, 1, (v) => v + " m²"],
    ["living_m2", "Living room", 8, 45, 1, (v) => v + " m²"],
    ["kitchen_m2", "Kitchen", 4, 20, 1, (v) => v + " m²"],
    ["ceiling_m", "Ceiling height", 2.4, 4, 0.1, (v) => (+v).toFixed(1) + " m"],
  ];

  $("#controls").innerHTML = `
    <div class="ctrl-grid">
      <div class="ctrl span2"><label>Where do you live?</label><select id="c-city">${opts}</select></div>
      <div class="ctrl"><label>How draughty is it?</label>
        <select id="c-tight">
          <option value="sealed"${h.tightness === "sealed" ? " selected" : ""}>Sealed, newer, AC rooms</option>
          <option value="normal"${h.tightness === "normal" ? " selected" : ""}>Normal</option>
          <option value="draughty"${h.tightness === "draughty" ? " selected" : ""}>Draughty, older windows</option>
        </select></div>
      ${sliders.map(([k, l, min, max, st, f]) => `
        <div class="ctrl"><label>${l} <output id="o-${k}">${f(h[k])}</output></label>
        <input type="range" id="c-${k}" min="${min}" max="${max}" step="${st}" value="${h[k]}"></div>`).join("")}
      <div class="ctrl"><label>Purifier you own <output id="o-cadr">${h.purifier_cadr || "none"}</output></label>
        <input type="range" id="c-cadr" min="0" max="500" step="10" value="${h.purifier_cadr}"></div>
      <div class="ctrl"><label>Which room is it in?</label>
        <select id="c-prroom">${["bedroom", "living", "kitchen"].map((r) =>
          `<option value="${r}"${h.purifier_room === r ? " selected" : ""}>${r}</option>`).join("")}</select></div>
      <div class="ctrl"><label>Outdoor workout <output id="o-ex">${h.routine.exercise_minutes} min</output></label>
        <input type="range" id="c-ex" min="0" max="120" step="5" value="${h.routine.exercise_minutes}"></div>
      <div class="ctrl"><label>Workout starts <output id="o-exh">${Saans.fmtHour(h.routine.exercise_hour)}</output></label>
        <input type="range" id="c-exh" min="0" max="23" step="1" value="${h.routine.exercise_hour}"></div>
    </div>
    <div class="toggles">
      ${tg("t-coil", "🌀 Mosquito coil at night", h.habits.mosquito_coil)}
      ${tg("t-exhaust", "💨 Kitchen exhaust or chimney", h.kitchen_exhaust)}
      ${tg("t-door", "🚪 Kitchen door shut while cooking", h.kitchen_door_shut)}
      ${tg("t-sweep", "🧹 Dry sweeping with a jhaadu", h.habits.dry_sweep_per_day > 0)}
      ${tg("t-incense", "🪔 Incense or dhoop daily", h.habits.incense_per_day > 0)}
    </div>
    <div id="mini-result"></div>`;

  const on = (id, fn, out, fmt, needsAir) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", async () => {
      fn(el.value);
      if (out) document.getElementById(out).textContent = fmt ? fmt(el.value) : el.value;
      if (needsAir) { await loadAir(); }
      render();
    });
  };

  on("c-city", (v) => { HOME.city = v; }, null, null, true);
  on("c-tight", (v) => { HOME.tightness = v; });
  sliders.forEach(([k, , , f]) => on("c-" + k, (v) => { HOME[k] = +v; }, "o-" + k, f));
  on("c-cadr", (v) => { HOME.purifier_cadr = +v; }, "o-cadr", (v) => +v ? v : "none");
  on("c-prroom", (v) => { HOME.purifier_room = v; });
  on("c-ex", (v) => { HOME.routine.exercise_minutes = +v; }, "o-ex", (v) => v + " min");
  on("c-exh", (v) => { HOME.routine.exercise_hour = +v; }, "o-exh", (v) => Saans.fmtHour(+v));

  const tog = (id, apply) => {
    const el = document.getElementById(id);
    el.addEventListener("click", () => { el.classList.toggle("on"); apply(el.classList.contains("on")); render(); });
  };
  tog("t-coil", (v) => { HOME.habits.mosquito_coil = v; });
  tog("t-exhaust", (v) => { HOME.kitchen_exhaust = v; });
  tog("t-door", (v) => { HOME.kitchen_door_shut = v; });
  tog("t-sweep", (v) => { HOME.habits.dry_sweep_per_day = v ? 1 : 0; });
  tog("t-incense", (v) => { HOME.habits.incense_per_day = v ? 1 : 0; });
}

const tg = (id, label, on) => `<div class="toggle${on ? " on" : ""}" id="${id}">${label}</div>`;

boot();
