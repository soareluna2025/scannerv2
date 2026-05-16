# AlohaScan — Admin Access

## Dashboard

```
http://192.248.183.230:3000/admin
```

Introdu API key în câmpul din header și apasă **Conectare**.
Key-ul se salvează în localStorage (nu e trimis nicăieri altundeva).

---

## Endpoint-uri disponibile

Toate necesită header: `X-Api-Key: <ADMIN_API_KEY din .env>`

| Method | Path | Descriere |
|--------|------|-----------|
| GET | `/api/admin/status` | Node.js, uptime, memorie, DB, variabile ENV |
| GET | `/api/admin/db-stats` | Număr rânduri per tabelă |
| GET | `/api/admin/api-usage` | Apeluri API-Football azi + quota |
| GET | `/api/admin/live-matches` | Meciuri live din match_snapshots |
| GET | `/api/admin/cron-status` | Ultima rulare + status fiecare cron |
| GET | `/api/admin/errors` | Ultimele 50 erori din cron_logs |
| GET | `/api/admin/access-log` | Log acces admin (ultimele 50) |
| POST | `/api/admin/trigger-cron` | Declanșează manual un cron job |

---

## Exemple curl

```bash
# Status sistem
curl -H "X-Api-Key: YOUR_KEY" http://192.248.183.230:3000/api/admin/status

# DB stats
curl -H "X-Api-Key: YOUR_KEY" http://192.248.183.230:3000/api/admin/db-stats

# API usage
curl -H "X-Api-Key: YOUR_KEY" http://192.248.183.230:3000/api/admin/api-usage

# Trigger cron manual
curl -X POST \
     -H "X-Api-Key: YOUR_KEY" \
     -H "Content-Type: application/json" \
     -d '{"job":"league-stats"}' \
     http://192.248.183.230:3000/api/admin/trigger-cron

# Joburi disponibile pentru trigger:
# league-stats, referee-stats, collect-daily,
# collect-finished, prematch-enrichment, backfill
```

---

## Securitate

- API key stocat **exclusiv** în `/root/scannerv2/.env` (generat automat la primul deploy)
- Rate limit: **60 req/minut** per IP
- Block IP: **5 încercări greșite** consecutive → blocat **1 oră**
- Key-ul NU este niciodată în codul sursă sau în git

---

## Unde găsești key-ul (pe VPS)

```bash
grep ADMIN_API_KEY /root/scannerv2/.env
```
