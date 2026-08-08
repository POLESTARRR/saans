/* Saans: the indoor air model.

   Runs entirely in the browser. There is no server, and your home profile never
   leaves this device, which is not a cost saving so much as the only honest way
   to ask someone how many rooms they have and when they cook.

   The model is a mass balance on fine particles, solved hour by hour for each
   room:

       dC/dt  =  lambda * P * (C_out - C)     what leaks in from outside
               - k * C                         what settles out on its own
               - (CADR / V) * C                what a purifier removes
               + S(t) / V                      cooking, coils, incense, sweeping

   Every constant in it is in data/sources.json with a citation, because the
   output is an arithmetic claim about somebody's lungs and an uncited number is
   an opinion with a decimal point on it.

   The part that actually matters is the last step. Concentration is not what
   harms you, dose is, and dose is concentration multiplied by how hard you are
   breathing and for how long. That is why a run at the wrong hour can outweigh a
   whole day indoors, and why a coil burning beside a sleeping face for eight
   hours outranks almost everything else in the house.
*/

const Saans = (function () {
  "use strict";

  const HOURS = 24;

  /* ---------------------------------------------------------------- helpers */

  function bandFor(pm25, bands) {
    for (const b of bands) if (pm25 <= b.max) return b;
    return bands[bands.length - 1];
  }

  function cigarettes(doseUgInhaled, ref) {
    return doseUgInhaled / ref.cigarette_equivalent_ug_inhaled;
  }

  /* ------------------------------------------------------------ the profile */

  // A home is a set of rooms plus a daily routine. Defaults are a plausible
  // two-bedroom Indian flat so the page shows something real before anyone has
  // answered a single question.
  function defaultHome() {
    return {
      city: "delhi",
      floor: "middle",              // ground | middle | high
      tightness: "normal",          // sealed | normal | draughty
      bedroom_m2: 12,
      living_m2: 20,
      kitchen_m2: 8,
      ceiling_m: 3.0,
      kitchen_exhaust: false,
      kitchen_door_shut: false,
      purifier_cadr: 0,             // 0 = none
      purifier_room: "bedroom",
      purifier_hours: [22, 23, 0, 1, 2, 3, 4, 5, 6],
      window_open_hours: [7, 8],    // the instinctive and usually wrong choice
      habits: {
        mosquito_coil: false,
        incense_per_day: 1,
        fry_per_day: 1,
        cook_per_day: 2,
        roti_per_day: 1,
        dry_sweep_per_day: 1,
        smoking_per_day: 0,
        candles_per_day: 0,
      },
      routine: {
        // where the person is, hour by hour, and what they are doing
        sleep_hours: [22, 23, 0, 1, 2, 3, 4, 5, 6],
        cook_hours: [8, 20],
        out_hours: [10, 11, 12, 13, 14, 15, 16, 17, 18],
        exercise_hour: 7,
        exercise_minutes: 45,
      },
    };
  }

  function volumes(home) {
    return {
      bedroom: home.bedroom_m2 * home.ceiling_m,
      living: home.living_m2 * home.ceiling_m,
      kitchen: home.kitchen_m2 * home.ceiling_m,
    };
  }

  /* ------------------------------------------------- outdoor, hour by hour */

  // Winter inversion is the whole reason the ventilation advice in this app is
  // counterintuitive. Pollution builds overnight under a temperature inversion,
  // peaks around dawn, and lifts through the afternoon. Opening windows first
  // thing is the worst available choice, and it is what almost everyone does.
  const DIURNAL = [
    1.18, 1.24, 1.30, 1.35, 1.38, 1.40, 1.36, 1.28,
    1.14, 0.98, 0.85, 0.76, 0.70, 0.68, 0.70, 0.75,
    0.84, 0.95, 1.05, 1.12, 1.16, 1.18, 1.19, 1.18,
  ];

  function outdoorProfile(dailyMeanPm25) {
    return DIURNAL.map((f) => dailyMeanPm25 * f);
  }

  /* --------------------------------------------------------- source events */

  // Turn a set of habits into an hourly emission schedule per room, in
  // micrograms per hour.
  function emissionSchedule(home, sources) {
    const byId = {};
    for (const s of sources) byId[s.id] = s;
    const sched = {
      bedroom: new Array(HOURS).fill(0),
      living: new Array(HOURS).fill(0),
      kitchen: new Array(HOURS).fill(0),
    };
    const attribution = {};

    function add(id, hour, count) {
      const s = byId[id];
      if (!s || !count) return;
      const spreadHours = Math.max(1, Math.ceil(s.duration_min / 60));
      const totalUg = s.emission_mg * 1000 * count;
      const perHour = totalUg / spreadHours;
      for (let i = 0; i < spreadHours; i++) {
        sched[s.room][(hour + i) % HOURS] += perHour;
      }
      attribution[id] = (attribution[id] || 0) + totalUg;
    }

    const h = home.habits;
    if (h.mosquito_coil) add("mosquito_coil", 22, 1);
    for (let i = 0; i < h.incense_per_day; i++) add("incense", 7 + i * 12, 1);
    home.routine.cook_hours.forEach((hr, i) => {
      if (i < h.fry_per_day) add("cooking_fry", hr, 1);
      if (i < h.cook_per_day) add("cooking_normal", hr, 1);
      if (i < h.roti_per_day) add("roti", hr, 1);
    });
    for (let i = 0; i < h.dry_sweep_per_day; i++) add("dry_sweep", 9 + i * 8, 1);
    for (let i = 0; i < h.smoking_per_day; i++) add("smoking", 11 + i * 3, 1);
    for (let i = 0; i < h.candles_per_day; i++) add("candles", 19, 1);

    return { sched, attribution };
  }

  /* ----------------------------------------------------------- the solver */

  // One hour of mass balance for one room, integrated in short sub-steps.
  // Sub-stepping matters: a frying event can be a very large source term and a
  // single Euler step over a whole hour overshoots badly.
  function stepRoom(c, cOut, params, dtHours) {
    const substeps = 12;
    const dt = dtHours / substeps;
    for (let i = 0; i < substeps; i++) {
      const gain = params.lambda * params.penetration * cOut + params.sourceUgPerHr / params.volume;
      const loss = (params.lambda + params.deposition + params.cadr / params.volume) * c;
      c += (gain - loss) * dt;
      if (c < 0) c = 0;
    }
    return c;
  }

  function simulate(home, dailyMeanPm25, data) {
    const V = volumes(home);
    const phys = data.physics;
    const outdoor = outdoorProfile(dailyMeanPm25);
    const { sched, attribution } = emissionSchedule(home, data.sources);

    const baseLambda = phys.air_exchange_per_hr[home.tightness];
    const openLambda = phys.air_exchange_per_hr.window_open;

    const conc = { bedroom: [], living: [], kitchen: [] };
    let c = { bedroom: dailyMeanPm25 * 0.6, living: dailyMeanPm25 * 0.6, kitchen: dailyMeanPm25 * 0.6 };

    // Two passes so the day starts from a settled state rather than an
    // arbitrary guess. Without this the first few hours are an artefact of the
    // initial condition rather than of the home.
    for (let pass = 0; pass < 2; pass++) {
      for (const k of Object.keys(conc)) conc[k] = [];
      for (let hr = 0; hr < HOURS; hr++) {
        const windowOpen = home.window_open_hours.includes(hr);
        const lambda = windowOpen ? openLambda : baseLambda;
        const purifierOn = home.purifier_cadr > 0 && home.purifier_hours.includes(hr);

        for (const room of ["bedroom", "living", "kitchen"]) {
          let src = sched[room][hr];

          // Cooking emissions are dealt with at source before they reach the
          // room balance: an exhaust removes a share outright, and a shut door
          // keeps most of the rest out of the rest of the home.
          if (room === "kitchen" && src > 0) {
            if (home.kitchen_exhaust) src *= (1 - phys.exhaust_capture_fraction.value);
            if (!home.kitchen_door_shut) {
              const leak = src * phys.kitchen_door_shut_fraction.value;
              sched.living[hr] += leak * 0.6;
              sched.bedroom[hr] += leak * 0.4;
              src -= leak;
            }
          }

          c[room] = stepRoom(c[room], outdoor[hr], {
            lambda,
            penetration: phys.outdoor_penetration.value,
            deposition: phys.deposition_per_hr.pm25,
            cadr: purifierOn && home.purifier_room === room ? home.purifier_cadr : 0,
            volume: V[room],
            sourceUgPerHr: src,
          }, 1);

          conc[room].push(c[room]);
        }
      }
    }

    return { conc, outdoor, attribution, volumes: V };
  }

  /* -------------------------------------------------------------- the dose */

  // Where the person is, and how hard they are breathing, hour by hour. This is
  // the step that turns a concentration chart into something about a body.
  function doseProfile(home, sim, data) {
    const br = data.breathing_rate_m3_per_hr;
    const r = home.routine;
    const hourly = [];

    for (let hr = 0; hr < HOURS; hr++) {
      let room, rate, where;
      if (r.sleep_hours.includes(hr)) {
        room = "bedroom"; rate = br.sleeping; where = "asleep";
      } else if (r.cook_hours.includes(hr)) {
        room = "kitchen"; rate = br.cooking; where = "cooking";
      } else if (r.out_hours.includes(hr)) {
        room = "outdoor"; rate = br.light_activity; where = "out";
      } else {
        room = "living"; rate = br.resting; where = "home";
      }

      let conc = room === "outdoor" ? sim.outdoor[hr] : sim.conc[room][hr];
      let ug = conc * rate;

      // Exercise is short but the breathing rate is several times higher, so it
      // punches far above its share of the clock.
      if (hr === r.exercise_hour && r.exercise_minutes > 0) {
        const f = r.exercise_minutes / 60;
        const exConc = sim.outdoor[hr];
        ug = conc * rate * (1 - f) + exConc * br.exercise * f;
        where = "exercising outdoors";
        room = "outdoor";
      }

      hourly.push({ hour: hr, room, where, conc, rate, ug });
    }

    const total = hourly.reduce((a, b) => a + b.ug, 0);
    return { hourly, total_ug: total };
  }

  /* ------------------------------------------------- attributing the dose */

  // Runs the day again with each source switched off, one at a time, and
  // attributes the difference. Same logic as asking "what would this day have
  // looked like without the coil" rather than assuming the answer.
  function attributeDose(home, dailyMeanPm25, data) {
    const base = doseProfile(home, simulate(home, dailyMeanPm25, data), data).total_ug;
    const contributions = [];

    const habitKeys = {
      mosquito_coil: "mosquito_coil",
      incense_per_day: "incense",
      fry_per_day: "cooking_fry",
      cook_per_day: "cooking_normal",
      roti_per_day: "roti",
      dry_sweep_per_day: "dry_sweep",
      smoking_per_day: "smoking",
      candles_per_day: "candles",
    };

    for (const [key, sourceId] of Object.entries(habitKeys)) {
      const cur = home.habits[key];
      if (!cur) continue;
      const alt = JSON.parse(JSON.stringify(home));
      alt.habits[key] = typeof cur === "boolean" ? false : 0;
      const without = doseProfile(alt, simulate(alt, dailyMeanPm25, data), data).total_ug;
      const delta = base - without;
      if (delta > 0.01) {
        const s = data.sources.find((x) => x.id === sourceId);
        contributions.push({
          id: sourceId, label: s.label, icon: s.icon, ug: delta,
          note: s.note, fix: s.fix, confidence: s.confidence, source: s.source,
        });
      }
    }

    // Whatever is left after removing every indoor source is what came in from
    // outside, which is the only honest way to split the two.
    // Whatever is left after removing every indoor source came from outside.
    // But "outside" is two different problems with two different fixes, so it
    // gets split: the hours you are physically out in it, and what leaks into
    // your home while you are indoors. Sealing and filtering fixes the second
    // and does nothing at all for the first.
    const stripped = JSON.parse(JSON.stringify(home));
    for (const key of Object.keys(habitKeys)) {
      stripped.habits[key] = typeof home.habits[key] === "boolean" ? false : 0;
    }
    const strippedProfile = doseProfile(stripped, simulate(stripped, dailyMeanPm25, data), data);
    let outdoorsUg = 0, infiltrationUg = 0;
    for (const h of strippedProfile.hourly) {
      if (h.room === "outdoor") outdoorsUg += h.ug; else infiltrationUg += h.ug;
    }

    contributions.push({
      id: "time_outdoors", label: "Hours spent outdoors", icon: "🚶", ug: outdoorsUg,
      note: "Commuting, errands, exercise. No purifier touches this, and it is usually the part people never think to change even though the timing is entirely within their control.",
      fix: "Shift the discretionary hours, exercise especially, away from the morning peak. Windows up and on recirculation in a car.",
      confidence: "high", source: "Your local station reading and your routine",
    });
    contributions.push({
      id: "infiltration", label: "Outdoor air leaking in", icon: "🌫️", ug: infiltrationUg,
      note: "What comes through the building envelope while you are at home. This is the only part a purifier can help with, and the only part the city AQI number describes.",
      fix: "Ventilate at the right hour, seal obvious gaps, run a correctly sized purifier in the room you actually occupy.",
      confidence: "high", source: "Modelled from your local station reading",
    });

    contributions.sort((a, b) => b.ug - a.ug);
    return { total_ug: base, contributions };
  }

  /* ------------------------------------------------ what to actually do */

  // Every recommendation is priced the same way: run the day again with the
  // change applied and measure the difference. Nothing here is a rule of thumb.
  function recommendations(home, dailyMeanPm25, data) {
    const base = doseProfile(home, simulate(home, dailyMeanPm25, data), data).total_ug;
    const out = [];

    function tryChange(label, detail, cost, mutate) {
      const alt = JSON.parse(JSON.stringify(home));
      mutate(alt);
      const after = doseProfile(alt, simulate(alt, dailyMeanPm25, data), data).total_ug;
      const saved = base - after;
      if (saved > base * 0.005) {
        out.push({ label, detail, cost_inr: cost, saved_ug: saved, saved_pct: 100 * saved / base });
      }
    }

    if (home.habits.mosquito_coil) {
      tryChange("Stop the mosquito coil",
        "Swap to a plug-in vaporiser or a bed net. It burns beside your face for eight hours while you sleep and breathe.",
        0, (a) => { a.habits.mosquito_coil = false; });
    }
    if (home.habits.dry_sweep_per_day > 0) {
      tryChange("Mop instead of dry sweeping",
        "A jhaadu lifts settled dust back into the air, and you are bent over it while it happens. Wet mopping does not.",
        0, (a) => { a.habits.dry_sweep_per_day = 0; });
    }
    if (!home.kitchen_exhaust) {
      tryChange("Use a kitchen exhaust while cooking",
        "Captures a large share of cooking particles before they reach the rest of the house.",
        3500, (a) => { a.kitchen_exhaust = true; });
    }
    if (!home.kitchen_door_shut) {
      tryChange("Shut the kitchen door while cooking",
        "Keeps most of what the exhaust misses out of the bedroom and living room. Costs nothing.",
        0, (a) => { a.kitchen_door_shut = true; });
    }

    // The ventilation window, chosen by testing every option rather than by
    // repeating the usual advice.
    const bestWindow = bestVentilationHours(home, dailyMeanPm25, data);
    if (bestWindow && bestWindow.saved_ug > 0) {
      tryChange(`Ventilate at ${bestWindow.label} instead`,
        `Outdoor air is cleanest around then. Opening windows at dawn, when most people do, brings in the daily peak.`,
        0, (a) => { a.window_open_hours = bestWindow.hours; });
    }

    if (home.routine.exercise_minutes > 0) {
      const bestEx = bestExerciseHour(home, dailyMeanPm25, data);
      if (bestEx && bestEx.saved_ug > 0) {
        tryChange(`Move your workout to ${fmtHour(bestEx.hour)}`,
          "You breathe three to four times harder while exercising, so the hour you choose matters far more than for anything else you do.",
          0, (a) => { a.routine.exercise_hour = bestEx.hour; });
      }
    }

    if (home.habits.incense_per_day > 0) {
      tryChange("Light incense near an open window",
        "Or in a room you are about to leave. Smouldering combustion at close range adds up daily.",
        0, (a) => { a.habits.incense_per_day = 0; });
    }

    out.sort((a, b) => (b.saved_ug - a.saved_ug));
    return { base_ug: base, actions: out };
  }

  function bestVentilationHours(home, dailyMeanPm25, data) {
    let best = null;
    for (let start = 0; start < HOURS; start++) {
      const hours = [start, (start + 1) % HOURS];
      const alt = JSON.parse(JSON.stringify(home));
      alt.window_open_hours = hours;
      const d = doseProfile(alt, simulate(alt, dailyMeanPm25, data), data).total_ug;
      if (!best || d < best.dose) {
        best = { dose: d, hours, label: `${fmtHour(start)} to ${fmtHour((start + 2) % HOURS)}` };
      }
    }
    const current = doseProfile(home, simulate(home, dailyMeanPm25, data), data).total_ug;
    if (best) best.saved_ug = current - best.dose;
    return best;
  }

  function bestExerciseHour(home, dailyMeanPm25, data) {
    let best = null;
    for (let hr = 0; hr < HOURS; hr++) {
      const alt = JSON.parse(JSON.stringify(home));
      alt.routine.exercise_hour = hr;
      const d = doseProfile(alt, simulate(alt, dailyMeanPm25, data), data).total_ug;
      if (!best || d < best.dose) best = { dose: d, hour: hr };
    }
    const current = doseProfile(home, simulate(home, dailyMeanPm25, data), data).total_ug;
    if (best) best.saved_ug = current - best.dose;
    return best;
  }

  /* ------------------------------------------------------------ purifiers */

  // Sizing from CADR against actual room volume, then ranked on what the thing
  // costs to own for five years rather than what it costs to buy.
  function rankPurifiers(home, catalog, roomKey) {
    const V = volumes(home)[roomKey];
    const needed = V * catalog.target_air_changes_per_hour.value;
    const hoursPerYear = home.purifier_hours.length * 365;
    const derate = catalog.filter_life_derating.value;

    return catalog.purifiers.map((p) => {
      const realFilterLife = p.filter_life_hr * derate;
      const filtersPerYear = hoursPerYear / realFilterLife;
      const filterCost5yr = filtersPerYear * 5 * p.filter_price_inr;
      const powerCost5yr = (p.watts / 1000) * hoursPerYear * 5 * catalog.electricity_inr_per_kwh;
      const total5yr = p.price_inr + filterCost5yr + powerCost5yr;

      const achDelivered = p.cadr_m3_hr / V;
      const adequate = p.cadr_m3_hr >= needed;
      // Cost per unit of clean air actually delivered over five years, which is
      // the comparison the sticker price hides.
      const costPerCadr = total5yr / p.cadr_m3_hr;

      return {
        ...p,
        needed_cadr: needed,
        adequate,
        ach_delivered: achDelivered,
        filter_cost_5yr: filterCost5yr,
        power_cost_5yr: powerCost5yr,
        total_5yr: total5yr,
        filters_exceed_price: filterCost5yr > p.price_inr,
        cost_per_cadr: costPerCadr,
      };
    }).sort((a, b) => {
      if (a.adequate !== b.adequate) return a.adequate ? -1 : 1;
      return a.total_5yr - b.total_5yr;
    });
  }

  function fmtHour(h) {
    const hh = ((h % 24) + 24) % 24;
    const ampm = hh < 12 ? "am" : "pm";
    const d = hh % 12 === 0 ? 12 : hh % 12;
    return `${d}${ampm}`;
  }

  return {
    defaultHome, volumes, simulate, doseProfile, attributeDose,
    recommendations, rankPurifiers, outdoorProfile, bandFor, cigarettes,
    fmtHour, bestVentilationHours, bestExerciseHour, DIURNAL, HOURS,
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Saans;
