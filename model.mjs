// model.mjs
// Turns the raw pgatour.com data into 3 win picks + 3 outside bets.
//
// For every player in the field we build a composite rating from:
//   - course-fit strokes-gained  (SG components re-weighted to what THIS course rewards)
//   - recent form                (avg SG:Total over the last ~5 events they played)
//   - trend                      (recent SG vs season SG - are they heating up?)
//   - season quality + OWGR      (stabilisers, so thin-data names don't float up)
// The composite becomes a win probability (softmax), which becomes estimated odds.

// ---- small stats helpers --------------------------------------------------

function stats(values) {
  const v = values.filter((x) => Number.isFinite(x));
  const n = v.length || 1;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1;
  return { mean, sd };
}
const z = (x, m, s) => (Number.isFinite(x) ? (x - m) / s : null);

function softmax(scores, temp) {
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp((s - max) * temp));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

// ---- odds formatting ------------------------------------------------------

const STD_FRACTIONS = [
  [1, 1], [11, 10], [5, 4], [11, 8], [6, 4], [7, 4], [15, 8], [2, 1], [9, 4], [5, 2],
  [11, 4], [3, 1], [7, 2], [4, 1], [9, 2], [5, 1], [11, 2], [6, 1], [13, 2], [7, 1],
  [15, 2], [8, 1], [9, 1], [10, 1], [11, 1], [12, 1], [14, 1], [16, 1], [18, 1], [20, 1],
  [22, 1], [25, 1], [28, 1], [33, 1], [40, 1], [50, 1], [66, 1], [80, 1], [100, 1],
  [125, 1], [150, 1], [200, 1], [250, 1],
];

function toFractional(decimal) {
  const target = decimal - 1; // fractional value
  let best = STD_FRACTIONS[0];
  let bestErr = Infinity;
  for (const [n, d] of STD_FRACTIONS) {
    const err = Math.abs(n / d - target);
    if (err < bestErr) { bestErr = err; best = [n, d]; }
  }
  return `${best[0]}/${best[1]}`;
}

// ---- player display helpers ----------------------------------------------

const headshot = (id) =>
  `https://pga-tour-res.cloudinary.com/image/upload/c_fill,g_face:center,h_240,w_240,q_auto,f_auto/headshots_${id}.png`;

const SG_LABELS = { ott: 'off the tee', app: 'approach', arg: 'around the green', putt: 'putting' };

function describeStrengths(sg, profile) {
  // Rank the player's SG components, cross-reference what the course rewards.
  const comps = ['ott', 'app', 'arg', 'putt'].map((k) => ({ k, val: sg[k] ?? -99 }));
  const ranked = comps.filter((c) => c.val > -90).sort((a, b) => b.val - a.val);
  const tags = [];
  for (const c of ranked.slice(0, 2)) {
    if (c.val > 0.2) tags.push(`gains on ${SG_LABELS[c.k]} (+${c.val.toFixed(2)}/rd)`);
  }
  // Does their top skill line up with the course's most-weighted skill?
  const courseTop = Object.entries(profile.weights).sort((a, b) => b[1] - a[1])[0][0];
  const fitsCourse = ranked[0] && ranked[0].k === courseTop && ranked[0].val > 0.1;
  return { tags, fitsCourse, courseTop };
}

function buildRationale(p, profile) {
  const bits = [];
  const { tags, fitsCourse, courseTop } = describeStrengths(p.sg, profile);
  if (fitsCourse) {
    bits.push(`Skillset fits ${profile.course || 'the course'}: strongest on ${SG_LABELS[courseTop]}, exactly what wins here`);
  } else if (tags.length) {
    bits.push(`Form in his game: ${tags.join(', ')}`);
  }
  const starts = `${p.recentEvents} start${p.recentEvents === 1 ? '' : 's'}`;
  if (p.recentEvents > 0) {
    if (p.trend === 'up') bits.push(`trending up - recent SG ${p.recentSG.toFixed(2)}/rd over last ${starts}, above his season line`);
    else if (p.trend === 'down') bits.push(`form dipping slightly (recent SG ${p.recentSG.toFixed(2)}/rd over ${starts})`);
    else bits.push(`steady recent SG of ${p.recentSG.toFixed(2)}/rd over last ${starts}`);
  }
  // long vs straight hitter colour
  if (Number.isFinite(p.drivingDistance) && Number.isFinite(p.drivingAccuracy)) {
    if (p.drivingDistance >= 305) bits.push(`a big hitter (${Math.round(p.drivingDistance)} yds avg)`);
    else if (p.drivingAccuracy >= 65) bits.push(`an accurate driver (${p.drivingAccuracy.toFixed(0)}% fairways)`);
  }
  return bits.map((b) => b.charAt(0).toUpperCase() + b.slice(1)).join('. ') + '.';
}

// ---- the model ------------------------------------------------------------

export function buildModel({ field, profile, sg, driving, recentEvents, weekNumber, bankrollPoints = 20 }) {
  // sg: { total, ott, app, arg, putt } each a Map(playerId -> {values:{Avg:..}})
  // driving: { distance: Map, accuracy: Map }
  // recentEvents: [{ id, name, map }] most-recent-first, map = Map(playerId -> {values:{Avg}})
  const players = field.players.filter((p) => !p.amateur);

  const sgVal = (which, id) => sg[which]?.get(String(id))?.values?.Avg;

  // assemble raw per-player metrics
  const rows = players.map((p) => {
    const id = String(p.id);
    const comp = {
      total: sgVal('total', id),
      ott: sgVal('ott', id),
      app: sgVal('app', id),
      arg: sgVal('arg', id),
      putt: sgVal('putt', id),
    };
    // recent form: average EVENT_ONLY SG:Total across events the player actually played
    const recentVals = recentEvents
      .map((e) => e.map.get(id)?.values?.Avg)
      .filter((x) => Number.isFinite(x));
    const recentSG = recentVals.length ? recentVals.reduce((a, b) => a + b, 0) / recentVals.length : null;
    return {
      playerId: id,
      name: `${p.firstName} ${p.lastName}`.trim(),
      country: p.country,
      countryFlag: p.countryFlag,
      owgr: p.owgr || 999,
      headshot: headshot(id),
      sg: comp,
      drivingDistance: driving.distance?.get(id)?.values?.Avg, // statId 101 -> "Avg" yds
      drivingAccuracy: driving.accuracy?.get(id)?.values?.['%'], // statId 102 -> "%" fairways
      recentSG,
      recentEvents: recentVals.length,
      dataThin: !Number.isFinite(comp.total),
    };
  });

  // distributions for z-scoring (over players who have the data)
  const dist = {};
  for (const k of ['total', 'ott', 'app', 'arg', 'putt']) dist[k] = stats(rows.map((r) => r.sg[k]));
  const recentDist = stats(rows.map((r) => r.recentSG));
  const owgrScore = (o) => -Math.log(Math.max(1, o));
  const owgrDist = stats(rows.map((r) => owgrScore(r.owgr)));

  for (const r of rows) {
    // course-fit weighted SG (z of each component blended by course weights)
    let fit = 0;
    for (const k of ['ott', 'app', 'arg', 'putt']) {
      const zz = z(r.sg[k], dist[k].mean, dist[k].sd);
      fit += profile.weights[k] * (zz ?? -0.8); // missing component -> mild penalty
    }
    r.fitScore = fit;
    r.recentZ = z(r.recentSG, recentDist.mean, recentDist.sd) ?? -0.5;
    r.seasonZ = z(r.sg.total, dist.total.mean, dist.total.sd) ?? -0.8;
    r.owgrZ = z(owgrScore(r.owgr), owgrDist.mean, owgrDist.sd) ?? -0.5;
    // trend: recent vs season
    r.trendRaw = Number.isFinite(r.recentSG) && Number.isFinite(r.sg.total) ? r.recentSG - r.sg.total : 0;
    r.trend = r.trendRaw > 0.25 ? 'up' : r.trendRaw < -0.25 ? 'down' : 'flat';
  }
  const fitDist = stats(rows.map((r) => r.fitScore));
  const trendDist = stats(rows.map((r) => r.trendRaw));
  for (const r of rows) {
    const fitZ = z(r.fitScore, fitDist.mean, fitDist.sd) ?? 0;
    const trendZ = z(r.trendRaw, trendDist.mean, trendDist.sd) ?? 0;
    r.composite =
      0.42 * fitZ + 0.22 * r.recentZ + 0.12 * trendZ + 0.12 * r.seasonZ + 0.12 * r.owgrZ;
    if (r.dataThin) r.composite -= 0.6; // push thin-data names down; they're also flagged
  }

  // win probabilities + odds. Temperature is tuned so the favourite in a strong
  // field lands around 4/1-6/1 (i.e. ~16-20% win prob), which matches real markets.
  const probs = softmax(rows.map((r) => r.composite), 1.9);
  rows.forEach((r, i) => {
    r.winProb = probs[i];
    const decimal = Math.min(251, 1 / r.winProb);
    r.modelOdds = { decimal, fractional: toFractional(decimal) };
    r.confidence = Math.max(1, Math.min(5, Math.round(1 + (r.composite + 1.2) * 1.6)));
  });

  rows.sort((a, b) => b.composite - a.composite);
  rows.forEach((r, i) => { r.modelRank = i + 1; r.rationale = buildRationale(r, profile); });

  // selections
  const winPicks = rows.slice(0, 3);
  const outsidePicks = rows
    .filter((r) => !winPicks.includes(r) && r.modelOdds.decimal >= 26 && r.modelOdds.decimal <= 121)
    .slice(0, 3);
  // top-up if not enough in the value band
  let i = 3;
  while (outsidePicks.length < 3 && i < rows.length) {
    if (!winPicks.includes(rows[i]) && !outsidePicks.includes(rows[i])) outsidePicks.push(rows[i]);
    i++;
  }

  // staking: total stake per pick (1pt = £5), split each-way internally
  const winPts = [3, 2, 2];
  const outPts = [1, 1, 1];
  const stake = (pts) => {
    const gbp = pts * 5;
    return { points: pts, stakeGBP: gbp, ewWin: gbp / 2, ewPlace: gbp / 2 };
  };
  winPicks.forEach((p, n) => Object.assign(p, stake(winPts[n])));
  outsidePicks.forEach((p, n) => Object.assign(p, stake(outPts[n])));
  const totalPts = [...winPts.slice(0, winPicks.length), ...outPts.slice(0, outsidePicks.length)].reduce((a, b) => a + b, 0);

  return {
    winPicks,
    outsidePicks,
    fieldRanking: rows.slice(0, 15),
    ewTerms: '5 places at 1/5 odds (Bet365 often enhances places for these events - check before betting)',
    bankroll: { startPoints: bankrollPoints, startGBP: bankrollPoints * 5, unitGBP: 5, stakedThisWeekPoints: totalPts, stakedThisWeekGBP: totalPts * 5, weekNumber },
  };
}
