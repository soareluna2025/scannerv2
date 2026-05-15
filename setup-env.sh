#!/bin/bash
# Script interactiv pentru configurarea cheilor API AlohaScan
# Rulare: bash setup-env.sh

ENV_FILE="/root/scannerv2/.env"

echo ""
echo "======================================"
echo "  AlohaScan — Configurare chei API"
echo "======================================"
echo "Gasesti cheile la: vercel.com → scannerv2 → Settings → Environment Variables"
echo ""

read_key() {
  local VAR=$1
  local DESC=$2
  echo -n "  $DESC ($VAR): "
  read -r VALUE
  echo "$VAR=$VALUE" >> "$ENV_FILE"
}

# Curata .env existent
> "$ENV_FILE"

echo "--- API Football ---"
read_key "API_FOOTBALL_KEY"     "Cheia api-sports.io"
read_key "FOOTBALL_DATA_KEY"    "Cheia football-data.org"

echo ""
echo "--- Supabase ---"
read_key "SUPABASE_URL"         "URL proiect Supabase"
read_key "SUPABASE_KEY"         "Service role key"

echo ""
echo "--- AI APIs ---"
read_key "ANTHROPIC_API_KEY"    "Cheia Claude (Anthropic)"
read_key "GROQ_KEY"             "Cheia Groq API"
read_key "XAI_API_KEY"          "Cheia xAI API"

echo ""
echo "--- Securitate ---"
read_key "CRON_SECRET"          "Secret cron jobs"

echo ""
chmod 600 "$ENV_FILE"
echo "======================================"
echo "  .env salvat la $ENV_FILE"
echo "======================================"
echo ""
echo "Verificare:"
cat "$ENV_FILE" | sed 's/=.*/=***/'
echo ""
