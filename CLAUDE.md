# AlohaScan - Project Guidelines

## Arhitectura API

**Principiu de bază:** Toate API-urile configurate în Vercel trebuie să funcționeze SIMULTAN și să fie combinate într-un singur răspuns.

### API-uri active
| Env Var | Sursă | Acoperire | Tip date |
|---------|-------|-----------|----------|
| `FOOTBALL_DATA_KEY` | football-data.org | 12 ligi top (PL, BL1, SA, etc.) | Timp real |
| `API_FOOTBALL_KEY` | api-sports.io | 88 ligi globale | ~15min delay (free tier) |
| `BSD_KEY` | sports.bzzoiro.com | Ligi globale + ML predictions | Timp real |

### Regula de combinare
- Fiecare API nou adăugat trebuie integrat în `api/football.js`
- Ordinea priorității: API-urile cu date în timp real au prioritate
- Deduplicare: prin numele echipelor (`home|away`)
- Dacă un API eșuează, celelalte continuă să funcționeze (try/catch independent)

### Când adaugi un API nou
1. Adaugă env var în Vercel
2. Adaugă un bloc `try/catch` separat în `api/football.js`
3. Normalizează răspunsul la formatul standard (vezi mai jos)
4. Adaugă deduplicare față de API-urile cu prioritate mai mare

### Format standard de meci
```javascript
{
  fixture: { status: { elapsed: <minute> } },
  league: { id: <id>, name: <string>, f: <code> },
  teams: { home: { name: <string> }, away: { name: <string> } },
  goals: { home: <number>, away: <number> },
  statistics: [] // sau date reale dacă API-ul le oferă
}
```

## Stack tehnic
- Frontend: Vanilla JS, CSS în HTML (index.html)
- Backend: Vercel Serverless Functions (api/*.js, ESM)
- Deploy: GitHub main branch → Vercel auto-deploy

## Variabile de mediu Vercel
Toate cheile API sunt server-side only. Niciodată în frontend.
