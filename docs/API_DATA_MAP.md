# API_DATA_MAP.md — Flux date API-Football → DB (audit, 2026-06)

> Harta completă: ce trimite API-Football → unde aterizează → ce ARUNCĂM → ce
> salvăm fără să folosim. Read-only. Câmpurile NEPROCESATE = ⚠️ ARUNCAT.

## A) INVENTAR ENDPOINT-URI (cine cheamă · frecvență)

| Endpoint | Apelat de (file) | Frecvență |
|---|---|---|
| `/fixtures?live=all` | football.js, generator.js | scanner intern (2-10s) |
| `/fixtures?date=&status=NS` | today.js | cron pre-meci (azi+2) |
| `/fixtures?date=&status=FT-AET-PEN` | collect-finished.js | cron 23:00 |
| `/fixtures?team=&last=N&status=FT` | football.js, enrich.js, match.js, collect-national-history.js | per-meci/enrich |
| `/fixtures?id=` | match.js, update-results.js, backfill-stats-api(șters) | per-meci |
| `/fixtures?team=&season=` | extract-team.js, collect-wc-qualifiers.js | manual/sezonier |
| `/fixtures/statistics?fixture=` | collect-finished.js, match.js, generator.js, backfill.js | cron + per-meci |
| `/fixtures/events?fixture=` | collect-finished.js, match.js, backfill.js | cron + per-meci |
| `/fixtures/lineups?fixture=` | match.js (+ enrich citește din prematch_data) | per-meci |
| `/fixtures/players?fixture=` | collect-finished.js, match.js, backfill.js | cron + per-meci |
| `/fixtures/headtohead?h2h=` | football.js, enrich.js, match.js | per-meci |
| `/odds?fixture=&bookmaker=8` | collect-finished.js, match.js | cron + per-meci |
| `/odds?league=&season=` | match.js | per-meci (fallback) |
| `/standings?league=&season=` | collect-daily.js, extract-team.js, collect-wc-qualifiers.js | cron 06:00 |
| `/injuries?fixture=` | enrich.js | per-enrich |
| `/predictions?fixture=` | prematch-enrichment.js | cron */5 |
| `/players?team=&season=&page=` | collect-players-season, backfill-players, backfill-pass-shots | cron/backfill |
| `/players/topscorers`, `/topassists` | collect-top-scorers.js | cron 01:00 |
| `/players/squads?team=` | collect-squads.js | cron 02:05 |
| `/coachs?team=` | collect-coaches.js | cron 03:45 |
| `/teams?id=`, `/teams/statistics` | extract-team.js | manual |
| `/leagues?id=`/`?team=` | season.js, extract-team.js, collect-daily.js | cron/util |

## B) MAPARE CÂMP → DESTINAȚIE (endpoint cu endpoint)

### /fixtures (& live=all)
| Câmp API | Destinație | Note |
|---|---|---|
| fixture.id | fixtures/fixtures_history.fixture_id | PK |
| fixture.date | .match_date | |
| fixture.referee | fixtures_history.referee | ⚠️ NU se ia la NS/live (doar backfill) |
| fixture.status.short/long | .status_short/long | |
| fixture.status.elapsed | (live, în payload UI) | NU persistat în fixtures |
| fixture.status.extra | — | ⚠️ ARUNCAT (minute prelungiri) |
| fixture.periods.first/second | — | ⚠️ ARUNCAT |
| fixture.venue.id/name/city | (din /teams → venues) | parțial |
| fixture.timestamp/timezone | — | ⚠️ ARUNCAT |
| league.id/name/country/season/round | fixtures.league_id/.../round | logo/flag → leagues |
| teams.home/away.id/name/logo | fixtures(_history).*team_id/name + teams.logo | ✅ (FIX recent) |
| teams.home/away.winner | — | ⚠️ ARUNCAT (derivabil) |
| goals.home/away | .home_goals/away_goals | |
| score.halftime.home/away | fixtures_history.home_ht/away_ht | |
| score.fulltime/extratime/penalty | — | ⚠️ ARUNCAT (penalty shootout!) |

### /fixtures/statistics (per echipă, statistics[]{type,value})
| type API | match_stats.coloană | Folosit ML? |
|---|---|---|
| Shots on Goal | shots_on_goal | ✅ (sot_avg) |
| Total Shots | shots_total | parțial |
| Blocked Shots | blocked_shots | ⚠️ salvat-nefolosit |
| Shots insidebox | shots_insidebox | ✅ (insidebox_avg) |
| Shots outsidebox | shots_outsidebox | ⚠️ salvat-nefolosit |
| Fouls | fouls | ✅ (fouls_avg) |
| Corner Kicks | corner_kicks | ✅ (corners_avg) |
| Offsides | offsides | ⚠️ salvat-nefolosit |
| Ball Possession | ball_possession | ✅ (possession_avg) |
| Yellow/Red Cards | yellow_cards/red_cards | ✅ (yc/rc_avg) |
| Goalkeeper Saves | goalkeeper_saves | ⚠️ salvat-nefolosit |
| Total passes/Passes accurate/Passes % | total_passes/passes_accurate/pass_percentage | ⚠️ salvat-nefolosit |
| **expected_goals** | expected_goals | ✅ (xg_avg) |
| **goals_prevented** (xG against) | — | ⚠️ **ARUNCAT** (xG defensiv!) |

### /fixtures/events
| Câmp | Destinație | Note |
|---|---|---|
| time.elapsed/extra | match_events.elapsed/elapsed_extra | |
| team.id/name | .team_id/team_name | |
| player.id/name, assist.id/name | .player_id/name, assist_id/name | |
| type/detail/comments | .type/detail/comments | ✅ (goluri/cartonașe/subst) |

### /fixtures/lineups
| Câmp | Destinație | Note |
|---|---|---|
| formation | — | ⚠️ **ARUNCAT** (4-3-3 etc.) |
| startXI[].player.id | folosit TRANZITORIU (getLineupStrengthFactor) | NU persistat |
| startXI[].player.pos/grid/number | — | ⚠️ ARUNCAT (poziții pe teren) |
| substitutes[] | — | ⚠️ ARUNCAT |
| coach.id/name | (din /coachs → coaches) | separat |

### /fixtures/players (per jucător, statistics[])
| Câmp API | player_stats.coloană | Folosit? |
|---|---|---|
| games.rating | rating | ✅ (getTeamStrengths) |
| games.minutes/number/position | minutes_played/position | parțial |
| goals.total/assists | goals/assists | ✅ |
| shots.total/on | shots_total/shots_on_target | ✅ (sot) |
| passes.total/accuracy | passes_total/pass_accuracy | ✅ (passAcc) |
| passes.key | key_passes | ⚠️ salvat-nefolosit |
| dribbles.success | dribbles_success | ⚠️ salvat-nefolosit |
| tackles.total | tackles | ⚠️ salvat-nefolosit |
| duels.total/won | — | ⚠️ ARUNCAT |
| fouls.drawn/committed | — | ⚠️ ARUNCAT |
| cards.yellow/red | yellow_cards/red_cards | parțial |
| penalty.won/scored/missed/saved | — | ⚠️ ARUNCAT |
| games.captain/substitute | — | ⚠️ ARUNCAT |

### /odds (bookmakers[].bets[].values[])
| Câmp | Destinație | Note |
|---|---|---|
| bookmakers[].bets[].values[].value/odd | odds (fixture_id, bookmaker_id, bet_id, value_name, value) | doar bookmaker 8 (Bet365) la colectare; restul ⚠️ ARUNCAT |

### /standings
| Câmp | Destinație | Folosit? |
|---|---|---|
| rank/team/points/goalsDiff | standings.rank/team_id/points/goals_diff | ✅ (poziție) |
| all.played/win/draw/lose/goals | standings.played/win/draw/lose/goals_for/against | ✅ (form) |
| home/away splits | — | ⚠️ ARUNCAT (formă acasă/deplasare!) |
| form (WWDLW) | standings.form | parțial |
| status/description | standings.status/description | salvat-nefolosit |

### /injuries
| Câmp | Destinație | Folosit? |
|---|---|---|
| player.id/name/type/reason | injuries.player_id/name/type/reason | ✅ (enrich injury factor) |

### /predictions (API-Football propriile probabilități!)
| Câmp | Destinație | Folosit? |
|---|---|---|
| predictions.percent.home/draw/away | predictions.api_home_pct/api_draw_pct/api_away_pct | ✅ capturat (afișare/comparație) |
| predictions.advice | — | ⚠️ ARUNCAT |
| predictions.winner / under_over / goals | — | ⚠️ ARUNCAT |
| comparison (att/def/form/h2h/poisson %) | — | ⚠️ **ARUNCAT** (features gata-calculate!) |
| teams.last_5 / league avg | — | ⚠️ ARUNCAT |

### /teams (+ venue)
| Câmp | Destinație | Folosit? |
|---|---|---|
| team.id/name/code/country/founded/national/logo | teams.* | ✅ |
| venue.id/name/city/capacity/surface/image/lat/long | venues.* | lat/long ✅ (meteo); capacity/surface ⚠️ salvat-nefolosit |

---

## C) AUR ARUNCAT (ordonat după valoare ML; cost de salvare)

1. **/predictions `comparison` + advice** — API-Football trimite DEJA (în payload-ul
   pe care-l cerem la prematch-enrichment) procente att/def/form/h2h/poisson per
   echipă + sfat. **Cost: ZERO apeluri noi** (vine în răspuns), doar coloane/tabel
   nou. Features gata-calculate, direct utilizabile.
2. **Lineups: formation + grid (poziții)** — /fixtures/lineups e DEJA cerut (match.js).
   Formația (4-3-3 vs 5-3-2) + pozițiile sunt semnal tactic puternic. **Cost: tabel
   `match_lineups` (formation, startXI json), zero apeluri noi.**
3. **goals_prevented (xG defensiv) din /fixtures/statistics** — vine alături de
   expected_goals pe care-l salvăm deja. **Cost: 1 coloană în match_stats, zero apeluri.**
4. **Per-jucător: duels won, fouls drawn/committed, penalty, key_passes/dribbles/
   tackles (deja salvate parțial)** — /fixtures/players DEJA cerut. **Cost: coloane în
   player_stats (unele există, nefolosite), zero apeluri.** Valoare: intensitate/disciplină.
5. **Standings home/away splits** — formă acasă vs deplasare per echipă. /standings DEJA
   cerut. **Cost: coloane în standings (played_home/away, goals_home/away), zero apeluri.**
   (Bonus: score.penalty shootout, fixture.status.extra, teams.winner — ieftine, valoare mică.)

---

## D) SALVAT DAR NEFOLOSIT (corelat cu SCHEMA.md)

- **match_stats:** blocked_shots, shots_outsidebox, offsides, goalkeeper_saves,
  total_passes, passes_accurate, pass_percentage — populate, necitite de features ML
  (enrich folosește doar sot/corners/xg/yc/rc/fouls/insidebox/possession).
- **player_stats:** key_passes, dribbles_success, tackles, passes_total — populate,
  necitite (getTeamStrengths folosește doar rating/goals/passAcc/sot).
- **venues:** capacity, surface — populate, necitite ca features (doar lat/long pt meteo).
- **standings:** status, description — populate, necitite.
- **Tabele cu 1 consumator** (din SCHEMA.md): top_assists, coach_stats, coach_career,
  prematch_enrichment_log — ROI mic de colectare.

> Verifică completitudinea reală per meci cu `scripts/verify-data-flow.sh <fixture_id>`.
