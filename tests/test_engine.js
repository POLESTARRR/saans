/* Tests for the model. Run: node tests/test_engine.js

   The physics is checked against cases where the answer is known in advance
   rather than against itself. A mass balance that has been quietly mis-signed
   still produces smooth, plausible-looking curves, so "it looks about right" is
   worth nothing here. Each test below has an answer derivable on paper.

   The last group matters most. This project tells someone their air is making
   them ill and then tells them what to change, so the sanity checks on
   magnitude exist to catch the class of error that already bit once: a
   mis-scaled cigarette conversion that reported about a hundred a day and
   looked entirely convincing on screen. */

const fs = require("fs");
const path = require("path");
const S = require(path.join(__dirname, "..", "frontend", "engine.js"));

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "frontend", "data", "sources.json"), "utf8"));
const CAT = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "frontend", "data", "purifiers.json"), "utf8"));

const F = [];
const ok = (name, cond) => { if (!cond) F.push(name); };
const near = (name, got, want, tol) => {
  if (Math.abs(got - want) > tol) F.push(`${name}: got ${got}, wanted ${want} (±${tol})`);
};

function bare(over) {
  // A home with no indoor sources at all, so outdoor behaviour can be isolated.
  const h = S.defaultHome();
  for (const k of Object.keys(h.habits)) {
    h.habits[k] = typeof h.habits[k] === "boolean" ? false : 0;
  }
  h.window_open_hours = [];
  h.purifier_cadr = 0;
  return Object.assign(h, over || {});
}

/* ---------------------------------------------------- physics, on paper */

function testSteadyStateNoSources() {
  // With no indoor sources, a room settles where infiltration balances the loss
  // terms. Analytically: C_in/C_out = lambda*P / (lambda + k). Nothing about
  // that depends on the room's size.
  const h = bare({ tightness: "normal" });
  const lambda = DATA.physics.air_exchange_per_hr.normal;
  const P = DATA.physics.outdoor_penetration.value;
  const k = DATA.physics.deposition_per_hr.pm25;
  const expectedRatio = (lambda * P) / (lambda + k);

  const sim = S.simulate(h, 100, DATA);
  // Compare at the flattest part of the outdoor curve so the ratio is not
  // chasing a moving target.
  const hr = 13;
  const got = sim.conc.living[hr] / sim.outdoor[hr];
  near("steady-state indoor/outdoor ratio matches the analytic value", got, expectedRatio, 0.06);
}

function testTighterIsLowerWithNoIndoorSources() {
  // Sealing a home helps only when the pollution is outside. This is the
  // condition under which the intuition is correct.
  const conc = (t) => {
    const sim = S.simulate(bare({ tightness: t }), 150, DATA);
    return sim.conc.living.reduce((a, b) => a + b, 0) / 24;
  };
  ok("sealed beats normal beats draughty when all sources are outdoors",
    conc("sealed") < conc("normal") && conc("normal") < conc("draughty"));
}

function testTighterIsWorseWithIndoorSources() {
  // And the intuition inverts when the source is indoors: a sealed home traps
  // what it makes. If this ever stops holding, the ventilation logic is broken.
  const withCoil = (t) => {
    const h = bare({ tightness: t });
    h.habits.mosquito_coil = true;
    const sim = S.simulate(h, 10, DATA);   // near-clean outdoors, indoor source dominates
    return sim.conc.bedroom.reduce((a, b) => a + b, 0) / 24;
  };
  ok("a sealed home traps its own sources", withCoil("sealed") > withCoil("draughty"));
}

function testPurifierReducesOnlyItsOwnRoom() {
  const h = bare();
  h.habits.mosquito_coil = true;
  const before = S.simulate(h, 80, DATA);
  const after = S.simulate(Object.assign({}, h, { purifier_cadr: 300, purifier_room: "bedroom" }), 80, DATA);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  ok("purifier lowers the room it is in", mean(after.conc.bedroom) < mean(before.conc.bedroom));
  near("purifier barely touches a different room",
    mean(after.conc.living), mean(before.conc.living), mean(before.conc.living) * 0.02);
}

function testBiggerRoomDilutesASource() {
  // Same emission, more volume, lower concentration. Concentration is mass per
  // volume and if this fails the source term is not being divided properly.
  const small = bare({ bedroom_m2: 8 }); small.habits.mosquito_coil = true;
  const big = bare({ bedroom_m2: 25 }); big.habits.mosquito_coil = true;
  const mean = (h) => { const s = S.simulate(h, 40, DATA); return s.conc.bedroom.reduce((a, b) => a + b, 0) / 24; };
  ok("a larger room dilutes the same source", mean(big) < mean(small));
}

function testNeverNegativeAndAlwaysFinite() {
  for (const pm of [0, 15, 90, 400]) {
    const h = S.defaultHome(); h.habits.mosquito_coil = true; h.habits.smoking_per_day = 5;
    const sim = S.simulate(h, pm, DATA);
    for (const room of ["bedroom", "living", "kitchen"]) {
      for (const v of sim.conc[room]) {
        ok(`concentration finite and non-negative at ${pm}`, isFinite(v) && v >= 0);
      }
    }
  }
}

function testZeroOutdoorZeroSourcesGivesZero() {
  const sim = S.simulate(bare(), 0, DATA);
  const total = sim.conc.living.reduce((a, b) => a + b, 0);
  near("clean air in, no sources, clean air out", total, 0, 1e-6);
}

/* ------------------------------------------------------------ the dose */

function testExerciseTimingMatters() {
  // Breathing rate at exercise is several times resting, so the hour chosen
  // should move the daily total noticeably. If it does not, the dose step is
  // not applying the activity multiplier.
  const at = (hr) => {
    const h = S.defaultHome(); h.routine.exercise_hour = hr; h.routine.exercise_minutes = 60;
    return S.doseProfile(h, S.simulate(h, 150, DATA), DATA).total_ug;
  };
  const dawn = at(5), afternoon = at(13);
  ok("a dawn workout costs more than an afternoon one", dawn > afternoon);
  ok("and the gap is material, not a rounding error", (dawn - afternoon) / dawn > 0.03);
}

function testAttributionSumsToTotal() {
  const h = S.defaultHome(); h.habits.mosquito_coil = true;
  const a = S.attributeDose(h, 120, DATA);
  const sum = a.contributions.reduce((x, c) => x + c.ug, 0);
  // Removing sources one at a time cannot sum exactly to the whole, because the
  // system is not perfectly linear: the deposition and purifier terms scale
  // with concentration. A few per cent is expected; a large gap would mean the
  // attribution is missing a source entirely.
  near("attribution accounts for the dose within a few per cent",
    sum, a.total_ug, a.total_ug * 0.12);
}

function testEveryRecommendationActuallyHelps() {
  const h = S.defaultHome();
  h.habits.mosquito_coil = true; h.kitchen_exhaust = false;
  const recs = S.recommendations(h, 140, DATA);
  for (const a of recs.actions) {
    ok(`"${a.label}" reports a positive saving`, a.saved_ug > 0);
    ok(`"${a.label}" saving is under 100%`, a.saved_pct < 100);
  }
  ok("at least one action is offered for a home with obvious problems", recs.actions.length > 0);
}

function testCoilIsTheBiggestSingleIndoorSource() {
  // Not a modelling assumption, a check that the emission figures were loaded
  // and applied. A coil is roughly ten times a fry by mass and burns for eight
  // hours in the room where someone is asleep.
  const h = S.defaultHome(); h.habits.mosquito_coil = true;
  const a = S.attributeDose(h, 45, DATA);
  const indoor = a.contributions.filter((c) => c.id !== "time_outdoors" && c.id !== "infiltration");
  indoor.sort((x, y) => y.ug - x.ug);
  ok("the coil tops the indoor sources", indoor[0] && indoor[0].id === "mosquito_coil");
}

/* -------------------------------------------------- magnitude sanity */

function testCigaretteFiguresArePlausible() {
  // The check that would have caught the scaling bug. On a severe day a person
  // should land in the low tens of cigarettes, not the high hundreds.
  const h = S.defaultHome();
  const severe = S.cigarettes(S.doseProfile(h, S.simulate(h, 180, DATA), DATA).total_ug, DATA.reference);
  const clean = S.cigarettes(S.doseProfile(h, S.simulate(h, 12, DATA), DATA).total_ug, DATA.reference);
  ok(`severe day lands in a believable range (got ${severe.toFixed(1)})`, severe > 3 && severe < 40);
  ok(`clean day is low (got ${clean.toFixed(1)})`, clean < 4);
  ok("dirtier air means more cigarettes", severe > clean);
}

function testIndoorConcentrationsArePlausible() {
  // Literature puts an unfiltered urban Indian home at roughly 60 to 80 per cent
  // of outdoor when there is nothing burning inside.
  const sim = S.simulate(bare(), 150, DATA);
  const ratio = (sim.conc.living.reduce((a, b) => a + b, 0) / 24) / 150;
  ok(`indoor/outdoor ratio sits in the published range (got ${ratio.toFixed(2)})`,
    ratio > 0.5 && ratio < 0.9);
}

/* ---------------------------------------------------------- purifiers */

function testPurifierSizingAndCosts() {
  const h = S.defaultHome();
  const ranked = S.rankPurifiers(h, CAT, "bedroom");
  const V = S.volumes(h).bedroom;
  near("required CADR is volume times target air changes",
    ranked[0].needed_cadr, V * CAT.target_air_changes_per_hour.value, 0.01);

  for (const p of ranked) {
    ok(`${p.model}: five-year total exceeds the sticker price`, p.total_5yr > p.price_inr);
    ok(`${p.model}: adequacy matches the CADR test`,
      p.adequate === (p.cadr_m3_hr >= p.needed_cadr));
  }
  // Adequate machines must be ranked ahead of ones that cannot do the job,
  // however cheap those are.
  const firstInadequate = ranked.findIndex((p) => !p.adequate);
  const lastAdequate = ranked.map((p) => p.adequate).lastIndexOf(true);
  if (firstInadequate !== -1 && lastAdequate !== -1) {
    ok("undersized machines are ranked below adequate ones", lastAdequate < firstInadequate);
  }
}

function testFiltersOftenExceedPurchasePrice() {
  // The headline claim of the purifier section. If the catalogue or the
  // derating ever changes so that this stops being true, the copy is wrong and
  // this test should fail loudly rather than the page quietly lying.
  const h = S.defaultHome();
  const ranked = S.rankPurifiers(h, CAT, "bedroom");
  const share = ranked.filter((p) => p.filters_exceed_price).length / ranked.length;
  ok(`filters outrun the machine price for a real share of the catalogue (got ${(share * 100).toFixed(0)}%)`,
    share > 0.25);
}

/* ------------------------------------------------------------- runner */

const all = [
  testSteadyStateNoSources, testTighterIsLowerWithNoIndoorSources,
  testTighterIsWorseWithIndoorSources, testPurifierReducesOnlyItsOwnRoom,
  testBiggerRoomDilutesASource, testNeverNegativeAndAlwaysFinite,
  testZeroOutdoorZeroSourcesGivesZero, testExerciseTimingMatters,
  testAttributionSumsToTotal, testEveryRecommendationActuallyHelps,
  testCoilIsTheBiggestSingleIndoorSource, testCigaretteFiguresArePlausible,
  testIndoorConcentrationsArePlausible, testPurifierSizingAndCosts,
  testFiltersOftenExceedPurchasePrice,
];

for (const t of all) {
  try { t(); } catch (e) { F.push(`${t.name} threw ${e.message}`); }
}

console.log(`\n  ran ${all.length} test groups`);
if (F.length) {
  console.log(`  ${F.length} FAILURES:\n`);
  F.slice(0, 30).forEach((f) => console.log("    ✗ " + f));
  process.exit(1);
}
console.log("  all passed\n");
