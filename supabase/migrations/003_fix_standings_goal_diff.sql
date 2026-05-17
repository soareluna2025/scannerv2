-- Migration 003 — Fix standings column goal_diff → goals_diff
-- Run this in Supabase SQL Editor (Settings → SQL Editor)
-- Safe to run multiple times.

DO $$
BEGIN
  -- Dacă există goal_diff (fără 's') și NU există goals_diff → redenumește
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'standings' AND column_name = 'goal_diff'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'standings' AND column_name = 'goals_diff'
  ) THEN
    ALTER TABLE standings RENAME COLUMN goal_diff TO goals_diff;
    RAISE NOTICE 'Renamed goal_diff → goals_diff';

  -- Dacă există goal_diff ȘI goals_diff → copiază datele și șterge goal_diff
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'standings' AND column_name = 'goal_diff'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'standings' AND column_name = 'goals_diff'
  ) THEN
    UPDATE standings SET goals_diff = goal_diff WHERE goals_diff IS NULL OR goals_diff = 0;
    ALTER TABLE standings DROP COLUMN goal_diff;
    RAISE NOTICE 'Merged goal_diff into goals_diff and dropped goal_diff';

  -- Dacă nu există niciuna → adaugă goals_diff
  ELSIF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'standings' AND column_name = 'goals_diff'
  ) THEN
    ALTER TABLE standings ADD COLUMN goals_diff INTEGER DEFAULT 0;
    RAISE NOTICE 'Added goals_diff column';

  ELSE
    RAISE NOTICE 'goals_diff already exists — nothing to do';
  END IF;
END $$;
