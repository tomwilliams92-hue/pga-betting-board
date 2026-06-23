// deepdive.mjs
// The "skill" for the picks: a fixed, value-first methodology applied by Claude
// (claude-opus-4-8) every week. The numeric work (strokes-gained, simulation, odds,
// edges) is done in code; Claude acts as the analyst - selecting the best-VALUE bets from
// the candidate set and writing the reasoning. Same methodology each week = consistent,
// defensible picks that don't drift.
//
// Activated by ANTHROPIC_API_KEY in the environment. Without it (or on any error) this
// returns null and build.mjs falls back to the deterministic algorithmic selection.

const MODEL = 'claude-opus-4-8';

const METHODOLOGY = `You are the analyst for a PGA Tour value-betting board. You are given the full field for this week's event with, per player: strokes-gained splits, recent form, last week's finish, world ranking, any injury/news note, and for each market (win, top5, top10, top20) the model's probability, the best available market price, and the resulting value edge (model probability vs the price-implied probability).

Your job is to choose the bets, ranked by VALUE, and write the reasoning. Follow this methodology exactly and identically every week:

1. VALUE IS PRIMARY. Only back a selection where the model's probability is meaningfully higher than the market price implies (positive edge). A strong player at no value is not a bet. A weaker player at a generous price can be. Rank candidates by edge, tempered by how reliable that edge is (bigger sample of recent starts, clearer course fit = more reliable).
2. COURSE FIT and FORM are the why behind the edge - reference the specific strokes-gained strengths that suit this course, and recent trajectory.
3. INJURIES / NEWS OVERRIDE THE NUMBERS. Never back a player flagged with an injury doubt; mention them only on the watchlist.
4. EACH-WAY TO WIN: include exactly one outright win bet, and it must be a bigger-priced contender (roughly 16/1 to 60/1) with a strong place chance - NOT the favourite. Each-way pays the place part at 1/5, so the value is in players who place far more often than they win. A short-priced favourite is poor each-way value; do not pick one as the each-way-to-win bet.
5. TRACKED BETS: choose 5 value bets across the place markets (top5/top10/top20) PLUS the one each-way-to-win bet (6 total). Assign each a stake of 1-3 points by conviction (strongest edge = 3). Keep total staked around 8-12 points.
6. BEST BET: the single highest-conviction value selection from the tracked bets.
7. FLUTTERS (untracked, just for fun): 2 picks - a favourite to win and a big longshot - that are NOT value but are fun. Mark them clearly.
8. WATCHLIST: 4-5 players to monitor (improving form, injured, or good but no value this week), with a one-line why.

Write each story as a real, specific narrative (2-3 sentences): the player's situation, why the course and form fit, and the value. No generic filler. Use the player's actual numbers. Be honest - if a pick is marginal, say so.

Return ONLY the structured object. Use the exact playerId values provided.`;

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['trackedBets', 'bestBet', 'flutters', 'watchlist'],
  properties: {
    trackedBets: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['playerId', 'market', 'stakePoints', 'eachWayToWin', 'story'],
        properties: {
          playerId: { type: 'string' },
          market: { type: 'string', enum: ['win', 'top5', 'top10', 'top20'] },
          stakePoints: { type: 'integer' },
          eachWayToWin: { type: 'boolean' },
          story: { type: 'string' },
        },
      },
    },
    bestBet: {
      type: 'object', additionalProperties: false, required: ['playerId', 'market'],
      properties: { playerId: { type: 'string' }, market: { type: 'string', enum: ['win', 'top5', 'top10', 'top20'] } },
    },
    flutters: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['playerId', 'market', 'kind', 'story'],
        properties: { playerId: { type: 'string' }, market: { type: 'string', enum: ['win', 'top5', 'top10', 'top20'] }, kind: { type: 'string' }, story: { type: 'string' } },
      },
    },
    watchlist: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['playerId', 'why'], properties: { playerId: { type: 'string' }, why: { type: 'string' } } },
    },
  },
};

export async function runDeepDive({ event, courseProfile, previousEvent, players }) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  let Anthropic;
  try { ({ default: Anthropic } = await import('@anthropic-ai/sdk')); }
  catch { console.error('[deepdive] @anthropic-ai/sdk not installed - run npm install'); return null; }

  try {
    const client = new Anthropic();
    const payload = {
      event: { name: event.name, course: courseProfile.course, par: courseProfile.par, yards: courseProfile.yards },
      courseProfile: { archetype: courseProfile.archetype, summary: courseProfile.summary, weights: courseProfile.weights },
      previousEvent: previousEvent ? { name: previousEvent.name, isMajor: previousEvent.isMajor, champion: previousEvent.champion } : null,
      players,
    };
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 12000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
      system: METHODOLOGY,
      messages: [{ role: 'user', content: 'Here is this week\'s field and the model output. Choose the value bets and write the reasoning.\n\n' + JSON.stringify(payload) }],
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') { console.error('[deepdive] refused'); return null; }
    const text = msg.content.find((b) => b.type === 'text')?.text;
    const parsed = JSON.parse(text);
    console.error('[deepdive] Claude selected', parsed.trackedBets?.length, 'tracked bets');
    return parsed;
  } catch (e) {
    console.error('[deepdive] failed, falling back to algorithmic picks:', e.message);
    return null;
  }
}
