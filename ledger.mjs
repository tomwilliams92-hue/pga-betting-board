// ledger.mjs
// The P&L track record. Tracked bets are recorded as "pending" when published, then
// settled the following week off the final leaderboard. ledger.json is the source of
// truth and is committed to git, so the record is persistent and publicly verifiable.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = path.join(__dirname, 'ledger.json');

export function loadLedger() {
  if (fs.existsSync(LEDGER)) return JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  return { bankrollStartGBP: 100, unitGBP: 5, createdAt: new Date().toISOString(), bets: [] };
}
export function saveLedger(l) { fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2)); }

// Record this week's tracked bets as pending (id keyed so re-running the same week
// updates rather than duplicates).
export function appendWeek(ledger, board) {
  for (const c of board.trackedBets) {
    const id = `${board.event.id}:${c.playerId}:${c.market}`;
    if (ledger.bets.some((b) => b.id === id)) continue;
    ledger.bets.push({
      id, weekNumber: board.bankroll.weekNumber, eventId: board.event.id, eventName: board.event.name,
      placedAt: board.generatedAt, playerId: c.playerId, player: c.name,
      market: c.market, marketLabel: c.marketLabel, eachWay: c.eachWay,
      stakePoints: c.points, stakeGBP: c.stakeGBP, priceDecimal: c.priceDecimal, priceFractional: c.priceFractional,
      modelProb: c.modelProb, status: 'pending', finishPos: null, returnGBP: null, profitGBP: null,
    });
  }
}

function gradeBet(bet, pos, cut) {
  // returns total return (£) for the stake; profit = return - stake
  const placed = (n) => Number.isFinite(pos) && pos <= n && !cut;
  if (bet.eachWay) {
    // win-market each-way: half the stake on win, half on place (top-5 at 1/5 odds)
    const side = bet.stakeGBP / 2;
    let ret = 0;
    if (Number.isFinite(pos) && pos === 1 && !cut) ret += side * bet.priceDecimal;       // win part
    if (placed(5)) ret += side * (1 + (bet.priceDecimal - 1) / 5);                        // place part
    return ret;
  }
  const need = { win: 1, top5: 5, top10: 10, top20: 20 }[bet.market];
  return placed(need) ? bet.stakeGBP * bet.priceDecimal : 0;
}

// Settle any pending bets whose event has finished. getPositions(eventId) -> Map(playerId -> {pos,cut}).
export async function settle(ledger, completedEventIds, getPositions) {
  const pending = ledger.bets.filter((b) => b.status === 'pending' && completedEventIds.has(b.eventId));
  const byEvent = {};
  for (const b of pending) (byEvent[b.eventId] ||= []).push(b);
  for (const [eventId, bets] of Object.entries(byEvent)) {
    let positions;
    try { positions = (await getPositions(eventId)).positions; } catch { continue; }
    for (const b of bets) {
      const r = positions.get(String(b.playerId));
      const pos = r?.pos ?? null, cut = r?.cut ?? true;
      const ret = gradeBet(b, pos, cut);
      b.finishPos = r?.posText || (cut ? 'MC' : 'n/a');
      b.returnGBP = Math.round(ret * 100) / 100;
      b.profitGBP = Math.round((ret - b.stakeGBP) * 100) / 100;
      b.status = b.profitGBP > 0 ? 'won' : 'lost';
    }
  }
}

export function summary(ledger) {
  const settled = ledger.bets.filter((b) => b.status === 'won' || b.status === 'lost');
  const pending = ledger.bets.filter((b) => b.status === 'pending');
  const staked = settled.reduce((a, b) => a + b.stakeGBP, 0);
  const profit = settled.reduce((a, b) => a + b.profitGBP, 0);
  const won = settled.filter((b) => b.profitGBP > 0).length;
  return {
    bankrollStartGBP: ledger.bankrollStartGBP, unitGBP: ledger.unitGBP,
    settledCount: settled.length, won, lost: settled.length - won,
    stakedGBP: Math.round(staked * 100) / 100, profitGBP: Math.round(profit * 100) / 100,
    bankrollNowGBP: Math.round((ledger.bankrollStartGBP + profit) * 100) / 100,
    roiPct: staked > 0 ? Math.round((profit / staked) * 1000) / 10 : 0,
    strikeRatePct: settled.length ? Math.round((won / settled.length) * 100) : 0,
    pendingCount: pending.length, pendingStakeGBP: pending.reduce((a, b) => a + b.stakeGBP, 0),
    history: settled.slice(-30).reverse(),
    openBets: pending.reverse(),
  };
}
