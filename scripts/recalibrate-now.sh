#!/bin/bash
# Trigger manual pentru cron-ul de recalibrare pre-meci (G2_CALIBRATION).
# Ruleaza analiza pe predictii.result_over15 din ultimele 180 zile si
# updateaza tabela calibration_tables.
#
# Usage: bash scripts/recalibrate-now.sh

echo "Rulez recalibrate-tables..."
echo ""
curl -s http://localhost:3000/api/cron/recalibrate-tables \
  | python3 -m json.tool 2>/dev/null \
  || curl -s http://localhost:3000/api/cron/recalibrate-tables
echo ""
echo "Done."
