// odds-api.mjs
// Real bookmaker odds via the-odds-api.com (free tier). Returns the BEST price across UK
// books for each player and which bookmaker offers it - so the board can show a genuine
// "best price" and name the bookie. Free tier covers the WINNER (outright) market only;
// place markets (top 5/10/20) stay as model estimates.
//
// Set THE_ODDS_API_KEY in the environment to activate. Without it, this returns null and
// the build falls back to the model's estimated prices.

const KEY = process.env.THE_ODDS_API_KEY || '';
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, '').trim();

const STD = [[1,5],[1,4],[2,7],[1,3],[2,5],[4,9],[1,2],[8,15],[4,7],[8,13],[4,6],[8,11],[4,5],[5,6],[10,11],[1,1],[11,10],[5,4],[11,8],[6,4],[7,4],[15,8],[2,1],[9,4],[5,2],[11,4],[3,1],[7,2],[4,1],[9,2],[5,1],[11,2],[6,1],[13,2],[7,1],[15,2],[8,1],[9,1],[10,1],[11,1],[12,1],[14,1],[16,1],[18,1],[20,1],[22,1],[25,1],[28,1],[33,1],[40,1],[50,1],[66,1],[80,1],[100,1],[125,1],[150,1],[200,1],[250,1]];
function toFractional(decimal) {
  const t = decimal - 1; let best = STD[0], e = Infinity;
  for (const [n, d] of STD) { const err = Math.abs(n / d - t); if (err < e) { e = err; best = [n, d]; } }
  return `${best[0]}/${best[1]}`;
}

// Map the-odds-api bookmaker keys to display names + brand colours
export const BOOKIE_BRAND = {
  bet365: { name: 'bet365', bg: '#027b5b', fg: '#ffe600' },
  williamhill: { name: 'William Hill', bg: '#011e41', fg: '#ffb80c' },
  paddypower: { name: 'Paddy Power', bg: '#004833', fg: '#ffffff' },
  skybet: { name: 'Sky Bet', bg: '#0b1f6b', fg: '#ffffff' },
  betfair_ex_uk: { name: 'Betfair', bg: '#ffb80c', fg: '#1c1c1c' },
  ladbrokes_uk: { name: 'Ladbrokes', bg: '#d3151b', fg: '#ffffff' },
  coral: { name: 'Coral', bg: '#0046b3', fg: '#ffffff' },
  unibet_uk: { name: 'Unibet', bg: '#147b45', fg: '#ffffff' },
  betvictor: { name: 'BetVictor', bg: '#0a3d2a', fg: '#ffffff' },
};
const brand = (key) => BOOKIE_BRAND[key] || { name: key, bg: '#1657b0', fg: '#ffffff' };

async function listGolfSports() {
  const r = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${KEY}&all=true`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('sports list ' + r.status);
  return (await r.json()).filter((s) => /golf/i.test(s.group || '') && /winner|outright/i.test((s.title || '') + (s.key || '')));
}

// Find the sport key whose title/description matches this week's event name.
function matchSport(sports, eventName) {
  const evWords = norm(eventName).split(' ').filter((w) => w.length > 3 && !['championship', 'open', 'classic', 'tournament', 'presented'].includes(w));
  let best = null, bestScore = 0;
  for (const s of sports) {
    const hay = norm((s.title || '') + ' ' + (s.description || ''));
    const score = evWords.filter((w) => hay.includes(w)).length;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return bestScore > 0 ? best : null;
}

// Returns Map(normalisedPlayerName -> { decimal, fractional, bookieKey, bookie:{name,bg,fg} }) or null.
export async function getRealWinnerOdds(eventName) {
  if (!KEY) return null;
  try {
    const sport = matchSport(await listGolfSports(), eventName);
    if (!sport) { console.error('[odds-api] no matching golf sport for', eventName); return null; }
    const r = await fetch(`https://api.the-odds-api.com/v4/sports/${sport.key}/odds/?apiKey=${KEY}&regions=uk&markets=outrights&oddsFormat=decimal`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('odds ' + r.status);
    const events = await r.json();
    const ev = events[0];
    if (!ev) return null;
    const best = new Map(); // normName -> {decimal, bookieKey}
    for (const bk of ev.bookmakers || []) {
      for (const m of bk.markets || []) {
        if (m.key !== 'outrights') continue;
        for (const o of m.outcomes || []) {
          const k = norm(o.name);
          const cur = best.get(k);
          if (!cur || o.price > cur.decimal) best.set(k, { decimal: o.price, bookieKey: bk.key });
        }
      }
    }
    const out = new Map();
    for (const [k, v] of best) out.set(k, { decimal: v.decimal, fractional: toFractional(v.decimal), bookieKey: v.bookieKey, bookie: brand(v.bookieKey) });
    console.error(`[odds-api] real odds for ${ev.bookmakers?.length || 0} books, ${out.size} players (best-price)`);
    return out;
  } catch (e) {
    console.error('[odds-api] failed, falling back to estimates:', e.message);
    return null;
  }
}
