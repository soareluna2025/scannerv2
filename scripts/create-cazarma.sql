-- Cazarma Centrala: punct de primire universal pentru toate datele API
-- Rulare pe VPS:
--   PGPASSWORD=Firenze225854 psql -U alohascan -d elefant -h 127.0.0.1 -f /root/scannerv2/scripts/create-cazarma.sql

CREATE TABLE IF NOT EXISTS cazarma_centrala (
  id          SERIAL PRIMARY KEY,
  sursa       TEXT NOT NULL,
  endpoint    TEXT NOT NULL,
  entity_id   INTEGER,
  raw_data    JSONB NOT NULL,
  primit_la   TIMESTAMPTZ DEFAULT NOW(),
  procesat    BOOLEAN DEFAULT FALSE,
  procesat_la TIMESTAMPTZ,
  eroare      TEXT
);

CREATE INDEX IF NOT EXISTS idx_cazarma_neprocesat
  ON cazarma_centrala(procesat, primit_la) WHERE procesat = FALSE;

CREATE INDEX IF NOT EXISTS idx_cazarma_sursa
  ON cazarma_centrala(sursa, procesat);

SELECT 'cazarma_centrala creata cu succes' AS status;
