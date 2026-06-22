// model.mjs
// Turns raw pgatour.com data into picks across multiple markets.
//
// Per player we build a composite rating from:
//   - course-fit strokes-gained  (SG re-weighted to what THIS course rewards)
//   - recent form                (avg SG:Total over the last ~5 events they played)
//   - trend                      (recent SG vs season SG - heating up?)
//   - season quality + OWGR      (stabilisers)
// then apply a POST-EVENT LET-DOWN adjustment (the major/winner hangover), and finally
// run a Monte Carlo simulation of the tournament to get calibrated Win / Top-5 / Top-10 /
// Top-20 probabilities -> estimated odds for every market.

// ---- stats helpers --------------------------------------------------------

function stats(values) {
  const v = values.filter((x) => Number.isFinite(x));
  const n = v.length || 1;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1;
  return { mean, sd };
}
const z = (x, m, s) => (Number.isFinite(x) ? (x - m) / s : null);
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, '').trim();

// ---- odds formatting (covers odds-on for place markets) -------------------

const STD_FRACTIONS = [
  [1, 5], [1, 4], [2, 7], [1, 3], [2, 5], [4, 9], [1, 2], [8, 15], [4, 7], [8, 13], [4, 6],
  [8, 11], [4, 5], [5, 6], [10, 11], [1, 1], [11, 10], [5, 4], [11, 8], [6, 4], [7, 4], [15, 8],
  [2, 1], [9, 4], [5, 2], [11, 4], [3, 1], [7, 2], [4, 1], [9, 2], [5, 1], [11, 2], [6, 1],
  [13, 2], [7, 1], [15, 2], [8, 1], [9, 1], [10, 1], [11, 1], [12, 1], [14, 1], [16, 1], [18, 1],
  [20, 1], [22, 1], [25, 1], [28, 1], [33, 1], [40, 1], [50, 1], [66, 1], [80, 1], [100, 1],
  [125, 1], [150, 1], [200, 1], [250, 1],
];
function toFractional(decimal) {
  const target = decimal - 1;
  let best = STD_FRACTIONS[0], bestErr = Infinity;
  for (const [n, d] of STD_FRACTIONS) {
    const err = Math.abs(n / d - target);
    if (err < bestErr) { bestErr = err; best = [n, d]; }
  }
  return `${best[0]}/${best[1]}`;
}
function marketOdds(prob) {
  const p = Math.max(1 / 251, Math.min(0.96, prob));
  const decimal = 1 / p;
  return { prob, decimal, fractional: toFractional(decimal) };
}

// ---- player display helpers ----------------------------------------------

const headshot = (id) =>
  `https://pga-tour-res.cloudinary.com/image/upload/c_fill,g_face:center,h_240,w_240,q_auto,f_auto/headshots_${id}.png`;
const SG_LABELS = { ott: 'off the tee', app: 'approach', arg: 'around the green', putt: 'putting' };

function describeStrengths(sg, profile) {
  const comps = ['ott', 'app', 'arg', 'putt'].map((k) => ({ k, val: sg[k] ?? -99 }));
  const ranked = comps.filter((c) => c.val > -90).sort((a, b) => b.val - a.val);
  const tags = [];
  for (const c of ranked.slice(0, 2)) if (c.val > 0.2) tags.push(`gains on ${SG_LABELS[c.k]} (+${c.val.toFixed(2)}/rd)`);
  const courseTop = Object.entries(profile.weights).sort((a, b) => b[1] - a[1])[0][0];
  const fitsCourse = ranked[0] && ranked[0].k === courseTop && ranked[0].val > 0.1;
  return { tags, fitsCourse, courseTop };
}
function buildRationale(p, profile) {
  const bits = [];
  const { tags, fitsCourse, courseTop } = describeStrengths(p.sg, profile);
  if (fitsCourse) bits.push(`skillset fits ${profile.course || 'the course'}: strongest on ${SG_LABELS[courseTop]}, exactly what wins here`);
  else if (tags.length) bits.push(`form in his game: ${tags.join(', ')}`);
  const starts = `${p.recentEvents} start${p.recentEvents === 1 ? '' : 's'}`;
  if (p.recentEvents > 0) {
    if (p.trend === 'up') bits.push(`trending up - recent SG ${p.recentSG.toFixed(2)}/rd over last ${starts}, above his season line`);
    else if (p.trend === 'down') bits.push(`form dipping slightly (recent SG ${p.recentSG.toFixed(2)}/rd over ${starts})`);
    else bits.push(`steady recent SG of ${p.recentSG.toFixed(2)}/rd over last ${starts}`);
  }
  if (Number.isFinite(p.drivingDistance) && Number.isFinite(p.drivingAccuracy)) {
    if (p.drivingDistance >= 305) bits.push(`a big hitter (${Math.round(p.drivingDistance)} yds avg)`);
    else if (p.drivingAccuracy >= 65) bits.push(`an accurate driver (${p.drivingAccuracy.toFixed(0)}% fairways)`);
  }
  return bits.map((b) => b.charAt(0).toUpperCase() + b.slice(1)).join('. ') + '.';
}

// ---- post-event let-down (major / winner hangover) ------------------------
// The week after a draining major, last week's winner and contenders rarely
// back up. We dock their composite and flag it so it's transparent.
// Winner hangover is the strongest, best-documented effect; contender fatigue is milder
// so the genuine elite aren't over-faded just for being in contention.
const LETDOWN = { majorWinner: 0.42, majorTop5: 0.20, majorTop15: 0.09, regularWinner: 0.20 };

function applyLetdown(rows, prev) {
  if (!prev || !prev.name) return;
  const champ = prev.champion ? norm(prev.champion) : null;
  // rank field players by how they struck it in last week's event (SG proxy for contention)
  const present = rows
    .map((r) => ({ r, sg: prev.sgMap?.get(r.playerId)?.values?.Avg }))
    .filter((x) => Number.isFinite(x.sg))
    .sort((a, b) => b.sg - a.sg);
  present.forEach((x, i) => { x.r._prevRank = i + 1; });

  for (const r of rows) {
    let penalty = 0, flag = null;
    if (champ && norm(r.name) === champ) {
      penalty = prev.isMajor ? LETDOWN.majorWinner : LETDOWN.regularWinner;
      flag = prev.isMajor ? `Won the ${prev.name} last week - winners almost never back up the next week` : `Won last week - watch for a winner's let-down`;
    } else if (prev.isMajor && r._prevRank) {
      if (r._prevRank <= 5) { penalty = LETDOWN.majorTop5; flag = `Contended at the ${prev.name} (major) last week - fatigue/hangover risk`; }
      else if (r._prevRank <= 15) { penalty = LETDOWN.majorTop15; flag = `Played the ${prev.name} last week - mild fatigue watch`; }
    }
    if (penalty > 0) { r.composite -= penalty; r.letdownPenalty = penalty; r.letdownFlag = flag; }
  }
}

// ---- Monte Carlo: simulate the event for place-market probabilities -------
const T_SIM = 1.65; // spread of player strengths (tuned so the favourite ~20% to win)
const gumbel = () => -Math.log(-Math.log(Math.random()));

function simulate(rows, N = 20000) {
  const n = rows.length;
  const c1 = new Array(n).fill(0), c5 = new Array(n).fill(0), c10 = new Array(n).fill(0), c20 = new Array(n).fill(0);
  const perf = new Array(n), idx = new Array(n);
  for (let s = 0; s < N; s++) {
    for (let i = 0; i < n; i++) { perf[i] = T_SIM * rows[i].composite + gumbel(); idx[i] = i; }
    idx.sort((a, b) => perf[b] - perf[a]);
    for (let r = 0; r < n; r++) {
      const p = idx[r];
      if (r < 1) c1[p]++; if (r < 5) c5[p]++; if (r < 10) c10[p]++; if (r < 20) c20[p]++;
    }
  }
  rows.forEach((row, i) => {
    row.winProb = c1[i] / N; row.p5 = c5[i] / N; row.p10 = c10[i] / N; row.p20 = c20[i] / N;
    row.win = marketOdds(row.winProb); row.t5 = marketOdds(row.p5);
    row.t10 = marketOdds(row.p10); row.t20 = marketOdds(row.p20);
  });
}

// ---- the model ------------------------------------------------------------

export function buildModel({ field, profile, sg, driving, recentEvents, previousEvent, weekNumber, bankrollPoints = 20 }) {
  const players = field.players.filter((p) => !p.amateur);
  const sgVal = (which, id) => sg[which]?.get(String(id))?.values?.Avg;

  const rows = players.map((p) => {
    const id = String(p.id);
    const comp = { total: sgVal('total', id), ott: sgVal('ott', id), app: sgVal('app', id), arg: sgVal('arg', id), putt: sgVal('putt', id) };
    const recentVals = recentEvents.map((e) => e.map.get(id)?.values?.Avg).filter((x) => Number.isFinite(x));
    const recentSG = recentVals.length ? recentVals.reduce((a, b) => a + b, 0) / recentVals.length : null;
    return {
      playerId: id, name: `${p.firstName} ${p.lastName}`.trim(), country: p.country, countryFlag: p.countryFlag,
      owgr: p.owgr || 999, headshot: headshot(id), sg: comp,
      drivingDistance: driving.distance?.get(id)?.values?.Avg,
      drivingAccuracy: driving.accuracy?.get(id)?.values?.['%'],
      recentSG, recentEvents: recentVals.length, dataThin: !Number.isFinite(comp.total),
    };
  });

  const dist = {};
  for (const k of ['total', 'ott', 'app', 'arg', 'putt']) dist[k] = stats(rows.map((r) => r.sg[k]));
  const recentDist = stats(rows.map((r) => r.recentSG));
  const owgrScore = (o) => -Math.log(Math.max(1, o));
  const owgrDist = stats(rows.map((r) => owgrScore(r.owgr)));

  for (const r of rows) {
    let fit = 0;
    for (const k of ['ott', 'app', 'arg', 'putt']) fit += profile.weights[k] * (z(r.sg[k], dist[k].mean, dist[k].sd) ?? -0.8);
    r.fitScore = fit;
    r.recentZ = z(r.recentSG, recentDist.mean, recentDist.sd) ?? -0.5;
    r.seasonZ = z(r.sg.total, dist.total.mean, dist.total.sd) ?? -0.8;
    r.owgrZ = z(owgrScore(r.owgr), owgrDist.mean, owgrDist.sd) ?? -0.5;
    r.trendRaw = Number.isFinite(r.recentSG) && Number.isFinite(r.sg.total) ? r.recentSG - r.sg.total : 0;
    r.trend = r.trendRaw > 0.25 ? 'up' : r.trendRaw < -0.25 ? 'down' : 'flat';
  }
  const fitDist = stats(rows.map((r) => r.fitScore));
  const trendDist = stats(rows.map((r) => r.trendRaw));
  for (const r of rows) {
    const fitZ = z(r.fitScore, fitDist.mean, fitDist.sd) ?? 0;
    const trendZ = z(r.trendRaw, trendDist.mean, trendDist.sd) ?? 0;
    r.composite = 0.42 * fitZ + 0.22 * r.recentZ + 0.12 * trendZ + 0.12 * r.seasonZ + 0.12 * r.owgrZ;
    if (r.dataThin) r.composite -= 0.6;
  }

  applyLetdown(rows, previousEvent);
  simulate(rows);

  for (const r of rows) {
    r.confidence = Math.max(1, Math.min(5, Math.round(1 + r.winProb * 16)));
    r.rationale = buildRationale(r, profile);
    r.ewValue = r.winProb > 0 ? r.p5 / r.winProb : 0; // places far more often than wins = e/w value
  }

  const byWin = [...rows].sort((a, b) => b.winProb - a.winProb);
  byWin.forEach((r, i) => { r.modelRank = i + 1; });

  // --- selections ---
  const winPicks = byWin.slice(0, 3);
  const outsidePicks = byWin.filter((r) => !winPicks.includes(r) && r.win.decimal >= 26 && r.win.decimal <= 121).slice(0, 3);
  let i = 3; while (outsidePicks.length < 3 && i < byWin.length) { if (!winPicks.includes(byWin[i])) outsidePicks.push(byWin[i]); i++; }

  // Best Bet of the week: blend likelihood, form and each-way value/price
  const wD = stats(byWin.slice(0, 30).map((r) => r.winProb));
  const tD = stats(byWin.slice(0, 30).map((r) => r.trendRaw));
  const eD = stats(byWin.slice(0, 30).map((r) => r.ewValue));
  let bestBet = null, bestScore = -Infinity;
  for (const r of byWin.slice(0, 25)) {
    const score = 0.50 * (z(r.winProb, wD.mean, wD.sd) ?? 0) + 0.20 * (z(r.trendRaw, tD.mean, tD.sd) ?? 0) + 0.30 * (z(r.ewValue, eD.mean, eD.sd) ?? 0);
    if (score > bestScore && !r.letdownPenalty) { bestScore = score; bestBet = r; }
  }

  // Each-way value: strong place chance at a real price
  const eachWayValue = byWin.filter((r) => r.win.decimal >= 14 && r.p5 >= 0.12).sort((a, b) => b.ewValue - a.ewValue).slice(0, 4);

  const topBy = (key, k) => [...rows].sort((a, b) => b[key] - a[key]).slice(0, k);
  const placesTable = byWin.slice(0, 18);

  // world rankings reference (this week's field, by OWGR)
  const worldRankings = rows.filter((r) => r.owgr < 999).sort((a, b) => a.owgr - b.owgr)
    .map((r) => ({ owgr: r.owgr, name: r.name, country: r.countryFlag || r.country, headshot: r.headshot, winOdds: r.win.fractional, winProb: r.winProb }));

  // staking
  const winPts = [3, 2, 2], outPts = [1, 1, 1];
  const stake = (pts) => ({ points: pts, stakeGBP: pts * 5, ewWin: pts * 5 / 2, ewPlace: pts * 5 / 2 });
  winPicks.forEach((p, n) => Object.assign(p, stake(winPts[n])));
  outsidePicks.forEach((p, n) => Object.assign(p, stake(outPts[n])));
  const totalPts = winPts.slice(0, winPicks.length).reduce((a, b) => a + b, 0) + outPts.slice(0, outsidePicks.length).reduce((a, b) => a + b, 0);

  return {
    winPicks, outsidePicks, bestBet, eachWayValue,
    top5Sel: topBy('p5', 5), top10Sel: topBy('p10', 6), top20Sel: topBy('p20', 8),
    placesTable, fieldRanking: byWin.slice(0, 15), worldRankings,
    ewTerms: '5 places at 1/5 odds (Bet365 often enhances places for these events - check before betting)',
    bankroll: { startPoints: bankrollPoints, startGBP: bankrollPoints * 5, unitGBP: 5, stakedThisWeekPoints: totalPts, stakedThisWeekGBP: totalPts * 5, weekNumber },
  };
}
