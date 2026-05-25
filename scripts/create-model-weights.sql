-- Create model_weights table + default values
CREATE TABLE IF NOT EXISTS model_weights (
  id                SERIAL PRIMARY KEY,
  module            TEXT NOT NULL,
  context_key       TEXT NOT NULL,
  weight_name       TEXT NOT NULL,
  weight_value      NUMERIC(8,4) NOT NULL,
  default_value     NUMERIC(8,4) NOT NULL,
  sample_size       INT DEFAULT 0,
  win_rate          NUMERIC(5,2),
  confidence_level  TEXT DEFAULT 'LOW',
  last_updated      TIMESTAMP DEFAULT NOW(),
  UNIQUE(module, context_key, weight_name)
);

INSERT INTO model_weights (module, context_key, weight_name, weight_value, default_value)
VALUES
  ('NGP',        'global', 'threshold',                70,    70),
  ('NGP',        'global', 'minute_bonus_75plus',      1.1,   1.1),
  ('NGP',        'global', 'score_00_bonus',           1.15,  1.15),
  ('OVER15',     'global', 'threshold',                65,    65),
  ('OVER15',     'global', 'lambda_multiplier',        1.0,   1.0),
  ('OVER25',     'global', 'threshold',                55,    55),
  ('GG',         'global', 'threshold',                60,    60),
  ('GG',         'global', 'home_weight',              0.35,  0.35),
  ('GG',         'global', 'away_weight',              0.35,  0.35),
  ('GG',         'global', 'h2h_weight',               0.20,  0.20),
  ('GG',         'global', 'live_weight',              0.10,  0.10),
  ('CONFIDENCE', 'global', 'layer1_weight',            0.22,  0.22),
  ('CONFIDENCE', 'global', 'layer2_weight',            0.20,  0.20),
  ('CONFIDENCE', 'global', 'layer3_weight',            0.10,  0.10),
  ('CONFIDENCE', 'global', 'layer4_weight',            0.15,  0.15),
  ('CONFIDENCE', 'global', 'layer5_weight',            0.08,  0.08),
  ('CONFIDENCE', 'global', 'layer6_weight',            0.05,  0.05),
  ('CONFIDENCE', 'global', 'layer7_weight',            0.20,  0.20),
  ('CARDS',      'global', 'threshold',                65,    65),
  ('CARDS',      'global', 'referee_multiplier',       1.0,   1.0),
  ('CORNERS',    'global', 'threshold',                65,    65),
  ('CORNERS',    'global', 'surface_artificial_bonus', 1.08,  1.08),
  ('GENERATOR',  'global', 'threshold',                60,    60)
ON CONFLICT (module, context_key, weight_name) DO NOTHING;

SELECT module, COUNT(*) AS weights FROM model_weights GROUP BY module ORDER BY module;
