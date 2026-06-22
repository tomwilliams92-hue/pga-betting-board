# PGA Betting Board

A weekly betting board for the upcoming PGA Tour event (Thursday-Sunday). Every Monday it
pulls live data from pgatour.com, ranks the field, and publishes **3 picks to win** and
**3 outside bets** with estimated each-way odds, points stakes, and the reasoning behind each.

## What drives the picks
For every player in the field the model blends:

| Signal | Weight | Source |
|---|---|---|
| **Course-fit strokes-gained** | 42% | SG components re-weighted to what the course rewards |
| **Recent form** | 22% | avg SG:Total over the last 5 events they played |
| **Trend** | 12% | recent SG vs season SG (heating up or cooling off) |
| **Season quality** | 12% | season SG:Total |
| **World ranking** | 12% | OWGR (stabiliser) |

The **course fit** is the key idea: a short, scoreable course (e.g. TPC River Highlands)
lifts approach play and putting and discounts raw distance, so straight, accurate scorers
rise; a links or a bomber's track shifts the weighting the other way. Course profiles live
in `course-profiles.mjs` - add or tune one per event there.

The composite rating becomes a win probability (softmax), which becomes the estimated odds.

## Files
| File | What it is |
|---|---|
| `index.html` | The board (open in a browser, or share the hosted link) |
| `data.js` | The picks the board reads - rewritten by the build |
| `pga-api.mjs` | GraphQL client for pgatour.com (auto-manages the API key) |
| `course-profiles.mjs` | Per-course skill weighting + descriptions |
| `model.mjs` | The picks engine (ranking, odds, staking) |
| `build.mjs` | Pulls the data, runs the model, writes `data.js` |
| `weekly-update.sh` | Monday job: rebuild + commit + push |
| `com.pga.board.update.plist` | launchd schedule (Mondays 07:05) |

## Run it by hand
```bash
node build.mjs                 # this week's next event
node build.mjs R2026034        # force a specific tournament id
```
No login or API key needed: pgatour.com authenticates with a key embedded in its own
site, which this reads and refreshes automatically. If the site ever rotates it, the next
run re-extracts a fresh one (see `pga-api.mjs`).

## Odds
Odds are **model estimates** (fair price from win probability) for now. pgatour.com also
serves real bookmaker odds (`oddsTable` query) which populate mid-week once books price the
event up - those can be layered in alongside the model price later.

## Schedule the weekly update (launchd)
```bash
cp com.pga.board.update.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.pga.board.update.plist
```
Same pattern as Conwy Choppers. Runs every Monday at 07:05 and pushes the new board.

## Hosting (shareable link)
Not set up yet - needs a GitHub repo with Pages enabled. Once that exists, `weekly-update.sh`
commits and pushes the board each Monday and the link updates itself.

---
For entertainment only. 18+, bet responsibly, begambleaware.org.
