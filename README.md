# Saans

### ▶ [Open it](https://polestarrr.github.io/saans/)

Every air quality app tells you the same number the person three kilometres away
is being told. None of them know that you burn a coil beside your bed, fry at
eight, sweep with a jhaadu, and open the windows at exactly the wrong hour.

This works out what **you** are actually breathing, and which single change would
fix the most of it.

---

## The thing worth knowing

**Which source dominates flips depending on the day, and you cannot tell without
working it out.**

Same home, same habits, two different days:

| | severe winter day (180 µg/m³) | clean day (28 µg/m³) |
|---|---|---|
| outdoor air, total | **71%** | 28% |
| mosquito coil | 24% | **60%** |

On a bad day, seal the place up and filter it. On a clean day the coil burning
beside your face for eight hours is most of your problem and the purifier is
close to irrelevant.

That is the case for modelling a specific home rather than reading a city
number. The advice genuinely reverses.

## The second thing

**Concentration is not what harms you. Dose is.** Dose is concentration
multiplied by how hard you are breathing and for how long, and that changes the
answers:

- A 45-minute run at dawn can outweigh a whole day indoors, because you breathe
  three to four times harder while doing it.
- Opening windows first thing, which is what almost everyone does, brings in the
  daily peak. Winter inversion means outdoor PM2.5 tops out around dawn and
  bottoms out mid-afternoon.
- A purifier in the living room does nothing for the eight hours you are behind
  a closed bedroom door.
- **Dry sweeping does not remove dust, it relaunches it**, and the person
  sweeping is bent directly over the plume. This one costs nothing to fix and
  nobody has been told.

## And if you are buying a purifier

**The filters usually cost more than the machine.** Replacements run ₹1,500 to
₹4,000 and clog faster in Indian air than the rated life suggests. Over five
years that routinely exceeds the purchase price, so the cheap machine with
proprietary filters is often the expensive one.

Every "best air purifier" list ranks on sticker price and the coverage claim on
the box. This sizes from your actual room volume and ranks on five-year cost per
unit of clean air delivered, which produces a different order.

---

## How it works

A mass balance on fine particles, solved hour by hour, per room:

```
dC/dt  =  λ·P·(C_out − C)      what leaks in from outside
        − k·C                   what settles out on its own
        − (CADR/V)·C            what a purifier removes
        + S(t)/V                cooking, coils, incense, sweeping
```

Then dose, using breathing rates that vary by what you are doing.

Attribution works the way it should: to find out what the coil costs you, the
whole day is run again without it and the difference is taken. Same for every
recommendation, so nothing on the page is a rule of thumb.

Every constant is in [`frontend/data/sources.json`](frontend/data/sources.json)
with its source and a confidence rating, because the output is an arithmetic
claim about somebody's lungs and an uncited number is an opinion with a decimal
point on it. Frying and sweeping are marked low confidence, honestly, because
they vary enormously between homes.

## Where the readings come from

Live, on every page load, from [Open-Meteo's air quality API](https://open-meteo.com/en/docs/air-quality-api).
Free, no key, no registration, CORS open so the browser fetches it directly.
It serves the CAMS global model interpolated to your coordinates, which is what
makes covering all of NCR honest: Bahadurgarh gets a number computed for
Bahadurgarh rather than Delhi's monitor speaking on its behalf.

There is no cached file and no scheduled job, deliberately. Open this in six
months and it pulls that day's readings. Nothing here can go stale.

**Hourly, not daily.** An early version hard-coded a winter inversion curve with
a dawn peak. That is right for Delhi in January and backwards in August, when
the peak is in the evening, so it would have confidently told you to ventilate
at exactly the wrong hour for half the year. Using the real hourly series means
the ventilation and workout advice is correct for the actual day.

## Running it

Nothing to install. No dependencies, no build step, no API keys.

```bash
node tests/test_engine.js          # 15 test groups
cd frontend && python3 -m http.server 8000
```

The tests check the physics against cases with a known answer rather than
against itself. A mis-signed mass balance still draws smooth, convincing curves,
so "it looks right" is worth nothing. The steady-state test compares against the
analytic ratio `λP/(λ+k)` derived on paper.

They also caught a real bug. An early version reported around **100 cigarettes a
day**, which looked entirely plausible on screen. The Berkeley Earth conversion
is 22 µg/m³ over twenty-four hours, not one hour, and this project works in
inhaled mass rather than ambient concentration. The magnitude checks now fail if
anything drifts outside a believable range.

## Layout

```
frontend/engine.js            the model, runs in the browser
frontend/app.js               interface, charts, the drifting haze
frontend/data/sources.json    emission figures, every one cited
frontend/data/purifiers.json  catalogue with five-year ownership cost
frontend/data/cities.json     all of Delhi NCR plus 30 other cities, with coordinates
tests/test_engine.js          15 groups
```

No server anywhere. The model runs in the tab, readings are fetched live, and
**your home profile never leaves your device**. It sits in browser storage. There is no account and no database, which
is the only honest way to ask someone when they cook and where they sleep.

## What it cannot know

- **Emission figures are from literature, not your kitchen.** Real homes vary
  enormously. Every source and its origin is listed in `data/sources.json`.
- **A modelled field is not a monitor on your street.** It is good at the shape
  of a city's day and approximate about your particular lane. Next to a
  construction site your real exposure is higher than any citywide figure.
- **PM2.5 only.** NO2 from gas burners, ozone and VOCs are real and not here.
- **Not medical advice.** The cigarette comparison is a device for making
  micrograms feel like something, not a clinical equivalence.
