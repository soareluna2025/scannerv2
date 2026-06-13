export const ALLOWED_LEAGUE_IDS = new Set([
  // ── EUROPA ────────────────────────────────────────────────────

  // England
  39,    // Premier League
  40,    // Championship (Liga 2)
  45,    // FA Cup
  48,    // EFL Cup (Carabao Cup)

  // Spain
  140,   // La Liga
  141,   // Segunda Division (Liga 2)
  143,   // Copa del Rey

  // Germany
  78,    // Bundesliga
  79,    // 2. Bundesliga
  81,    // DFB Pokal

  // Italy
  135,   // Serie A
  136,   // Serie B (Liga 2)
  137,   // Coppa Italia

  // France
  61,    // Ligue 1
  62,    // Ligue 2
  66,    // Coupe de France

  // Netherlands
  88,    // Eredivisie
  89,    // Eerste Divisie (Liga 2)
  90,    // KNVB Cup

  // Portugal
  94,    // Primeira Liga
  95,    // Liga Portugal 2
  96,    // Taca de Portugal

  // Belgium
  144,   // Pro League
  145,   // Challenger Pro League (Liga 2)

  // Turkey
  203,   // Super Lig
  204,   // TFF First League (Liga 2)
  205,   // 2. Lig (tier 3) // SUB OBSERVAȚIE win-rate (tier 3 / reserve)

  // Scotland
  179,   // Premiership
  180,   // Championship (Liga 2)
  184,   // League Two (tier 4) // SUB OBSERVAȚIE win-rate (tier 3 / reserve)

  // Czech Republic
  345,   // Fortuna Liga (Liga 1)
  346,   // FNL (Liga 2)
  347,   // MOL Cup

  // Austria
  218,   // Bundesliga
  219,   // 2. Liga

  // Switzerland
  207,   // Super League
  208,   // Challenge League (Liga 2)
  209,   // Swiss Cup

  // Denmark
  119,   // Superliga
  120,   // 1st Division (Liga 2)

  // Norway
  103,   // Eliteserien
  104,   // First Division (Liga 2)
  105,   // Norwegian Cup

  // Sweden
  113,   // Allsvenskan
  114,   // Superettan (Liga 2)
  115,   // Svenska Cupen

  // Poland
  106,   // Ekstraklasa
  107,   // I Liga (Liga 2)
  108,   // Polish Cup

  // Croatia
  210,   // Prva HNL
  211,   // Druga HNL (Liga 2)
  212,   // Croatian Cup

  // Serbia
  286,   // Super Liga (Tier 1)
  287,   // Prva Liga (Tier 2)

  // Romania
  283,   // Liga I (Superliga)
  284,   // Liga II
  285,   // Cupa României // SUB OBSERVAȚIE win-rate (ligă nouă Etapa 3)

  // Greece
  197,   // Super League 1 (Tier 1)
  494,   // Super League 2 (Liga 2 — corectat din fals „Jordan Cup")
  556,   // Greek Cup

  // Hungary
  271,   // Nemzeti Bajnokság I (Liga 1)

  // Bulgaria
  172,   // First Professional League
  174,   // Bulgarian Cup

  // Slovakia
  332,   // Super Liga (Liga 1)
  680,   // Slovak Cup

  // Finland
  244,   // Veikkausliiga (Liga 1)
  246,   // Suomen Cup

  // Ukraine
  333,   // Premier League
  336,   // Druha Liga (tier 3) // SUB OBSERVAȚIE win-rate (tier 3 / reserve)

  // Russia
  235,   // Premier League
  237,   // Russian Cup

  // Belarus
  116,   // Vysheyshaya Liga (Liga 1)
  486,   // Belarusian Cup

  // Kazakhstan
  389,   // Premier League
  498,   // Kazakhstan Cup

  // Cyprus
  318,   // 1. Division (tier 1) // SUB OBSERVAȚIE win-rate (ligă nouă Etapa 3)
  319,   // Second Division (Liga 2 — corectat din fals „Honduras")
  320,   // Third Division (corectat din fals „Honduras Copa")

  // Israel
  383,   // Ligat Ha'al (Liga 1 — corectat din fals „Ivory Coast")

  // Ireland
  357,   // Premier Division (corectat din fals „Kenya")
  358,   // First Division (Liga 2 — corectat din fals „Kenya")

  // Armenia
  342,   // Premier League (corectat din fals „Vietnamese Cup")

  // Azerbaijan
  418,   // Birinci Dasta (Liga 2 — corectat din fals „Ghana FA Cup")

  // ── AMERICAS ─────────────────────────────────────────────────

  // Brazil
  71,    // Serie A
  72,    // Serie B (Liga 2)
  73,    // Copa do Brasil
  75,    // Serie C
  76,    // Serie D
  612,   // Copa do Nordeste
  475,   // Paulista A1 (corectat din fals „Jordan Division 1")

  // Argentina
  128,   // Liga Profesional (Primera Division)
  129,   // Primera Nacional (Liga 2)
  130,   // Copa Argentina
  131,   // Primera B Metropolitana (tier 3) // SUB OBSERVAȚIE win-rate (tier 3 / reserve)
  132,   // Primera C (tier 4) // SUB OBSERVAȚIE win-rate (tier 3 / reserve)
  134,   // Torneo Federal A (tier 3) // SUB OBSERVAȚIE win-rate (tier 3 / reserve)
  906,   // Argentina (tier 3) // SUB OBSERVAȚIE win-rate (tier 3 / reserve)
  1032,  // DE CONFIRMAT la audit

  // Mexico
  262,   // Liga MX
  263,   // Liga Expansion (Liga 2)

  // Colombia
  239,   // Primera A
  240,   // Primera B (Liga 2)
  241,   // Copa Colombia
  713,   // Superliga (Copa)

  // Chile
  265,   // Primera Division
  266,   // Primera B (Liga 2)
  267,   // Copa Chile
  711,   // Chile (tier 3) // SUB OBSERVAȚIE win-rate (tier 3 / reserve)

  // Uruguay
  268,   // Primera Division
  269,   // Segunda Division (Liga 2)
  270,   // Copa Uruguay

  // Peru
  281,   // Liga 1
  282,   // Liga 2

  // Ecuador
  242,   // LigaPro Serie A (Liga 1)
  917,   // Copa Ecuador
  243,   // LigaPro Serie B (Liga 2)

  // Paraguay
  250,   // Primera Division — Apertura
  252,   // Primera Division — Clausura
  251,   // Division Intermedia (Liga 2)

  // Bolivia
  273,   // Primera Division // DUBLURĂ? de rezolvat
  344,   // Primera División // DUBLURĂ? de rezolvat

  // Venezuela
  299,   // Primera Division (corectat din fals „Kuwait")
  300,   // Segunda Division (Liga 2 — corectat din fals „Kuwait")

  // USA
  253,   // MLS
  255,   // USL Championship (Liga 2)
  257,   // US Open Cup
  909,   // MLS Next Pro (nivel 3)

  // Canada
  321,   // Canadian Premier League

  // Costa Rica
  162,   // Primera División (tier 1) // SUB OBSERVAȚIE win-rate (ligă nouă Etapa 3)
  259,   // Segunda Division (Liga 2)

  // Honduras
  234,   // Liga Nacional (corectat din fals „Egypt Second Division")

  // Guatemala
  339,   // Liga Nacional
  338,   // Primera Division (Liga 2)

  // Panama
  304,   // Liga Panameña (corectat din fals „Iraqi Cup")

  // ── ASIA ─────────────────────────────────────────────────────

  // Saudi Arabia
  307,   // Saudi Pro League
  308,   // First Division (Liga 2)
  309,   // Division 2 (tier 3 — corectat din fals „Oman Professional League")

  // Japan
  98,    // J1 League
  99,    // J2 League (Liga 2)

  // South Korea
  292,   // K League 1
  293,   // K League 2 (Liga 2)
  294,   // Korean FA Cup

  // Iran
  290,   // Persian Gulf Pro League
  291,   // Azadegan League (Liga 2)

  // Qatar
  305,   // Stars League (tier 1) // SUB OBSERVAȚIE win-rate (ligă nouă Etapa 3)
  306,   // Second Division (Liga 2 — corectat din fals „Panama Primera")

  // UAE
  303,   // Division 1 (Liga 2 — corectat din fals „Iraq Division 1")

  // China
  169,   // Super League
  170,   // League One (Liga 2)
  171,   // FA Cup

  // Thailand
  296,   // Thai League 1
  297,   // Thai League 2
  298,   // Thai FA Cup

  // Uzbekistan
  335,   // Super League

  // Malaysia
  278,   // Super League
  279,   // Premier League (Liga 2)

  // Australia
  188,   // A-League Men

  // India
  323,   // ISL (Indian Super League)
  324,   // I-League (Liga 2)
  325,   // Durand Cup

  // Indonesia
  274,   // Liga 1 (Tier 1)
  460,   // Liga 2 // DUBLURĂ? de rezolvat
  275,   // Liga 2 (corectat din fals „Magyar Kupa") // DUBLURĂ? de rezolvat

  // Vietnam
  340,   // V.League 1
  341,   // Vietnamese Cup

  // Iraq
  302,   // Premier League

  // Oman
  491,   // Division 1 (Liga 2)

  // Hong Kong
  499,   // Premier League // DUBLURĂ? de rezolvat
  380,   // Premier League (corectat din fals „Nicaragua Segunda") // DUBLURĂ? de rezolvat

  // ── AFRICA ───────────────────────────────────────────────────

  // Egypt
  233,   // Premier League
  887,   // Second League (Liga 2) // SUB OBSERVAȚIE win-rate (ligă nouă Etapa 3)

  // Morocco
  200,   // Botola Pro
  201,   // Botola 2 (Liga 2)
  822,   // Coupe du Trône

  // Tunisia
  202,   // Ligue 1
  378,   // Coupe de Tunisie

  // Algeria
  186,   // Ligue Professionnelle 1 (Tier 1)
  187,   // Ligue Professionnelle 2 (Liga 2)
  199,   // Coupe d'Algérie

  // South Africa
  288,   // Premier Division (PSL)
  289,   // First Division (Liga 2 — corectat din fals „Ghana Premier League")

  // Nigeria
  399,   // NPFL
  667,   // Nigerian FA Cup

  // Ivory Coast
  386,   // Ligue 1 (tier 1) // SUB OBSERVAȚIE win-rate (ligă nouă Etapa 3)
  385,   // Coupe de Côte d'Ivoire

  // Ghana
  570,   // Premier League (tier 1) // SUB OBSERVAȚIE win-rate (ligă nouă Etapa 3)

  // Kenya
  276,   // FKF Premier League (corectat din fals „Copa Bolivia")

  // ── INTERNAȚIONALE ───────────────────────────────────────────

  13,    // Copa Libertadores (CONMEBOL)
  11,    // Copa Sudamericana (CONMEBOL)
  2,     // UEFA Champions League
  3,     // UEFA Europa League
  848,   // UEFA Conference League
  17,    // AFC Champions League
  18,    // AFC Cup
  12,    // CAF Champions League
  20,    // CAF Confederation Cup
  4,     // Euro Championship
  5,     // UEFA Nations League
  1,     // World Cup
  6,     // Africa Cup of Nations (corectat din fals „FIFA Club World Cup")
  9,     // Copa America
  10,    // CONCACAF Champions Cup
  19,    // African Nations Championship (corectat din fals „Qatar Stars League")
  22,    // CONCACAF Gold Cup (corectat din fals „Emir Cup")
]);
