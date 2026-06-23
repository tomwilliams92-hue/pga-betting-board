// player-notes.mjs
// The qualitative layer the numbers model can't see: injuries, withdrawals, returns
// from layoff, swing changes, personal circumstances. Update this each week from the
// news. Keyed by player name (accents/case-insensitive).
//   adjust = added to the model composite (negative downgrades; ~0.5 is a big move)
//   tag    = short flag shown on the card
//   note   = the sentence that appears in the write-up
//
// Always date the note so stale ones are easy to spot and clear.

export const PLAYER_NOTES = {
  'jake knapp': {
    adjust: -0.9, tag: 'Injury doubt',
    note: 'Returning from a thumb sprain that forced three straight withdrawals, including the PGA Championship (as of late June 2026). Elite when fit - 3rd in SG: Total this season - but until he completes a full tournament he is a back-with-caution, not a confident play.',
  },
};

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, '').trim();
export function noteFor(name) {
  return PLAYER_NOTES[norm(name)] || null;
}
