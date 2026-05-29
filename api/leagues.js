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
  146,   // Belgian Cup

  // Turkey
  203,   // Super Lig
  204,   // TFF First League (Liga 2)
  205,   // Turkish Cup

  // Scotland
  179,   // Premiership
  180,   // Championship (Liga 2)
  184,   // Scottish Cup

  // Czech Republic
  345,   // Fortuna Liga (Liga 1)
  346,   // FNL (Liga 2)
  347,   // MOL Cup

  // Austria
  218,   // Bundesliga
  219,   // 2. Liga
  221,   // ÖFB Cup

  // Switzerland
  207,   // Super League
  208,   // Challenge League (Liga 2)
  209,   // Swiss Cup

  // Denmark
  119,   // Superliga
  120,   // 1st Division (Liga 2)
  123,   // DBU Pokalen

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
  392,   // SuperLiga
  394,   // Kup Srbije

  // Romania
  783,   // Superliga (Liga 1)
  784,   // Liga II
  787,   // Cupa Romaniei

  // Greece
  551,   // Super League 1
  552,   // Super League 2 (Liga 2)
  556,   // Greek Cup

  // Hungary
  271,   // Nemzeti Bajnokság I (Liga 1)
  275,   // Magyar Kupa

  // Bulgaria
  172,   // First Professional League
  174,   // Bulgarian Cup

  // Slovakia
  332,   // Super Liga (Liga 1)
  680,   // Slovak Cup

  // Finland
  244,   // Veikkausliiga (Liga 1)
  246,   // Finnish Cup

  // Ukraine
  333,   // Premier League
  336,   // Ukrainian Cup

  // Russia
  235,   // Premier League
  237,   // Russian Cup

  // Belarus
  116,   // Vysheyshaya Liga (Liga 1)
  486,   // Belarusian Cup

  // Kazakhstan
  389,   // Premier League
  498,   // Kazakhstan Cup

  // ── AMERICAS ─────────────────────────────────────────────────

  // Brazil
  71,    // Serie A
  72,    // Serie B (Liga 2)
  73,    // Copa do Brasil
  8077,  // Catarinense 2 (Santa Catarina — divizia a 2-a de stat)
  682,   // Carioca A2 (Rio de Janeiro — divizia a 2-a de stat)
  // IDs de VERIFICAT pe VPS (GET /api/health-check?action=leagues&country=Brazil&name=...):
  // Copa Sul-Sudeste    → ?action=leagues&country=Brazil&name=Sul-Sudeste
  // Copa FGF            → ?action=leagues&country=Brazil&name=FGF
  // Copa Centro-Oeste   → ?action=leagues&country=Brazil&name=Centro-Oeste

  // Argentina
  128,   // Primera Division
  131,   // Primera Nacional (Liga 2)
  132,   // Copa Argentina

  // Mexico
  262,   // Liga MX
  263,   // Liga Expansion (Liga 2)
  264,   // Copa MX

  // Colombia
  239,   // Primera A
  240,   // Primera B (Liga 2)
  241,   // Copa Colombia
  713,   // Superliga (Copa)

  // Chile
  265,   // Primera Division
  266,   // Primera B (Liga 2)
  267,   // Copa Chile

  // Uruguay
  268,   // Primera Division
  269,   // Segunda Division (Liga 2)
  270,   // Copa Uruguay

  // Peru
  281,   // Liga 1
  282,   // Liga 2
  283,   // Copa Peru

  // Ecuador
  286,   // LigaPro Serie A
  287,   // LigaPro Serie B (Liga 2)
  735,   // Copa Ecuador
  917,   // Copa Ecuador (ID alternativ)

  // Paraguay
  278,   // Primera Division
  279,   // Division Intermedia (Liga 2)
  280,   // Copa Paraguay

  // Bolivia
  273,   // Primera Division
  274,   // Liga de Ascenso (Liga 2)
  276,   // Copa Bolivia

  // Venezuela
  153,   // Liga FUTVE
  154,   // Segunda Division (Liga 2)
  155,   // Copa Venezuela

  // USA
  253,   // MLS
  255,   // USL Championship (Liga 2)
  257,   // US Open Cup
  909,   // MLS Next Pro (nivel 3)
  // EXCLUSE INTENȚIONAT (sub nivel 2):
  //   USL League One, USL League Two, NISA — filtrate și prin LOWER_DIV_TERMS

  // Canada
  321,   // Canadian Premier League
  322,   // Canadian Championship (Cup)

  // Costa Rica
  258,   // Primera Division
  259,   // Segunda Division (Liga 2)
  260,   // Copa Costa Rica

  // Honduras
  261,   // Liga Nacional
  319,   // Liga de Ascenso (Liga 2)
  320,   // Copa Honduras

  // Guatemala
  339,   // Liga Nacional
  338,   // Primera Division (Liga 2)
  248,   // Copa Guatemala

  // El Salvador
  344,   // Primera Division
  349,   // Segunda Division (Liga 2)
  350,   // Copa El Salvador

  // Nicaragua
  256,   // Primera Division
  380,   // Segunda Division (Liga 2)

  // Panama
  306,   // Primera División

  // ── ASIA ─────────────────────────────────────────────────────

  // Saudi Arabia
  307,   // Saudi Pro League
  308,   // First Division (Liga 2)
  313,   // King Cup

  // Japan
  98,    // J1 League
  99,    // J2 League (Liga 2)
  100,   // Emperor's Cup

  // South Korea
  292,   // K League 1
  293,   // K League 2 (Liga 2)
  294,   // Korean FA Cup

  // Iran
  290,   // Persian Gulf Pro League
  291,   // Azadegan League (Liga 2)
  295,   // Hazfi Cup

  // Qatar
  19,    // Qatar Stars League
  21,    // QSL (Liga 2)
  22,    // Emir Cup

  // UAE
  433,   // Pro League
  434,   // First Division (Liga 2)
  435,   // UAE Cup

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

  // Australia
  188,   // A-League Men
  189,   // Australia Cup

  // India
  323,   // ISL (Indian Super League)
  324,   // I-League (Liga 2)
  325,   // Durand Cup

  // Malaysia
  518,   // Super League
  519,   // Premier League (Liga 2)
  520,   // Malaysia Cup

  // Indonesia
  391,   // Liga 1
  460,   // Liga 2
  461,   // Indonesian Cup

  // Vietnam
  340,   // V.League 1
  341,   // V.League 2 (Liga 2)
  342,   // Vietnamese Cup

  // Iraq
  302,   // Premier League
  303,   // Division 1 (Liga 2)
  304,   // Iraqi Cup

  // Jordan
  474,   // Pro League
  475,   // Division 1 (Liga 2)
  494,   // Jordan Cup

  // Kuwait
  299,   // Premier League
  300,   // Division 1 (Liga 2)
  493,   // Emir Cup

  // Oman
  309,   // Professional League
  491,   // Division 1 (Liga 2)
  492,   // Sultan Qaboos Cup

  // Bahrain
  415,   // Premier League

  // Hong Kong
  499,   // Premier League

  // Singapore
  502,   // Premier League

  // Philippines
  483,   // PFL (Philippine Football League)

  // ── AFRICA ───────────────────────────────────────────────────

  // Egypt
  233,   // Premier League
  234,   // Second Division (Liga 2)
  238,   // Egyptian Cup

  // Morocco
  200,   // Botola Pro
  201,   // Botola 2 (Liga 2)
  822,   // Coupe du Trône

  // Tunisia
  202,   // Ligue 1
  377,   // Ligue 2
  378,   // Coupe de Tunisie

  // Algeria
  197,   // Ligue Professionnelle 1
  198,   // Ligue Professionnelle 2 (Liga 2)
  199,   // Coupe d'Algérie

  // South Africa
  288,   // Premier Division (PSL)
  670,   // National First Division (Liga 2)
  671,   // Nedbank Cup

  // Nigeria
  399,   // NPFL
  667,   // Nigerian FA Cup

  // Ghana
  289,   // Premier League
  418,   // Ghana FA Cup

  // Ivory Coast
  383,   // Ligue 1
  385,   // Coupe de Côte d'Ivoire

  // Kenya
  357,   // Premier League
  358,   // National Super League (Liga 2)
  // 500 — FKF Cup Kenya (ID duplicat cu HK First Division — omis)

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
  6,     // FIFA Club World Cup
  9,     // Copa America
  10,    // CONCACAF Champions Cup
  26,    // CONCACAF Nations League
]);
