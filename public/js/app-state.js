// AlohaScan — app-state.js
// Extras din index.html (Sprint 3 Pas 2, 28.05.2026)
// Config, helpers Poisson/NGP, calibrare, Win Rate, EV calculator, MATCH TIME BADGE
// Loaded FIRST — alte module depind de variabile/funcții de aici.
// NOTE: blocul CALIBRARE mutat ÎNAINTE de EV helpers pentru hoisting NGP_CAL_REST (var).


// ── SIGLĂ ECHIPĂ — renderer UNIC folosit peste tot (listă, live, H2H, detaliu) ──
// Logo real dacă URL există; altfel cerc cu INIȚIALELE echipei (2 litere, culoare
// stabilă derivată din team_id). Nu mai există cazul „nimic". Loaded FIRST → global.
function teamBadgeColor(id){ id=Math.abs(Number(id)||0); return 'hsl('+((id*47)%360)+',45%,40%)'; }
function teamInitials(name){
  name=String(name||'').trim().replace(/[<>&"]/g,''); if(!name) return '?';
  var p=name.split(/\s+/); var s=(p.length>1?(p[0].charAt(0)+p[1].charAt(0)):name.slice(0,2));
  return s.toUpperCase();
}
function teamLogo(logo,name,id,sz){
  sz=sz||24; var fs=Math.max(8,Math.round(sz*0.42));
  var base='position:relative;display:inline-flex;align-items:center;justify-content:center;width:'+sz+'px;height:'+sz
    +'px;border-radius:50%;flex-shrink:0;vertical-align:middle;background:'+teamBadgeColor(id)
    +';color:#fff;font-weight:800;font-size:'+fs+'px;overflow:hidden';
  var img=logo?('<img src="'+logo+'" width="'+sz+'" height="'+sz
    +'" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#0f1620" onerror="this.style.display=\'none\'">'):'';
  return '<span style="'+base+'">'+teamInitials(name)+img+'</span>';
}
function tLogo(team,sz){ if(!team) return teamLogo(null,'',0,sz); return teamLogo(team.logo,team.name,team.id,sz); }
// [P06] Formator procent uniform (ca pc() din tabul ML): valoare invalidă → "—",
// NICIODATĂ NaN/undefined/0% fals. Folosit oriunde un câmp posibil-null ajunge în UI.
function pctTxt(v){ var n=Number(v); return Number.isFinite(n)?Math.round(n)+'%':'—'; }
// ── RÂND DE MECI UNIFICAT (3 coloane). home/away: {flag:'<html steag>', name:'text-escapat'}.
// center: HTML (folosește mrTime/mrScore). Geometrie unică pe toate cardurile de meci.
function mrRow(home,away,center){
  home=home||{}; away=away||{};
  return '<div class="match-row">'
    +'<div class="mr-team mr-home"><span class="mr-name">'+(home.name||'—')+'</span>'+(home.flag||'')+'</div>'
    +'<div class="mr-center">'+(center||'')+'</div>'
    +'<div class="mr-team mr-away">'+(away.flag||'')+'<span class="mr-name">'+(away.name||'—')+'</span></div>'
    +'</div>';
}
function mrTime(txt){ return '<span class="mr-time">'+(txt||'—')+'</span>'; }
function mrScore(hg,ag,sub,subColor){
  var hn=Number(hg), an=Number(ag);
  var hw=Number.isFinite(hn)&&Number.isFinite(an)&&hn>an;
  var aw=Number.isFinite(hn)&&Number.isFinite(an)&&an>hn;
  var s=sub?('<div class="mr-sub" style="color:'+(subColor||'var(--mu)')+'">'+sub+'</div>'):'';
  return s+'<span class="mr-score"><span'+(hw?' class="w"':'')+'>'+(hg!=null?hg:'-')+'</span> - <span'+(aw?' class="w"':'')+'>'+(ag!=null?ag:'-')+'</span></span>';
}
// ── CONFIG ──────────────────────────────────────────────────
var CFG={MC:80,MD:20,RI:30000};
var WR_KEY='alohascan_wr_v2';

var ST={ms:[],connected:false,ws:null,score:'all'};
// Liste de ligi cu performanta dovedita pe Over 1.5 (din /api/learning-leagues)
// GOOD_LEAGUES (WR >= 75%, n >= 5) → badge verde, foloseste-le
// BAD_LEAGUES  (WR <= 50%, n >= 5) → badge rosu, eviti pariurile aici
// Plus banner-ul "Alerte NGP" arata acum overall din DB (nu localStorage)
var GOOD_LEAGUES={};
var BAD_LEAGUES={};
function loadLearningLeagues(){
  try{
    fetch('/api/learning-leagues?ts='+Date.now()).then(function(r){return r.json();}).then(function(d){
      if(!d||!d.ok)return;
      GOOD_LEAGUES={};BAD_LEAGUES={};
      (d.good||[]).forEach(function(lg){GOOD_LEAGUES[lg.id]={name:lg.name,wr:lg.wr,n:lg.n};});
      (d.bad||[]).forEach(function(lg){BAD_LEAGUES[lg.id] ={name:lg.name,wr:lg.wr,n:lg.n};});
      // Bara header foloseste acum /api/model-accuracy (loadModelAccuracy);
      // learning-leagues ramane DOAR pentru badge-urile good/bad pe carduri.
    }).catch(function(){});
  }catch(e){}
}
loadLearningLeagues();
// Refresh la 5 min sa fie sincronizat cu cache-ul server-side
setInterval(loadLearningLeagues, 5*60*1000);

// ── ACURATEȚE MODEL (header bar + modal detalii) ─────────────────
// Sursă: /api/model-accuracy (tabela predictions — 1 rând/meci). Acuratețe ONESTĂ
// pe predicțiile cu confidence ≥70 (main_accuracy), nu base-rate-ul inflamat.
var _maState={days:30};
function loadModelAccuracy(){
  try{
    fetch('/api/model-accuracy?days=30&ts='+Date.now())
      .then(function(r){return r.json();}).then(function(d){
        if(!d||!d.ok)return;
        var pe=document.getElementById('ma-pct');
        var se=document.getElementById('ma-sub');
        var mt=d.main_total||0;
        if(pe){
          if(mt>=50 && d.main_accuracy!=null){
            pe.textContent=d.main_accuracy+'%';
            pe.style.color=d.model_adds_value?'#22c55e':'#f59e0b';
          }else{pe.textContent='—';pe.style.color='';}
        }
        if(se){
          se.textContent = (mt>=50)
            ? ('Confidence ≥70 · '+mt+' meciuri · 30 zile')
            : 'Date insuficiente pentru confidence ≥70';
        }
      }).catch(function(){});
  }catch(e){}
}
// ── TICKER „Ponturile Zilei" — defilare în header, sursă /daily_picks.json ──────
// Înlocuiește auto-încărcarea fostului banner ACURATEȚE MODEL. Listă goală → ascuns.
function loadDailyPicks(){
  try{
    fetch('/daily_picks.json?ts='+Date.now())
      .then(function(r){return r.ok?r.json():null;}).then(function(d){
        var tk=document.getElementById('dp-ticker');
        var tr=document.getElementById('dp-track');
        if(!tk||!tr)return;
        var picks=(d&&d.picks)||[];
        if(!picks.length){tk.style.display='none';tr.innerHTML='';return;}
        var esc=function(s){return String(s==null?'':s)
          .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');};
        var item=function(p){
          var pct=Math.round((p.p_cal!=null?p.p_cal:0)*100);
          return '<span class="dp-item">'+esc(p.home)+' vs '+esc(p.away)+
                 ' · '+esc(p.market)+' · '+pct+'%</span>';
        };
        var html=picks.map(item).join('<span class="dp-sep">•</span>');
        // dublăm conținutul → loop continuu fără gol (keyframe translateX -50%).
        tr.innerHTML=html+'<span class="dp-sep">•</span>'+html;
        tk.style.display='block';
      }).catch(function(){var tk=document.getElementById('dp-ticker');if(tk)tk.style.display='none';});
  }catch(e){}
}
loadDailyPicks();
setInterval(loadDailyPicks, 10*60*1000);

function maColor(p){return p==null?'#888':p>=70?'#22c55e':p>=55?'#f59e0b':'#ef4444';}
function maOpen(){var ov=document.getElementById('ma-overlay');if(ov){ov.style.display='flex';maRender();}}
function maClose(){var ov=document.getElementById('ma-overlay');if(ov)ov.style.display='none';}
function maSetPeriod(d){_maState.days=d;maRender();}
function maRender(){
  var body=document.getElementById('ma-body');if(!body)return;
  body.innerHTML='<div class="spinner"><div class="spin"></div></div>';
  fetch('/api/model-accuracy?days='+_maState.days+'&ts='+Date.now())
    .then(function(r){return r.json();}).then(function(d){
      if(!d||!d.ok){body.innerHTML='<div class="empty"><div class="empty-t">Eroare</div></div>';return;}
      body.innerHTML=maBuildHtml(d);
      requestAnimationFrame(function(){
        var bars=body.querySelectorAll('.ma-fill');
        for(var i=0;i<bars.length;i++)bars[i].style.width=bars[i].getAttribute('data-w')+'%';
      });
    }).catch(function(){body.innerHTML='<div class="empty"><div class="empty-t">Eroare rețea</div></div>';});
}
function maBuildHtml(d){
  var bc=d.by_confidence||{};
  var main=d.main_accuracy;
  var base=d.base_rate;
  var pct=main==null?'—':main+'%';
  var mainColor=d.model_adds_value?'#22c55e':'#f59e0b';
  var h='';
  // SECȚIUNEA PRINCIPALĂ
  h+='<div style="text-align:center;padding:8px 0 4px">';
  h+='<div style="font-size:42px;font-weight:800;line-height:1;color:'+(main==null?'#888':mainColor)+'">'+pct+'</div>';
  h+='<div style="font-size:11px;color:var(--mu);margin-top:5px">pe predicțiile cu confidence ≥70 · '+(d.main_total||0)+' meciuri · '+d.period+' zile</div>';
  if(main!=null && base!=null){
    var diff=Math.round((main-base)*10)/10;
    if(d.model_adds_value){
      h+='<div style="font-size:10px;color:var(--mu2,#888);margin-top:3px">Rata de bază fotbal: '+base+'% · Modelul adaugă: +'+diff+'pp</div>';
    }else{
      h+='<div style="font-size:10px;color:#f59e0b;margin-top:3px">Rata de bază fotbal: '+base+'% · Modelul nu depășește rata de bază</div>';
    }
  }
  h+='</div>';
  // SELECTOR PERIOADĂ
  h+='<div style="display:flex;gap:6px;margin:10px 0 14px">';
  [30,60,90].forEach(function(p){
    var act=_maState.days===p;
    h+='<button onclick="maSetPeriod('+p+')" style="flex:1;padding:7px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;border:1px solid '+(act?'#22c55e':'rgba(255,255,255,.12)')+';background:'+(act?'rgba(34,197,94,.15)':'transparent')+';color:'+(act?'#22c55e':'var(--mu)')+'">'+p+' zile</button>';
  });
  h+='</div>';
  // SECȚIUNEA DETALII PE NIVELE (Over 1.5)
  h+='<div style="font-size:11px;font-weight:700;color:var(--mu);margin-bottom:6px">Over 1.5 pe nivel confidence</div>';
  var rows=[
    ['Confidence ≥80', bc.high],
    ['Confidence 70-79', bc.mid],
    ['Confidence 60-69', bc.low],
  ];
  rows.forEach(function(r){
    var b=r[1]||{};var wr=b.over15_accuracy;
    var pctTxt=wr==null?'—':wr+'%';var w=wr==null?0:wr;
    h+='<div style="margin-bottom:10px">';
    h+='<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px"><span style="font-weight:600">'+r[0]+'</span><span style="font-weight:700;color:'+maColor(wr)+'">'+pctTxt+' <span style="color:var(--mu);font-weight:400">('+(b.total||0)+' meciuri)</span></span></div>';
    h+='<div style="height:8px;border-radius:6px;background:rgba(255,255,255,.08);overflow:hidden"><div class="ma-fill" data-w="'+w+'" style="height:100%;width:0;background:'+maColor(wr)+';transition:width .6s ease"></div></div>';
    h+='</div>';
  });
  // LINIA DE BENCHMARK — toate meciurile
  var baseTxt=base==null?'—':base+'%';var bw=base==null?0:base;
  h+='<div style="margin-bottom:14px;border-top:1px solid rgba(255,255,255,.08);padding-top:10px">';
  h+='<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px"><span style="font-weight:600;color:var(--mu)">Toate meciurile (benchmark)</span><span style="font-weight:700;color:'+maColor(base)+'">'+baseTxt+' <span style="color:var(--mu);font-weight:400">('+(d.total_resolved||0)+' meciuri)</span></span></div>';
  h+='<div style="height:8px;border-radius:6px;background:rgba(255,255,255,.08);overflow:hidden"><div class="ma-fill" data-w="'+bw+'" style="height:100%;width:0;background:'+maColor(base)+';transition:width .6s ease"></div></div>';
  h+='</div>';
  // SECȚIUNEA GG
  h+='<div style="font-size:11px;font-weight:700;color:var(--mu);margin-bottom:6px">GG (ambele marchează)</div>';
  var ggMain=d.gg_main, ggBase=d.gg_base_rate;
  h+='<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px"><span style="font-weight:600">GG Confidence ≥70</span><span style="font-weight:700;color:'+maColor(ggMain)+'">'+(ggMain==null?'—':ggMain+'%')+' <span style="color:var(--mu);font-weight:400">('+(d.main_total||0)+' meciuri)</span></span></div>';
  h+='<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:10px"><span style="font-weight:600;color:var(--mu)">GG toate</span><span style="font-weight:700;color:'+maColor(ggBase)+'">'+(ggBase==null?'—':ggBase+'%')+'</span></div>';
  // NOTĂ DE BAS
  h+='<div style="font-size:9px;color:var(--mu2,#888);margin-top:8px;line-height:1.4">Sursă: predictions · 1 înregistrare per meci · exclude pending.<br>Acuratețe = meciuri corecte / (corecte + greșite).</div>';
  return h;
}

// ── CLOCK ────────────────────────────────────────────────────
function tickClock(){
  var d=new Date();
  document.getElementById('clock').textContent=
    d.toTimeString().slice(0,8);
}
setInterval(tickClock,1000);tickClock();
document.getElementById('ag-start-time').textContent=new Date().toTimeString().slice(0,5);

// ── NAVIGARE STACK (back întoarce la pagina anterioară, nu la meniu) ──
var _navStack=[];
function navPush(pageId,restoreFn){
  _navStack.push({pageId:pageId,restoreFn:restoreFn});
}
function navBack(){
  if(_navStack.length===0)return;
  var prev=_navStack.pop();
  if(prev&&typeof prev.restoreFn==='function')prev.restoreFn();
}

// ── TABS ─────────────────────────────────────────────────────
function setTab(t){
  _navStack.length=0;   // schimbare tab principal → reset stack navigare
  ['live','pre','agent','fav'].forEach(function(x){
    document.getElementById('tab-'+x).classList.toggle('active',x===t);
    var nb=document.getElementById('nav-'+x);
    if(nb)nb.classList.toggle('active',x===t);
  });
  var pg=document.getElementById('page');
  if(t==='agent'){
    pg.style.display='flex';pg.style.flexDirection='column';
    document.getElementById('tab-agent').style.display='flex';
    document.getElementById('tab-agent').style.flexDirection='column';
    document.getElementById('tab-agent').style.height='100%';
    setTimeout(function(){var m=document.getElementById('ag-msgs');m.scrollTop=m.scrollHeight;},50);
    agUpdateStats();
  } else {
    pg.style.display='';
  }
  if(t==='fav'){
    renderFavs();
  }
  if (t === 'pre' && _pmMatches.length === 0) {
    // Bug fix: dacă userul a navigat pe altă zi în date picker (PM_DATE !== today),
    // NU forța loadPM() — ar suprascrie view-ul istoric/viitor cu meciurile de azi.
    var _todayLocal = (typeof pmTodayStr === 'function') ? pmTodayStr() : null;
    var _onOtherDay = (typeof PM_DATE === 'string') && PM_DATE && _todayLocal && PM_DATE !== _todayLocal;
    if (!_onOtherDay) loadPM();
  }
}

// ── POISSON / NGP ─────────────────────────────────────────────
function poissonCDF(lambda,k){
  if(lambda<=0)return k===0?1:0;
  var p=Math.exp(-lambda);var cum=p;
  for(var i=1;i<=k;i++){p=p*lambda/i;cum+=p;}
  return cum;
}
function mkt(need,lr){
  if(need<=0)return 100;
  var pF=poissonCDF(lr,need-1);
  return Math.round(Math.max(5,Math.min(98,(1-pF)*100)));
}
function getStat(st,idx,type){
  var t=st&&st[idx]&&st[idx].statistics;
  if(!Array.isArray(t))return 0;
  var e=t.find(function(s){return s.type===type;});
  var v=e&&e.value;
  if(v===null||v===undefined||v==='N/A'||v==='')return 0;
  return parseFloat(v)||0;
}
function calcScore(m){
  var st=m.statistics||[];
  var mn=m.fixture&&m.fixture.status?m.fixture.status.elapsed||0:0;
  var hg=m.goals?m.goals.home||0:0;
  var ag=m.goals?m.goals.away||0:0;
  var hxg=getStat(st,0,'expected_goals');
  var axg=getStat(st,1,'expected_goals');
  var hSOT=getStat(st,0,'Shots on Goal');
  var aSOT=getStat(st,1,'Shots on Goal');
  var hSh=getStat(st,0,'Shots off Goal')+hSOT;
  var aSh=getStat(st,1,'Shots off Goal')+aSOT;
  var hDA=getStat(st,0,'Dangerous Attacks');
  var aDA=getStat(st,1,'Dangerous Attacks');
  var txg=hxg+axg;
  var remFrac=Math.max(0,Math.min(1,(95-mn)/90));
  // NGP: foloseste valoarea backend (m._ng din WebSocket LIVE_UPDATE/LIVE_DELTA)
  // Fallback 0 daca lipseste (meci nou inainte de primul broadcast scanner).
  var ng=(typeof m._ng==='number')?m._ng:0;
  var totalG=hg+ag;
  var lxg=txg>0?txg*3:0;
  var lb=lxg>0?lxg*.55+(m.enrichData?.lambdaTotal??1.4)*.45:1.6;
  var lr=lb*remFrac;
  return{
    ng:ng,
    mk:{
      over05:mkt(1,lr),
      over15:mkt(Math.max(1,2-totalG),lr),
      over25:mkt(Math.max(1,3-totalG),lr),
      over35:mkt(Math.max(1,4-totalG),lr),
    },
    forte:ng>=70,
    mn:mn,hg:hg,ag:ag,hxg:hxg,axg:axg,
    tSh:hSh+aSh,tSOT:hSOT+aSOT,
    hDA:hDA,aDA:aDA
  };
}

function filterScore(el,score){
  ST.score=score;
  document.querySelectorAll('#score-chips .score-chip').forEach(function(c){c.classList.remove('active');});
  el.classList.add('active');
  renderMatches();
}


// MIRROR al CALIBRATION din api/utils/generator-calibration.js — keep in sync.
var G2_CALIBRATION={
  gg:[[0,50,0],[50,60,67],[60,70,99],[70,101,100]],
  'goals_total_0.5':[[0,50,25],[50,60,39],[60,70,58],[70,80,60],[80,101,100]],
  'goals_total_1.5':[[0,30,0],[30,40,28],[40,50,43],[50,60,43],[60,70,68],[70,101,100]],
  'goals_total_2.5':[[0,40,0],[40,50,7],[50,60,62],[60,70,98],[70,101,100]],
  'goals_home_0.5':[[0,30,0],[30,40,20],[40,50,12],[50,60,34],[60,70,29],[70,80,83],[80,90,93],[90,101,99]],
  'goals_home_1.5':[[0,20,0],[20,30,10],[30,40,15],[40,50,22],[50,60,66],[60,70,76],[70,80,85],[80,101,97]],
  'goals_away_0.5':[[0,30,0],[30,40,12],[40,50,27],[50,60,26],[60,70,38],[70,80,77],[80,90,87],[90,101,95]],
  'goals_away_1.5':[[0,20,0],[20,30,4],[30,40,13],[40,50,24],[50,60,45],[60,70,66],[70,80,89],[80,101,100]],
};
// Stocheaza ultima Brier per modul (din /api/calibration). Afisat opt in UI.
var CALIBRATION_META={};
// LIVE calibration: {"minute_bucket|score_state|market": {n, pct}}
var LIVE_CALIBRATION={};
// Auto-update G2_CALIBRATION din DB (recalibrate-tables cron) si LIVE table.
var PREDICTIONS_COUNT=0;
(function loadDynamicCalibration(){
  try{
    fetch('/api/calibration').then(function(r){return r.json();}).then(function(d){
      if(!d||!d.ok)return;
      // Stocheaza numarul real de predictii rezolvate
      if(d.predictions_count)PREDICTIONS_COUNT=d.predictions_count;
      // Pre-meci calibration
      if(d.modules){
        Object.keys(d.modules).forEach(function(moduleKey){
          var mod=d.modules[moduleKey];
          if(!mod||!Array.isArray(mod.buckets)||!mod.buckets.length)return;
          G2_CALIBRATION[moduleKey]=mod.buckets.map(function(b){return [b.min,b.max,b.pct];});
          CALIBRATION_META[moduleKey]={n:mod.n,brier:mod.brier,updated:mod.updated};
        });
      }
      // LIVE calibration
      if(d.live){LIVE_CALIBRATION=d.live;}
      console.log('[calibration] modules:'+Object.keys(d.modules||{}).length+' live:'+Object.keys(d.live||{}).length+' predictions:'+PREDICTIONS_COUNT);
    }).catch(function(){});
  }catch(e){}
})();
// Helper: calibrare LIVE pentru (minute, scor_h, scor_a, market)
function liveCalibrate(minute, hg, ag, market){
  var mb=minute<=15?'0-15':minute<=30?'16-30':minute<=45?'31-45':minute<=60?'46-60':minute<=75?'61-75':'76-90';
  var sst;
  if(hg===0&&ag===0)sst='0-0';
  else if(hg===1&&ag===0)sst='1-0';
  else if(hg===0&&ag===1)sst='0-1';
  else if(hg===1&&ag===1)sst='1-1';
  else if(hg-ag>=2)sst='home_+2';
  else if(ag-hg>=2)sst='away_+2';
  else sst='other';
  var key=mb+'|'+sst+'|'+market;
  return LIVE_CALIBRATION[key]||null;
}

// ── NGP CALIBRATION (rest of match) ──────────────────────────
// Extras din backtest 26297 predictii (24.05.2026, V0_current formula).
// Bias original era +30pp subestimare la valori <50%. Acum mapat la rate real masurat.
// NU se aplica pentru sortare in lista (raw NGP pastreaza rank ordering) — DOAR display.
var NGP_CAL_REST=[
  [0,10,38],   // 397 samples, real 38.3%
  [10,20,45],  // 1955 samples, real 45.1%
  [20,30,70],  // 3435 samples, real 70.0%  (jump major)
  [30,40,71],  // 6274 samples, real 70.8%
  [40,50,80],  // 3654 samples, real 80.5%
  [50,60,82],  // 3407 samples, real 82.5%
  [60,70,81],  // 1802 samples, real 81.1%
  [70,80,80],  // 1249 samples, real 80.2% ✓ calibrat
  [80,90,83],  // 957 samples, real 83.4%  ✓
  [90,101,81], // 3167 samples, real 80.8% (usor dip)
];
function calibrateNgpRest(raw){
  if(typeof raw!=='number'||isNaN(raw))return 0;
  var r=Math.max(0,Math.min(100,raw));
  for(var i=0;i<NGP_CAL_REST.length;i++){
    if(r>=NGP_CAL_REST[i][0]&&r<NGP_CAL_REST[i][1])return NGP_CAL_REST[i][2];
  }
  return r;
}
// Detect league_group din media reală de goluri/meci (zero hardcodat per ligă).
// Coincide cu thresholds din api/cron/recalibrate-tables.js (single source of truth).
function g2LeagueGroup(m){
  if(!m||!m.league)return null;
  var ag=Number(m.league.avg_goals);
  if(!isFinite(ag)||ag<=0)return null;
  if(ag<2.3)return 'low';
  if(ag<3.0)return 'mid';
  return 'high';
}
function g2Calibrate(cat,sub,thr,raw,m){
  if(typeof raw!=='number'||isNaN(raw))return 0;
  var key;
  if(cat==='home'||cat==='away'||cat==='gg')key=cat;
  else if(cat==='goals')key='goals_'+(sub||'total')+'_'+(thr||0.5);
  else if((cat==='corners'||cat==='cards')&&m){
    // Calibrare Poisson teoretica bazata pe media de liga (heuristica)
    // Mai robusta decat un sample mic backtest (38 meciuri).
    return g2PoissonCalib(cat, sub, thr, m);
  }
  else return raw;
  // Sprint 4B: încearcă tabela per-profil (low/mid/high), apoi fallback la global.
  var grp=g2LeagueGroup(m);
  var tbl=(grp&&G2_CALIBRATION[key+'_'+grp])||G2_CALIBRATION[key];
  if(!tbl)return raw;
  for(var i=0;i<tbl.length;i++){
    if(raw>=tbl[i][0]&&raw<tbl[i][1])return tbl[i][2];
  }
  return raw;
}
// Probabilitate Poisson teoretica pentru corners/cards (pre-meci)
// folosita ca substitut pentru calibrare bucket (sample 46 prea mic).
function g2PoissonCalib(cat, sub, thr, m){
  var lgAvg=cat==='corners'?((m.league&&m.league.avg_corners)||9):((m.league&&m.league.avg_yellow)||3.5);
  var lambda;
  if(sub==='home'||sub==='away')lambda=lgAvg/2;  // 50% split per echipa
  else lambda=lgAvg;  // total
  // P(X >= thr+1) where X ~ Poisson(lambda)
  function pPois(k,lam){
    if(lam<=0)return k===0?1:0;
    var lp=-lam+k*Math.log(lam);
    for(var i=1;i<=k;i++)lp-=Math.log(i);
    return Math.exp(lp);
  }
  var needed=Math.ceil((thr||0.5)+0.5);
  var p=0;
  for(var i=0;i<needed;i++)p+=pPois(i,lambda);
  return Math.round(100*(1-p));
}
function g2CalibrationTested(cat){
  // home/away/gg/goals — backtest 1000 meciuri (calibrat empiric)
  // corners/cards — calibrat heuristic Poisson (nu backtest, dar matematic solid)
  return cat==='home'||cat==='away'||cat==='gg'||cat==='goals';
}
function g2CalibrationHeuristic(cat){
  return cat==='corners'||cat==='cards';
}

// ── EV CALCULATOR HELPERS ────────────────────────────────────────
// Mapeaza NGP afisat -> probabilitate reala (din backtest 531 meciuri, 24.05.2026)
// Calibrare NGP rest-of-match — foloseste NGP_CAL_REST din backtest (26297 predictii).
// Replaceaza buckets-urile coarse anterioare cu mapping fin per 10% range.
function calibratedAnytimeProb(displayedNgp){
  // Note: calibrateNgpRest e definit mai jos (la nivel global), dar functioneaza
  // din cauza hoisting JS pentru var declarations.
  return calibrateNgpRest(displayedNgp) / 100;
}
function calibrated15minProb(displayedNg15){
  if(displayedNg15 >= 35) return 0.40;  // peak observat in backtest
  if(displayedNg15 >= 25) return 0.35;
  if(displayedNg15 >= 15) return 0.32;
  return 0.28;  // baseline
}
function evRecalc(inputId, realProb, displayId){
  var el = document.getElementById(inputId);
  var disp = document.getElementById(displayId);
  if(!el || !disp) return;
  // Accept atat ',' cat si '.' ca separator zecimal (RO vs EN locale)
  var raw = (el.value || '').toString().replace(',', '.');
  var cota = parseFloat(raw);
  if(!cota || cota < 1.01){
    disp.innerHTML = '&mdash;';
    disp.style.color = 'var(--mu)';
    return;
  }
  // Persist in localStorage
  try { localStorage.setItem(inputId, cota.toString()); } catch(e){}
  var ev = realProb * cota - 1;
  var evPct = Math.round(ev * 100);
  var sign = ev >= 0 ? '+' : '';
  var color, icon, label;
  if(ev >= 0.08){ color='#22c55e'; icon='✅'; label='profitabil'; }
  else if(ev >= 0){ color='#f59e0b'; icon='⚠️'; label='marginal'; }
  else { color='#ef4444'; icon='❌'; label='NU paria'; }
  disp.innerHTML = '<span style="color:'+color+'">EV: '+sign+evPct+'% '+icon+' '+label+'</span>';
}

// ── CALIBRARE POISSON INVERSĂ DIN COTE 1X2 ──────────────────────
function _ppf(lam,k){
  if(lam<=0) return k===0?1:0;
  if(k===0) return Math.exp(-lam);
  var lp=-lam+k*Math.log(lam);
  for(var i=1;i<=k;i++) lp-=Math.log(i);
  return Math.exp(lp);
}
function _p1x2(lH,lA){
  var h=0,d=0,a=0;
  for(var i=0;i<=9;i++){var ph=_ppf(lH,i);if(ph<1e-10)continue;
    for(var j=0;j<=9;j++){var pa=_ppf(lA,j);if(pa<1e-10)continue;
      var p=ph*pa;if(i>j)h+=p;else if(i===j)d+=p;else a+=p;}}
  return [h,d,a];
}
function _findLam(p1,pX,p2,lH0,lA0){
  var lH=Math.max(0.1,Math.min(4,lH0||1.3));
  var lA=Math.max(0.1,Math.min(4,lA0||1.1));
  var lr=0.06;
  for(var it=0;it<600;it++){
    var c=_p1x2(lH,lA);
    var dH=c[0]-p1,dA=c[2]-p2;
    if(Math.abs(dH)<0.0002&&Math.abs(dA)<0.0002) break;
    lH=Math.max(0.05,Math.min(5,lH-lr*(dH-0.35*dA)));
    lA=Math.max(0.05,Math.min(5,lA-lr*(dA-0.35*dH)));
    lr*=0.999;
  }
  return [+lH.toFixed(3),+lA.toFixed(3)];
}
function _mkts(lH,lA){
  var e0=Math.exp(-lH),e1=Math.exp(-lA);
  var p=function(i,j){return _ppf(lH,i)*_ppf(lA,j);};
  var c=_p1x2(lH,lA);
  var o15=1-p(0,0)-p(1,0)-p(0,1);
  var o25=o15-p(2,0)-p(1,1)-p(0,2);
  var o35=o25-p(3,0)-p(2,1)-p(1,2)-p(0,3);
  return {homeWin:Math.round(c[0]*100),draw:Math.round(c[1]*100),awayWin:Math.round(c[2]*100),
    over05:Math.round((1-p(0,0))*100),over15:Math.round(o15*100),
    over25:Math.round(o25*100),over35:Math.max(0,Math.round(o35*100)),
    gg:Math.round((1-e0)*(1-e1)*100),hsc:Math.round((1-e0)*100),asc:Math.round((1-e1)*100),
    lH:lH,lA:lA};
}
// ── PATTERN ANALYSIS LIVE (Over 1.5 ajustat cu calibrarea live) ──────────────
// DOAR afișare: combină Poisson Over1.5 cu % real istoric din /api/calibration
// (câmpul `live`, per minute_bucket|score_state|over15), ponderat pe timp+credibilitate.
// Zero atingere scoring/NGP backend. Flag false → feature complet oprit.
var SHOW_LIVE_PATTERN = true;
var _calibCache = null;            // obiectul d.live din /api/calibration
var _calibCacheTime = 0;
var _calibFetching = false;
var _CALIB_TTL = 10 * 60 * 1000;   // 10 min

function calibLiveFresh(){ return _calibCache && (Date.now() - _calibCacheTime < _CALIB_TTL); }
function loadCalibLive(cb){
  if(calibLiveFresh()){ if(cb)cb(_calibCache); return; }
  if(_calibFetching) return;       // un singur fetch în zbor
  _calibFetching = true;
  fetch('/api/calibration').then(function(r){return r.json();}).then(function(d){
    _calibCache = (d && d.live) ? d.live : {};
    _calibCacheTime = Date.now();
    _calibFetching = false;
    if(cb)cb(_calibCache);
  }).catch(function(){ _calibFetching = false; });
}
function _patMinuteBucket(m){
  if(m<=15)return '0-15'; if(m<=30)return '16-30'; if(m<=45)return '31-45';
  if(m<=60)return '46-60'; if(m<=75)return '61-75'; return '76-90';
}
function _patScoreState(h,a){
  if(h===0&&a===0)return '0-0';
  if(h===1&&a===0)return '1-0';
  if(h===0&&a===1)return '0-1';
  if(h===1&&a===1)return '1-1';
  if(h>=2&&h-a>=2)return 'home_+2';
  if(a>=2&&a-h>=2)return 'away_+2';
  return 'other';
}
function calcPatternAdjusted(fx, live){
  if(!live || !fx) return null;
  var elapsed = Number(fx.elapsed) || 0;
  var hg = Number(fx.homeGoals) || 0, ag = Number(fx.awayGoals) || 0;
  var lh = Number(fx.lambdaHome) || 0, la = Number(fx.lambdaAway) || 0;
  var lgAvg = Number(fx.leagueAvgGoals); if(!(lgAvg>0)) lgAvg = 2.5;
  // Piața RELEVANTĂ din golurile deja marcate (Over 1.5 e inutil la scor 1-1).
  var totalGoals = hg + ag;
  var market;
  if(totalGoals <= 1)       market = 'over15';
  else if(totalGoals === 2) market = 'over25';
  else if(totalGoals === 3) market = 'over35';   // poate lipsi din calibration_live
  else if(totalGoals === 4) market = 'over45';
  else return null;                              // ≥5 goluri → piața nu mai e relevantă
  // Poisson corespunzător pieței
  var poisson;
  if(market === 'over15')      poisson = Number(fx.poissonOver15);
  else if(market === 'over25') poisson = Number(fx.poissonOver25);
  else if(market === 'over35') { poisson = Number(fx.poissonOver35); if(!isFinite(poisson)) poisson = Number(fx.poissonOver25); }
  else { poisson = Number(fx.poissonOver45); if(!isFinite(poisson)) poisson = Number(fx.poissonOver35); if(!isFinite(poisson)) poisson = Number(fx.poissonOver25); }
  if(!isFinite(poisson)) return null;
  var key = _patMinuteBucket(elapsed) + '|' + _patScoreState(hg,ag) + '|' + market;
  var entry = live[key];
  if(!entry) return null;
  var pattern_pct = Number(entry.pct), pattern_n = Number(entry.n);
  if(!isFinite(pattern_pct)) return null;
  var lambda_meci = lh + la;
  var strength_ratio = lgAvg>0 ? (lambda_meci/lgAvg) : 1;
  var pattern_ajustat = Math.min(95, pattern_pct * strength_ratio);
  var credibility = pattern_n / (pattern_n + 300);
  var w_time = elapsed / 90;
  var w_pattern = w_time * credibility;
  var w_poisson = 1 - w_pattern;
  var final = poisson * w_poisson + pattern_ajustat * w_pattern;
  final = Math.round(Math.min(95, Math.max(5, final)));
  return {
    final: final,
    poisson: Math.round(poisson),
    patternPct: Math.round(pattern_pct),
    patternN: pattern_n,
    wPattern: Math.round(w_pattern*100),
    wPoisson: Math.round(w_poisson*100),
    market: market,
  };
}

// Minute RĂMASE din meci pentru fixture-ul fk — citite din DOM (badge-ul de minut
// din cartonaș: "R1 · 62'", "R2 · 62'", "EXTRA · 95'", "PAUZĂ · HT") cu fallback
// pe ST.ms (status.short + elapsed). Întoarce null dacă nu poate fi determinat
// (→ apelantul cade pe ratio-ul simplu). DOAR citire — niciun calcul de scoring.
function _mevRemainingMinutes(fk){
  try{
    var half=null, mn=null;
    // 1) DOM — badge-ul de minut din modal
    var badge=document.querySelector('#md-overlay .md-min-badge')||document.querySelector('.md-min-badge');
    var txt=badge?(badge.textContent||''):'';
    if(txt){
      if(/EXTRA/i.test(txt))      half='ET';
      else if(/R1/i.test(txt))    half='1H';
      else if(/R2/i.test(txt))    half='2H';
      else if(/HT|PAUZ/i.test(txt))half='HT';
      var m=txt.match(/(\d+)/);   // primul număr = minutul (la "45+2" ia 45)
      if(m) mn=parseInt(m[1],10);
    }
    // 2) Fallback ST.ms după fixture id
    if(half===null||mn===null){
      var fid=parseInt(fk,10);
      var mm=(typeof ST!=='undefined'&&ST.ms||[]).find(function(x){return x.fixture&&x.fixture.id===fid;});
      var st=mm&&mm.fixture&&mm.fixture.status;
      if(st){
        if(half===null){var sh=st.short; half=(sh==='1H'||sh==='2H'||sh==='ET'||sh==='HT')?sh:null;}
        if(mn===null && typeof st.elapsed==='number') mn=st.elapsed;
      }
    }
    if(mn===null && half===null) return null;
    if(half==='ET') return 5;                                  // extra time: conservator
    if(half==='HT') return 45;                                 // pauză: repriza 2 neîncepută
    if(half==='1H'){ if(mn==null)mn=0; return Math.max(1,45-mn)+45; }
    if(half==='2H'){ if(mn==null)mn=45; return Math.max(1,90-mn); }
    if(mn!=null) return Math.max(1,90-mn);                     // half necunoscut → minut generic
    return null;
  }catch(_){ return null; }
}
// Cache valori introduse în "CALIBRARE CU COTE REALE" — supraviețuiește re-randării
// live (WebSocket ~2s) ca să nu se piardă inputul userului. { [fk]: {c1,cx,c2} }.
var _mevCache = {};
function mevCalibrate(fk){
  var res=document.getElementById('mev_res_'+fk);
  if(!res) return;
  var v1=((document.getElementById('mev_c1_'+fk)||{}).value||'').replace(',','.');
  var vx=((document.getElementById('mev_cx_'+fk)||{}).value||'').replace(',','.');
  var v2=((document.getElementById('mev_c2_'+fk)||{}).value||'').replace(',','.');
  // Salvează imediat valorile introduse (chiar parțiale) ca să le pot restaura
  // după re-randare. Dacă toate sunt goale → userul a golit manual → șterge.
  if(!v1 && !vx && !v2){ delete _mevCache[fk]; }
  else { _mevCache[fk] = { c1:v1, cx:vx, c2:v2 }; }
  var c1=parseFloat(v1),cx=parseFloat(vx),c2=parseFloat(v2);
  var ec2=function(v){return v>=70?'#22c55e':v>=50?'#f59e0b':'#ef4444';};
  // Helper: update a Poisson tile value element
  var setTile=function(id,val,pct){
    var el=document.getElementById('mdpv_'+fk+'_'+id);
    if(!el)return;
    el.style.color=ec2(val);
    el.textContent=val+(pct?'%':'');
  };
  // Helper: update confidence circle and Poisson breakdown bar
  var setConf=function(newPo){
    var origCs=parseInt(res.dataset.cs)||null;
    var origPo=res.dataset.po!==''?parseInt(res.dataset.po):null;
    var pow=parseFloat(res.dataset.pow)||0.20;
    if(origCs!=null&&origPo!=null){
      var csAdj=Math.max(0,Math.min(100,Math.round(origCs+(newPo-origPo)*pow)));
      var ccEl=document.getElementById('mdcc_'+fk);
      if(ccEl){ccEl.textContent=csAdj+'%';ccEl.className='conf-circle '+(csAdj>=70?'high':csAdj>=55?'mid':'low');}
      var poBd=document.getElementById('mdbd_'+fk+'_po');
      var poBdV=document.getElementById('mdbdv_'+fk+'_po');
      var bc=newPo>=80?'#22c55e':newPo>=60?'#f59e0b':'#ef4444';
      if(poBd){poBd.style.width=newPo+'%';poBd.style.background=bc;}
      if(poBdV)poBdV.textContent=newPo+'%';
    }
  };
  // Restore tiles and confidence to original model values
  var restoreTiles=function(){
    var o15=res.dataset.o15!==''?parseInt(res.dataset.o15):null;
    var o25=res.dataset.o25!==''?parseInt(res.dataset.o25):null;
    var gg=res.dataset.gg!==''?parseInt(res.dataset.gg):null;
    var hsc=res.dataset.hsc!==''?parseInt(res.dataset.hsc):null;
    var asc=res.dataset.asc!==''?parseInt(res.dataset.asc):null;
    var lt=res.dataset.lt||'';
    if(o15!=null)setTile('o15',o15,true);
    if(o25!=null)setTile('o25',o25,true);
    if(gg!=null)setTile('gg',gg,true);
    if(hsc!=null)setTile('hsc',hsc,true);
    if(asc!=null)setTile('asc',asc,true);
    var ltEl=document.getElementById('mdpv_'+fk+'_lt');
    if(ltEl&&lt){ltEl.style.color='var(--mu2)';ltEl.textContent=lt;}
    // Restore confidence circle
    var origCs=parseInt(res.dataset.cs)||null;
    var origPo=res.dataset.po!==''?parseInt(res.dataset.po):null;
    var ccEl=document.getElementById('mdcc_'+fk);
    if(ccEl&&origCs!=null){ccEl.textContent=origCs+'%';ccEl.className='conf-circle '+(origCs>=70?'high':origCs>=55?'mid':'low');}
    var poBd=document.getElementById('mdbd_'+fk+'_po');
    var poBdV=document.getElementById('mdbdv_'+fk+'_po');
    if(origPo!=null){
      var bc=origPo>=80?'#22c55e':origPo>=60?'#f59e0b':'#ef4444';
      if(poBd){poBd.style.width=origPo+'%';poBd.style.background=bc;}
      if(poBdV)poBdV.textContent=origPo+'%';
    }
  };
  // FIX 2 — NGP (Gol oricând / urm.15min) se scalează proporțional cu λ calibrat.
  // Citește valoarea originală din data-orig (setată la randare) și o multiplică
  // cu ratio. NU atinge backend-ul NGP — doar afișarea în cartonaș.
  var _ngpColor=function(v){return v>=80?'#00d4a8':v>=60?'#ffd166':'#ff6b6b';};
  var _ng15Color=function(v){return v>=40?'#00d4a8':v>=25?'#ffd166':'#ff6b6b';};
  var _updNgp=function(ratio){
    var a=document.getElementById('mdngp_'+fk);
    if(a){var o=parseFloat(a.dataset.orig);
      if(isFinite(o)){var nv=Math.min(99,Math.round(o*ratio));a.textContent=nv+'%';a.style.color=_ngpColor(nv);}}
    var b=document.getElementById('mdng15_'+fk);
    if(b){var o2=parseFloat(b.dataset.orig);
      if(isFinite(o2)){var nv2=Math.min(99,Math.round(o2*ratio));b.textContent=nv2+'%';b.style.color=_ng15Color(nv2);}}
  };
  var _restoreNgp=function(){
    var a=document.getElementById('mdngp_'+fk);
    if(a){var o=parseFloat(a.dataset.orig);if(isFinite(o)){a.textContent=o+'%';a.style.color=_ngpColor(o);}}
    var b=document.getElementById('mdng15_'+fk);
    if(b){var o2=parseFloat(b.dataset.orig);if(isFinite(o2)){b.textContent=o2+'%';b.style.color=_ng15Color(o2);}}
  };
  // Setează NGP la valori absolute (din calculul pe minute rămase). Nu suprascrie
  // "—" (data-orig gol → NGP nesigur/early sau pre-meci) ca să nu inventeze cifre.
  var _setNgp=function(ngMeci,ng15){
    var a=document.getElementById('mdngp_'+fk);
    if(a&&isFinite(parseFloat(a.dataset.orig))){a.textContent=ngMeci+'%';a.style.color=_ngpColor(ngMeci);}
    var b=document.getElementById('mdng15_'+fk);
    if(b&&isFinite(parseFloat(b.dataset.orig))){b.textContent=ng15+'%';b.style.color=_ng15Color(ng15);}
  };
  if(!c1||c1<1.01||!cx||cx<1.01||!c2||c2<1.01){
    res.innerHTML='<div style="color:var(--mu);font-size:11px;padding:8px 0">Introdu cotele pentru 1, X și 2 →</div>';
    restoreTiles();_restoreNgp();return;}
  var i1=1/c1,ix=1/cx,i2=1/c2,tot=i1+ix+i2;
  var p1=i1/tot,pX=ix/tot,p2=i2/tot;
  var margin=Math.round((tot-1)*100);
  var lH0=parseFloat(res.dataset.lh)||1.3,lA0=parseFloat(res.dataset.la)||1.1;
  var lam=_findLam(p1,pX,p2,lH0,lA0);
  var cal=_mkts(lam[0],lam[1]);
  // Update the 6 Poisson tiles live
  setTile('o15',cal.over15,true);
  setTile('o25',cal.over25,true);
  setTile('gg',cal.gg,true);
  setTile('hsc',cal.hsc,true);
  setTile('asc',cal.asc,true);
  var ltEl=document.getElementById('mdpv_'+fk+'_lt');
  if(ltEl){ltEl.style.color='var(--mu2)';ltEl.textContent=(lam[0]+lam[1]).toFixed(2);}
  // Update confidence circle
  setConf(cal.over15);
  // NGP calibrat pe minutele RĂMASE din meci (nu pe 90 min întregi).
  //   λ_rămas = λ_calibrat_total × (minute_rămase / 90)
  //   NGP_meci  = 1 − e^(−λ_rămas)
  //   NGP_15min = 1 − e^(−λ_calibrat_total × 15/90)
  var _ltNew=lam[0]+lam[1];
  var _rem=_mevRemainingMinutes(fk);
  if(_rem!=null && _rem>0){
    var _lamRem=_ltNew*(_rem/90);
    var _ngMeci=Math.min(99, Math.round((1-Math.exp(-_lamRem))*100));
    var _ng15 =Math.min(99, Math.round((1-Math.exp(-_ltNew*(15/90)))*100));
    _setNgp(_ngMeci,_ng15);
  } else {
    // Minutul nu poate fi citit → fallback la ratio simplu (comportament anterior).
    var _ltOrig=parseFloat(res.dataset.lt)||0;
    _updNgp(_ltOrig>0 ? (_ltNew/_ltOrig) : 1);
  }
  var mod={homeWin:+res.dataset.hw||null,draw:+res.dataset.dr||null,awayWin:+res.dataset.aw||null,
    over15:+res.dataset.o15||null,over25:+res.dataset.o25||null,gg:+res.dataset.gg||null,
    hsc:+res.dataset.hsc||null,asc:+res.dataset.asc||null};
  var dif=function(k){var d=cal[k]-(mod[k]||0);if(!mod[k]||Math.abs(d)<1)return '';
    return d>0?'<span style="font-size:10px;color:#22c55e"> +'+d+'pp</span>':'<span style="font-size:10px;color:#ef4444"> '+d+'pp</span>';};
  var row=function(lbl,k){var v=cal[k];if(v==null)return '';
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04)">'
      +'<span style="font-size:12px;color:var(--mu2)">'+lbl+'</span>'
      +'<span style="font-size:13px;font-weight:700;color:'+ec2(v)+'">'+v+'%'+dif(k)+'</span></div>';};
  var h='<div style="font-size:10px;color:var(--mu);margin-bottom:10px">Marjă bookmaker: <b style="color:var(--tx)">'+margin+'%</b>'
    +' &nbsp;·&nbsp; λ calibrat: <b style="color:var(--ac)">'+lam[0]+' + '+lam[1]+' = '+(lam[0]+lam[1]).toFixed(2)+'</b></div>';
  h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 20px">';
  h+='<div>'+row('1 Gazde','homeWin')+row('X Egal','draw')+row('2 Oaspeți','awayWin')
    +row('Gazde marchează','hsc')+row('Oaspeți marchează','asc')+'</div>';
  h+='<div>'+row('Over 0.5','over05')+row('Over 1.5','over15')+row('Over 2.5','over25')
    +row('Over 3.5','over35')+row('GG','gg')+'</div>';
  h+='</div>';
  res.innerHTML=h;
}

// ── WIN RATE ──────────────────────────────────────────────────
function loadWR(){try{var s=localStorage.getItem(WR_KEY);return s?JSON.parse(s):{predictions:[]};}catch(e){return{predictions:[]};}}
function saveWR(d){try{localStorage.setItem(WR_KEY,JSON.stringify(d));}catch(e){}}
function resetWR(){try{localStorage.removeItem(WR_KEY);}catch(e){}renderWR({predictions:[]});}
function wrShowInfo(){
  alert('Ce înseamnă acest contor\n\n'+
        'Numără câte alerte NGP > 70% au fost urmate de un gol oricând până la finalul meciului.\n\n'+
        'W (Win): a venit gol\n'+
        'L (Loss): meci terminat fără gol după alertă\n'+
        'P (Pending): meci încă în desfășurare\n\n'+
        '⚠ Atenție:\n'+
        '• NU e calculator de profit — nu ține cont de cote\n'+
        '• NU înseamnă că, dacă ai pariat, ai câștigat — depinde de cotă vs probabilitate reală\n'+
        '• "Goal anywhere" e prea permisiv — un gol în min 89 contează WIN chiar dacă ai pariat la min 30\n\n'+
        'Pentru pariere reală, calculează EV = (NGP/100) × cota − 1. EV > 0 = pariu profitabil pe termen lung.');
}

function trackWR(){
  var data=loadWR();var now=new Date().toISOString();
  var liveMap={};
  ST.ms.forEach(function(m){
    var k=(m.teams&&m.teams.home&&m.teams.home.name||'')+'|'+(m.teams&&m.teams.away&&m.teams.away.name||'');
    liveMap[k]=m;
  });
  ST.ms.forEach(function(m){
    var s=m._s||{};
    if((s.ng||0)<CFG.MC)return;
    var k=(m.teams&&m.teams.home&&m.teams.home.name||'')+'|'+(m.teams&&m.teams.away&&m.teams.away.name||'');
    var hg=m.goals?m.goals.home||0:0;var ag=m.goals?m.goals.away||0:0;
    var score=hg+'-'+ag;
    if(!data.predictions.some(function(p){return p.matchId===k&&p.outcome==='PENDING';})){
      data.predictions.push({id:k+'_'+Date.now(),matchId:k,scoreAtAlert:score,outcome:'PENDING',alertTime:now});
    }
  });
  data.predictions.forEach(function(p){
    if(p.outcome!=='PENDING')return;
    var live=liveMap[p.matchId];
    if(live){
      var hg=live.goals?live.goals.home||0:0;var ag=live.goals?live.goals.away||0:0;
      if((hg+'-'+ag)!==p.scoreAtAlert){p.outcome='WIN';p.resolvedAt=now;}
    } else {
      p.outcome='LOSS';p.resolvedAt=now;
    }
  });
  if(data.predictions.length>200)data.predictions=data.predictions.slice(-200);
  saveWR(data);renderWR(data);
}
function renderWR(data){
  // Banner-ul afiseaza acum date din DB via loadLearningLeagues().
  // Functia veche (localStorage) este disabled pentru a evita conflict.
  // Tracking-ul intern localStorage continua dar nu mai pictureaza banner-ul.
}
async function fetchSupabaseWinRate(){
  // Disabled — banner-ul foloseste acum loadLearningLeagues() (data din DB cu sample mare).
  return;
}
// Polling-ul vechi e dezactivat; loadLearningLeagues() ruleaza la 5min.


// ── MATCH TIME BADGE ──────────────────────────────────────────
function matchTimeBadge(sh,elapsed,extra){
  elapsed=elapsed||0;
  // Bug fix: prelungiri din API-Football vin în status.extra (separat de elapsed).
  // Fallback istoric: elapsed > 45/90 (când API întoarce direct elapsed inflated).
  extra=(typeof extra==='number'&&extra>0)?extra:0;
  if(sh==='1H'){
    if(extra>0)         return{dot:true,c:'#f97316',t:"R1 · "+elapsed+"+"+extra+"'"};
    if(elapsed<=45)     return{dot:true,c:'#22c55e',t:"R1 · "+elapsed+"'"};
    return{dot:true,c:'#f97316',t:"R1 · 45+"+(elapsed-45)+"'"};
  }
  if(sh==='HT')return{dot:false,c:'#eab308',t:'PAUZĂ · HT'};
  if(sh==='2H'){
    if(extra>0)         return{dot:true,c:'#f97316',t:"R2 · "+elapsed+"+"+extra+"'"};
    if(elapsed<=90)     return{dot:true,c:'#3b82f6',t:"R2 · "+elapsed+"'"};
    return{dot:true,c:'#f97316',t:"R2 · 90+"+(elapsed-90)+"'"};
  }
  if(sh==='ET'){
    var et=extra>0?elapsed+"+"+extra:elapsed;
    return{dot:true,c:'#ef4444',t:"EXTRA · "+et+"'"};
  }
  if(sh==='P')return{dot:true,c:'#a855f7',t:'PENALTYURI'};
  if(sh==='FT'||sh==='AET'||sh==='PEN')return{dot:false,c:'#6b7280',t:'FINAL'};
  if(elapsed>0){
    var generic=extra>0?elapsed+"+"+extra+"'":elapsed+"'";
    return{dot:true,c:'var(--ac)',t:generic};
  }
  return{dot:false,c:'var(--mu)',t:sh||'—'};
}

// Helper: format minut + extra ("45+2'" sau "45'"). Folosit pentru evenimente.
function fmtMinute(elapsed,extra){
  if(!elapsed&&elapsed!==0)return '';
  if(typeof extra==='number'&&extra>0)return elapsed+"+"+extra+"'";
  return elapsed+"'";
}


// ── OVERSCROLL BLOCAT (anti pull-to-refresh nativ) ────────────
document.body.style.overscrollBehavior='none';
document.documentElement.style.overscrollBehavior='none';

// ── PULL-TO-REFRESH cu indicator (trage în jos la top → refresh) ──
// La topul containerului activ (pagina SAU cartonașul/modalul deschis), tragerea
// în jos arată un spinner (ca în app native); la eliberare peste prag → refresh.
// Funcționează și în cartonașe (md/tp/wc) — refresh datele modalului respectiv.
var _ptr={startY:0,pulling:false,lastDy:0,threshold:70,refresh:null};

// Modale secundare unde NU vrem pull-refresh (rămân blocate).
function _ptrBlockedOverlay(){
  var ma=document.getElementById('ma-overlay');
  if(ma&&ma.style.display&&ma.style.display!=='none')return true;
  var g2=document.getElementById('gen2-ov');
  if(g2&&g2.classList&&g2.classList.contains('open'))return true;
  var hm=document.getElementById('hist-modal');
  if(hm&&hm.style.display&&hm.style.display!=='none')return true;
  var wcm=document.getElementById('wc-match-modal');
  if(wcm&&wcm.classList.contains('open'))return true;
  return false;
}
// Contextul activ: scroller-ul + funcția de refresh.
// Cartonaș meci (md) / pagină echipă (tp) / hub WC (wc) → refresh datele lor;
// altfel → pagina principală (tab-ul curent).
function _ptrContext(){
  var md=document.getElementById('md-overlay');
  if(md&&md.classList.contains('open'))
    return {el:document.getElementById('md-body'), refresh:function(){ if(typeof mdFetch==='function')mdFetch(true); }};
  var tp=document.getElementById('tp-overlay');
  if(tp&&tp.classList.contains('open'))
    return {el:document.getElementById('tp-body'), refresh:function(){ if(typeof tpFetch==='function')tpFetch(); }};
  var wc=document.getElementById('wc-overlay');
  if(wc&&wc.classList.contains('open'))
    return {el:document.getElementById('wc-body'), refresh:function(){ if(typeof wcFetch==='function')wcFetch(); }};
  return {el:document.getElementById('page'), refresh:refreshCurrentPage};
}
function _ptrActiveTab(){
  var tabs=['live','pre','agent','fav'];
  for(var i=0;i<tabs.length;i++){
    var nb=document.getElementById('nav-'+tabs[i]);
    if(nb&&nb.classList.contains('active'))return tabs[i];
  }
  return null;
}
function refreshCurrentPage(){
  var t=_ptrActiveTab();
  if(t==='live'&&typeof loadLive==='function')loadLive();
  else if(t==='pre'&&typeof loadPM==='function')loadPM();
  else if(t==='fav'&&typeof renderFavs==='function')renderFavs();
  else if(t==='agent'){ if(typeof agUpdateStats==='function')agUpdateStats(); }
  else window.location.reload();
}
function showPullSpinner(dy){
  var el=document.getElementById('pull-refresh');if(!el)return;
  var p=Math.min(dy/_ptr.threshold,1);                 // 0..1
  el.style.opacity=p;
  el.style.transform='translateX(-50%) translateY('+Math.min(dy*0.45,46)+'px) scale('+(0.4+0.6*p)+')';
}
function hidePullSpinner(){
  var el=document.getElementById('pull-refresh');if(!el)return;
  el.style.opacity='0';
  el.style.transform='translateX(-50%) translateY(0) scale(0.4)';
}
function triggerPullRefresh(){
  var el=document.getElementById('pull-refresh');
  if(el){ el.style.opacity='1'; el.style.transform='translateX(-50%) translateY(46px) scale(1)'; }
  if(typeof _ptr.refresh==='function')_ptr.refresh(); else refreshCurrentPage();
  setTimeout(hidePullSpinner,800);
}

document.addEventListener('touchstart',function(e){
  if(_ptrBlockedOverlay()){_ptr.pulling=false;return;}
  var ctx=_ptrContext();
  if(ctx.el && ctx.el.scrollTop<=0){
    _ptr.startY=e.touches[0].clientY;_ptr.pulling=true;_ptr.lastDy=0;_ptr.refresh=ctx.refresh;
  }
},{passive:true});

document.addEventListener('touchmove',function(e){
  if(!_ptr.pulling)return;
  if(_ptrBlockedOverlay()){_ptr.pulling=false;hidePullSpinner();return;}
  var dy=e.touches[0].clientY-_ptr.startY;
  _ptr.lastDy=dy;
  if(dy>0){ showPullSpinner(dy); }
  else { _ptr.lastDy=0; hidePullSpinner(); }
},{passive:true});

document.addEventListener('touchend',function(){
  if(!_ptr.pulling)return;
  _ptr.pulling=false;
  var dy=_ptr.lastDy;_ptr.lastDy=0;
  // la topul paginii + tras în jos cel puțin pragul → refresh cu spinner
  if(dy>=_ptr.threshold){ triggerPullRefresh(); }
  else { hidePullSpinner(); }
},{passive:true});
