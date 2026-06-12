-- [ARHIVARE live_stats] Coloană created_at pentru a măsura acumularea în timp.
-- NOTĂ: live_stats are deja recorded_at TIMESTAMPTZ DEFAULT NOW() (timestampul efectiv de
-- inserare = de-facto created_at). created_at e adăugat la cererea explicită, idempotent.
-- live_stats e EXCLUS din orice cleanup → acumulare PERMANENTĂ.
ALTER TABLE live_stats ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
