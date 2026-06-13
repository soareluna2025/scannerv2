// AlohaScan — app-live.js
// Extras din index.html (Sprint 3 Pas 2, 28.05.2026)
// Agent, Generator v2 (S1-S6), Favorites, Simulator, Splash, BILETE/ROI, INIT
// Depinde de: app-state.js + app-ui.js

// ── AGENT ─────────────────────────────────────────────────────
var AG_MEM=[];
function agUpdateStats(){
  var ms=ST.ms;
  var rec=ms.filter(function(m){return m._s&&m._s.ng>=CFG.MC;}).length;
  var wr=loadWR();var p=wr.predictions;
  var w=p.filter(function(x){return x.outcome==='WIN';}).length;
  var l=p.filter(function(x){return x.outcome==='LOSS';}).length;
  var t=w+l;var rate=t>0?Math.round(w/t*100)+'%':'—';
  var topNg=ms.reduce(function(mx,m){return Math.max(mx,(m._s&&m._s.ng)||0);},0);
  document.getElementById('ag-live').textContent=ms.length||'—';
  document.getElementById('ag-rec').textContent=Math.min(rec,CFG.MD)+'/'+CFG.MD;
  document.getElementById('ag-wr').textContent=rate;
  document.getElementById('ag-ngp').textContent=topNg?topNg+'%':'—';
}
function agKey(e){if(e.key==='Enter')agSend();}
function agAppend(role,text){
  var msgs=document.getElementById('ag-msgs');
  var t=new Date().toTimeString().slice(0,5);
  var cls=role==='user'?'user':'bot';
  var div=document.createElement('div');div.className='msg '+cls;
  div.innerHTML='<div><div class="bubble">'+text.replace(/\n/g,'<br>')+'</div><div class="msg-time">'+t+'</div></div>';
  msgs.appendChild(div);
  setTimeout(function(){msgs.scrollTop=msgs.scrollHeight;},50);
}
function agTyping(){
  var msgs=document.getElementById('ag-msgs');
  var div=document.createElement('div');div.className='msg bot';div.id='ag-typing';
  div.innerHTML='<div class="bubble"><div class="typing"><span></span><span></span><span></span></div></div>';
  msgs.appendChild(div);msgs.scrollTop=msgs.scrollHeight;
}
function agRemoveTyping(){var t=document.getElementById('ag-typing');if(t)t.remove();}
function buildSysPrompt(){
  var ms=ST.ms;
  var top=ms.slice().sort(function(a,b){return((b._s&&b._s.ng)||0)-((a._s&&a._s.ng)||0);}).slice(0,10);
  var mLines=top.map(function(m){
    var s=m._s||{};
    return (m.teams&&m.teams.home&&m.teams.home.name||'?')+' '+(m.goals&&m.goals.home||0)+'-'+(m.goals&&m.goals.away||0)+' '+(m.teams&&m.teams.away&&m.teams.away.name||'?')+' ['+s.mn+"' NGP:"+s.ng+'%]';
  }).join('\n');
  var wr=loadWR();var p=wr.predictions;
  var w=p.filter(function(x){return x.outcome==='WIN';}).length;
  var l=p.filter(function(x){return x.outcome==='LOSS';}).length;
  return 'Ești AlohaScan AI, expert predicții fotbal live. Ora: '+new Date().toTimeString().slice(0,5)+'\n\nMECIURI LIVE TOP 10:\n'+mLines+'\n\nWIN RATE: W:'+w+' L:'+l+'\n\nRăspunde în română, concis și util.';
}
async function agSend(){
  var inp=document.getElementById('ag-input');
  var text=inp.value.trim();if(!text)return;
  inp.value='';
  agAppend('user',text);
  AG_MEM.push({role:'user',content:text});
  if(AG_MEM.length>10)AG_MEM=AG_MEM.slice(-10);
  agTyping();
  try{
    var msgs=[{role:'system',content:buildSysPrompt()}].concat(AG_MEM);
    var r=await fetch('/api/agent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:msgs,max_tokens:500})});
    var d=await r.json();
    agRemoveTyping();
    if(d.error){agAppend('bot','Eroare: '+d.error);return;}
    var reply=d.choices&&d.choices[0]&&d.choices[0].message&&d.choices[0].message.content||'—';
    agAppend('bot',reply);
    AG_MEM.push({role:'assistant',content:reply});
  }catch(e){agRemoveTyping();agAppend('bot','Eroare conexiune: '+e.message);}
}


// ── GENERATOR v2 ──────────────────────────────────────────────
var GEN={tabIdx:0,open:false};       // stub — păstrat pentru genUpdateBadge
var _genLiveEnrich={};               // stub

var G2={
  mode:null,cat:null,sub:null,
  thr:1.5,period:'full',
  scrn:1,hist:[1],
  matches:[],top10:[],
  loading:false,
  minScore:0,         // filtru: ascunde scoruri < minScore
  sortBy:'score',     // 'score' | 'ev' (necesită cote introduse)
};

var G2_CATS={
  home:   {label:'Gazde marchează',       unit:'',         ranges:null,            icon:'🏠'},
  away:   {label:'Oaspeți marchează',     unit:'',         ranges:null,            icon:'✈️'},
  goals:  {label:'Goluri',               unit:'goluri',   ranges:[0.5,1.5,2.5],   icon:'⚽'},
  gg:     {label:'GG (Ambele marchează)', unit:'',         ranges:null,            icon:'🤝'},
  cards:  {label:'Cartonașe',            unit:'cartonașe',ranges:[0.5,1.5,2.5,3.5,4.5],icon:'🟡'},
  corners:{label:'Cornere',              unit:'cornere',  ranges:[2.5,4.5,6.5,8.5,10.5],icon:'📐'},
};

function gen2Open(){
  document.getElementById('gen2-ov').classList.add('open');
  document.getElementById('nav-gen').classList.add('active');
  G2.hist=[1];G2.scrn=1;
  g2Show(1);
}
function gen2Close(){
  document.getElementById('gen2-ov').classList.remove('open');
  document.getElementById('nav-gen').classList.remove('active');
}
function g2Show(n){
  G2.scrn=n;
  document.querySelectorAll('.gen2-scr').forEach(function(el,i){
    var s=i+1;
    el.classList.remove('act','out-l','out-r');
    if(s===n)el.classList.add('act');
    else if(s<n)el.classList.add('out-l');
    else el.classList.add('out-r');
  });
}
function gen2Back(){
  if(G2.hist.length<=1){gen2Close();return;}
  G2.hist.pop();
  var prev=G2.hist[G2.hist.length-1];
  g2Show(prev);
}
function g2Go(n){
  if(G2.hist[G2.hist.length-1]!==n)G2.hist.push(n);
  g2Show(n);
}

function gen2Mode(m){
  G2.mode=m;G2.matches=[];
  document.getElementById('g2s2-title').textContent=m==='live'?'⚡ LIVE':'📅 PRE-MECI';
  g2Go(2);
}
function gen2Cat(c){
  G2.cat=c;G2.sub=null;
  var meta=G2_CATS[c];
  if(c==='home'||c==='away'||c==='gg'){
    G2.thr=0;
    g2PrepSlider();g2Go(4);gen2Load();
  }else{
    document.getElementById('g2s3-title').textContent=meta.label;
    g2Go(3);
  }
}
function gen2Sub(s){
  G2.sub=s;
  g2PrepSlider();g2Go(4);gen2Load();
}
function g2PrepSlider(){
  var meta=G2_CATS[G2.cat];
  var wrap=document.getElementById('g2slider-wrap');
  var slider=document.getElementById('g2slider');
  var ticks=document.getElementById('g2ticks');
  document.getElementById('g2ptabs').style.display=G2.mode==='live'?'':'none';
  // title always set (before early return)
  var subLbl=G2.sub==='home'?'Gazde ':G2.sub==='away'?'Oaspeți ':G2.sub==='total'?'Total ':'';
  document.getElementById('g2s4-title').textContent=meta.icon+' '+subLbl+meta.label;
  if(!meta.ranges){wrap.style.display='none';return;}
  wrap.style.display='';
  slider.min=0;slider.max=meta.ranges.length-1;
  var defIdx=Math.min(1,meta.ranges.length-1);
  slider.value=defIdx;
  G2.thr=meta.ranges[defIdx];
  ticks.innerHTML=meta.ranges.map(function(r){return '<span>'+r+'</span>';}).join('');
  g2UpdateLbl();
}
function g2UpdateLbl(){
  var meta=G2_CATS[G2.cat];
  if(!meta||!meta.ranges)return;
  document.getElementById('g2thr-lbl').textContent=G2.thr;
  document.getElementById('g2unit-lbl').textContent=meta.unit;
}
function gen2Slide(v){
  var meta=G2_CATS[G2.cat];
  if(!meta||!meta.ranges)return;
  G2.thr=meta.ranges[parseInt(v)];
  g2UpdateLbl();
  g2RenderTop10();
}
function gen2Period(p,btn){
  G2.period=p;
  document.querySelectorAll('.g2ptab').forEach(function(t){t.classList.remove('act');});
  if(btn)btn.classList.add('act');
  g2RenderTop10();
}

async function gen2Load(){
  if(G2.loading)return;
  G2.loading=true;
  document.getElementById('g2top10').innerHTML='<div class="g2spin-wrap"><div class="g2spin"></div><div class="g2spin-lbl">Se încarcă datele...</div></div>';
  try{
    var r=await fetch('/api/generator?mode='+G2.mode);
    var d=await r.json();
    G2.matches=Array.isArray(d.matches)?d.matches:[];
    g2RenderTop10();
  }catch(e){
    document.getElementById('g2top10').innerHTML='<div class="g2spin-wrap"><div class="g2spin-lbl" style="color:var(--red)">Eroare: '+e.message+'</div></div>';
  }finally{G2.loading=false;}
}

// ── scoring ──────────────────────────────────────────────────
function g2Poi(lam,k){
  if(lam<=0)return k===0?1:0;
  var p=Math.exp(-lam);
  for(var i=0;i<k;i++)p=p*lam/(i+1);
  return p;
}
function g2Over(lam,thr){
  var need=Math.floor(thr)+1,fail=0;
  for(var k=0;k<need;k++)fail+=g2Poi(lam,k);
  return Math.max(0,Math.min(100,(1-fail)*100));
}
function g2Score(m){
  var cat=G2.cat,sub=G2.sub,thr=G2.thr,isLive=m.is_live;
  var s=0,confirmed=false;
  var lg=m.league||{avg_goals:2.5,pct_over_15:60,pct_over_25:40,pct_gg:50,avg_yellow:3.5,avg_corners:9};
  var ref=m.ref_stats;
  var h2h=m.h2h;
  var fm=m.form||{};
  var lv=m.live||{};

  // Cross-product lambdas: attack strength vs opposing defense (Poisson football model).
  // Each pair (hid, aid) produces unique lambdas even within the same league.
  var fHs=fm.home_avg_scored, fHc=fm.home_avg_conceded;
  var fAs=fm.away_avg_scored, fAc=fm.away_avg_conceded;
  var defLgH=lg.avg_goals*0.55, defLgA=lg.avg_goals*0.45;
  // Expected home goals = (home attack + away defense) / 2
  var lamH=(fHs!=null&&fAc!=null)?((fHs+fAc)/2):(fHs!=null?fHs:(fAc!=null?fAc:defLgH));
  // Expected away goals = (away attack + home defense) / 2
  var lamA=(fAs!=null&&fHc!=null)?((fAs+fHc)/2):(fAs!=null?fAs:(fHc!=null?fHc:defLgA));

  if(cat==='home'||cat==='away'){
    var isH=(cat==='home');
    var lam=isH?lamH:lamA;
    var poisS=g2Over(lam,0.5);
    var h2hS=isH?(h2h?h2h.pct_home_scores:lg.pct_gg):(h2h?h2h.pct_away_scores:lg.pct_gg);
    var lgS=lg.pct_gg;
    var livS=50;
    if(isLive){
      var curG=isH?m.home_goals:m.away_goals;
      if(curG>0){confirmed=true;livS=100;}
      else{
        var rem=Math.max(0,90-m.minute);
        var xg=isH?(lv.home_xg||0):(lv.away_xg||0);
        var xgR=m.minute>0?(xg/m.minute)*rem:0;
        livS=g2Over(Math.max(xgR,lam*rem/90),0.5);
      }
    }
    s=isLive?(poisS*.30+h2hS*.20+lgS*.15+livS*.35):(poisS*.40+h2hS*.25+lgS*.20+poisS*.15);

  }else if(cat==='goals'){
    var isT=(!sub||sub==='total'),isHG=(sub==='home');
    var lamG=isT?(lamH+lamA):(isHG?lamH:lamA);
    var poisG=g2Over(lamG,thr);
    var lgPct=thr<=1?lg.pct_over_15:lg.pct_over_25;
    var h2hPct=thr<=1?(h2h?+(h2h.pct_over_15):lgPct):(h2h?+(h2h.pct_over_25):lgPct);
    var refG=ref?g2Over(ref.avg_goals*(isT?1:0.5),thr):poisG;
    var livG=50;
    if(isLive){
      var curGG=isT?(m.home_goals+m.away_goals):(isHG?m.home_goals:m.away_goals);
      if(curGG>thr){confirmed=true;livG=100;}
      else{
        var rem2=Math.max(0,90-m.minute);
        var xgT=isT?((lv.home_xg||0)+(lv.away_xg||0)):(isHG?(lv.home_xg||0):(lv.away_xg||0));
        var xgR2=m.minute>0?(xgT/m.minute)*rem2:0;
        var need2=Math.floor(thr)+1-curGG;
        livG=need2<=0?100:g2Over(Math.max(xgR2,lamG*rem2/90),need2-1);
      }
    }
    // Sprint 4C: pentru pre-meci goals_total 1.5 / 2.5, dacă serverul a returnat
    // probabilitatea din predictions table (calculată cu Poisson + shrinkage
    // Bayesian în calcPoisson), o folosim direct ca rawScore.
    // Calibrarea g2Calibrate() se aplică în aval pe această valoare.
    var serverProbG=null;
    if(!isLive&&isT&&m.confidence!=null){
      if(thr===1.5&&typeof m.over15_prob==='number'&&m.over15_prob>0) serverProbG=m.over15_prob;
      else if(thr===2.5&&typeof m.over25_prob==='number'&&m.over25_prob>0) serverProbG=m.over25_prob;
    }
    s=serverProbG!=null?serverProbG:(isLive?(poisG*.25+lgPct*.15+h2hPct*.15+refG*.10+livG*.35):(poisG*.35+lgPct*.20+h2hPct*.25+refG*.20));

  }else if(cat==='cards'){
    var isTC=(!sub||sub==='total'),isHC=(sub==='home');
    var refYC=ref?ref.avg_yellow:null;
    var lgYC=lg.avg_yellow;
    // Use team form to modulate card expectation: high-conceding defenses → more cards
    var defIntensity=1.0;
    if(fHc!=null&&fAc!=null) defIntensity=Math.min(1.4,Math.max(0.7,(fHc+fAc)/lg.avg_goals));
    var avgC=(refYC||lgYC)*defIntensity;
    var lamC=isTC?avgC:(isHC?avgC*.55:avgC*.45);
    var poisC=g2Over(lamC,thr);
    var refC=refYC?g2Over(refYC*defIntensity*(isTC?1:(isHC?.55:.45)),thr):poisC;
    var lgC=g2Over(lgYC*defIntensity*(isTC?1:(isHC?.55:.45)),thr);
    var livC=50;
    if(isLive){
      var curC=isTC?((lv.home_cards||0)+(lv.away_cards||0)):(isHC?(lv.home_cards||0):(lv.away_cards||0));
      if(curC>thr){confirmed=true;livC=100;}
      else{
        var rem3=Math.max(0,90-m.minute);
        var cRate=m.minute>0?(curC/m.minute)*rem3:0;
        var needC=Math.floor(thr)+1-curC;
        livC=needC<=0?100:g2Over(Math.max(cRate,lamC*rem3/90),needC-1);
      }
    }
    s=isLive?(refC*.30+lgC*.15+poisC*.20+livC*.35):(refC*.40+lgC*.25+poisC*.35);

  }else if(cat==='corners'){
    var isTK=(!sub||sub==='total'),isHK=(sub==='home');
    var refK=ref?ref.avg_corners:null;
    var lgK=lg.avg_corners;
    // Attacking teams → more corners; use avg goals as proxy
    var attFactor=1.0;
    if(fHs!=null&&fAs!=null) attFactor=Math.min(1.4,Math.max(0.7,(fHs+fAs)/lg.avg_goals));
    var avgK=(refK||lgK)*attFactor;
    var lamK=isTK?avgK:(isHK?avgK*.55:avgK*.45);
    var poisK=g2Over(lamK,thr);
    var refKS=refK?g2Over(refK*attFactor*(isTK?1:(isHK?.55:.45)),thr):poisK;
    var lgKS=g2Over(lgK*attFactor*(isTK?1:(isHK?.55:.45)),thr);
    var livK=50;
    if(isLive){
      var curK=isTK?((lv.home_corners||0)+(lv.away_corners||0)):(isHK?(lv.home_corners||0):(lv.away_corners||0));
      if(curK>thr){confirmed=true;livK=100;}
      else{
        var rem4=Math.max(0,90-m.minute);
        var kRate=m.minute>0?(curK/m.minute)*rem4:0;
        var needK=Math.floor(thr)+1-curK;
        livK=needK<=0?100:g2Over(Math.max(kRate,lamK*rem4/90),needK-1);
      }
    }
    s=isLive?(refKS*.25+lgKS*.15+poisK*.25+livK*.35):(refKS*.30+lgKS*.30+poisK*.40);

  }else if(cat==='gg'){
    // P(home scores ≥1) and P(away scores ≥1) — cross-product lambdas already computed above
    var pHs=g2Over(lamH,0.5);                                   // home attack (0-100)
    var pAs=g2Over(lamA,0.5);                                   // away attack (0-100)
    var pHc=fHc!=null?g2Over(fHc,0.5):pAs;                     // home concedes (proxy: away can score)
    var pAc=fAc!=null?g2Over(fAc,0.5):pHs;                     // away concedes (proxy: home can score)
    // Gazde_atac × Oaspeti_aparare → home attacks AND away defense is porous
    var compH=(pHs/100)*(pAc/100)*100;
    // Oaspeti_atac × Gazde_aparare → away attacks AND home defense is porous
    var compA=(pAs/100)*(pHc/100)*100;
    var h2hGG=h2h?+(h2h.pct_gg):lg.pct_gg;
    var livGG=50;
    if(isLive){
      var hg=m.home_goals,ag=m.away_goals;
      if(hg>=1&&ag>=1){
        confirmed=true;livGG=100;
      }else if(hg>=1){
        // BUG #21 FIX: rem5→rem5a, xgA5→xgA5a (decuplare scope-uri)
        // Home already scored — only need away to score
        var rem5a=Math.max(0,90-m.minute);
        var xgA5a=lv.away_xg||0;
        var xgAR5=m.minute>0?(xgA5a/m.minute)*rem5a:lamA*rem5a/90;
        livGG=g2Over(Math.max(xgAR5,lamA*rem5a/90),0.5);
      }else if(ag>=1){
        // BUG #21 FIX: rem5→rem5b, xgH5→xgH5a
        // Away already scored — only need home to score
        var rem5b=Math.max(0,90-m.minute);
        var xgH5a=lv.home_xg||0;
        var xgHR5=m.minute>0?(xgH5a/m.minute)*rem5b:lamH*rem5b/90;
        livGG=g2Over(Math.max(xgHR5,lamH*rem5b/90),0.5);
      }else{
        // BUG #21 FIX: rem5→rem5c, xgH5→xgH5b, xgA5→xgA5b
        // 0-0: both still need to score
        var rem5c=Math.max(0,90-m.minute);
        var xgH5b=lv.home_xg||0,xgA5b=lv.away_xg||0;
        var xgHR5c=m.minute>0?(xgH5b/m.minute)*rem5c:lamH*rem5c/90;
        var xgAR5c=m.minute>0?(xgA5b/m.minute)*rem5c:lamA*rem5c/90;
        // 0-0 at 60+ min: boost — desperation increases scoring rates
        var pressureMult=m.minute>=60?1+(m.minute-60)/60:1;
        livGG=(g2Over(Math.max(xgHR5c,lamH*rem5c/90)*pressureMult,0.5)/100)*
              (g2Over(Math.max(xgAR5c,lamA*rem5c/90)*pressureMult,0.5)/100)*100;
      }
    }
    // Sprint 4C: server-side gg_prob (din predictions) pentru pre-meci.
    // Folosim direct ca rawScore; calibrarea g2Calibrate() se aplică în aval.
    var serverProbGG=null;
    if(!isLive&&m.confidence!=null&&typeof m.gg_prob==='number'&&m.gg_prob>0) serverProbGG=m.gg_prob;
    s=serverProbGG!=null?serverProbGG:(isLive?(compH*.25+compA*.25+h2hGG*.20+livGG*.30):(compH*.35+compA*.35+h2hGG*.30));
  }

  // Injury penalty: -8% per injured team (≥3 players), extra -12% for GG if both teams hit
  var injData=m.injuries||{};
  var hInj=injData.home||0, aInj=injData.away||0;
  var injPenalty=0;
  if(hInj>=3) injPenalty+=8;
  if(aInj>=3) injPenalty+=8;
  if(cat==='gg'&&hInj>=2&&aInj>=2) injPenalty=Math.max(injPenalty,12);
  s=Math.max(0,s-injPenalty);

  // Venue surface bonus: artificial turf → more goals/corners, fewer cards
  var surf=m.venue_surface||'';
  if(surf==='artificial'){
    if(cat==='goals'||cat==='home'||cat==='away'||cat==='gg') s=Math.min(100,s*1.05);
    else if(cat==='corners') s=Math.min(100,s*1.08);
    else if(cat==='cards')   s=Math.max(0,s*0.97);
  }

  // Clean sheets penalty for GG (from teams_stats fallback data)
  if(cat==='gg'){
    var csH=fm.home_cs_rate||0, csA=fm.away_cs_rate||0;
    if(csH>0.35) s=Math.max(0,s*(1-(csH-0.35)));
    if(csA>0.35) s=Math.max(0,s*(1-(csA-0.35)));
  }

  var rawScore=Math.round(Math.max(0,Math.min(100,s)));
  return{score:rawScore,rawScore:rawScore,calibrated:g2Calibrate(cat,sub,thr,rawScore,m),confirmed:confirmed};
}

// Calibrare scor brut → probabilitate reală (din backtest 1000 meciuri V2)
// V2 = dupa h2h backfill, formula este BIMODALA: sub 50% real 0%, peste 70% real 100%

// Live-adjusted probability bazat pe Bayes simplu cu Poisson rates.
// Returneaza null daca meciul nu este live, altfel % ajustat la minutul curent.
function g2LiveAdjust(m, cat, sub, thr){
  var liveSet={'1H':1,'HT':1,'2H':1,'ET':1};
  if(!liveSet[m.status_short])return null;
  var elapsed=Math.max(0, Math.min(90, m.minute||0));
  var minLeft=Math.max(1, 90-elapsed);
  var remFrac=minLeft/90;
  var hg=m.home_goals||0, ag=m.away_goals||0;
  // Lambda per side (per 90min) — fallback la liga daca form lipseste
  var lgAvg=(m.league&&m.league.avg_goals)||2.5;
  var lamH=Math.max(0.3, (m.form&&m.form.home_avg_scored)||lgAvg*0.55);
  var lamA=Math.max(0.3, (m.form&&m.form.away_avg_scored)||lgAvg*0.45);
  var remLamH=lamH*remFrac, remLamA=lamA*remFrac;
  function p1OrMore(lam){return 1-Math.exp(-lam);}
  function pPois(k,lam){
    if(lam<=0)return k===0?1:0;
    var lp=-lam+k*Math.log(lam);
    for(var i=1;i<=k;i++)lp-=Math.log(i);
    return Math.exp(lp);
  }
  function pAtLeast(k,lam){
    var p=0;for(var i=0;i<k;i++)p+=pPois(i,lam);
    return Math.max(0,Math.min(1,1-p));
  }
  var prob=null;
  if(cat==='home'){prob=hg>0?1:p1OrMore(remLamH);}
  else if(cat==='away'){prob=ag>0?1:p1OrMore(remLamA);}
  else if(cat==='gg'){
    if(hg>0&&ag>0)prob=1;
    else if(hg>0)prob=p1OrMore(remLamA);
    else if(ag>0)prob=p1OrMore(remLamH);
    else prob=p1OrMore(remLamH)*p1OrMore(remLamA);
  }
  else if(cat==='goals'){
    if(sub==='home'||sub==='away'){
      var tg=sub==='home'?hg:ag;
      var tl=sub==='home'?remLamH:remLamA;
      var nd=Math.ceil((thr||0.5)+0.5-tg);
      prob=nd<=0?1:pAtLeast(nd,tl);
    }else{
      var totG=hg+ag, totLam=remLamH+remLamA;
      var nd2=Math.ceil((thr||0.5)+0.5-totG);
      prob=nd2<=0?1:pAtLeast(nd2,totLam);
    }
  }
  else if(cat==='corners'&&m.live){
    var hcv=(typeof m.live.home_corners==='number')?m.live.home_corners:null;
    var acv=(typeof m.live.away_corners==='number')?m.live.away_corners:null;
    if(hcv===null&&acv===null)return null;  // fara date live → pre-meci pass-through
    var lgCorn=(m.league&&m.league.avg_corners)||9;
    var perSideCorn=lgCorn/2;
    var remCornH=perSideCorn*remFrac, remCornA=perSideCorn*remFrac;
    if(sub==='home'){
      var nd3=Math.ceil((thr||0.5)+0.5-(hcv||0));
      prob=nd3<=0?1:pAtLeast(nd3,remCornH);
    }else if(sub==='away'){
      var nd4=Math.ceil((thr||0.5)+0.5-(acv||0));
      prob=nd4<=0?1:pAtLeast(nd4,remCornA);
    }else{
      var totC=(hcv||0)+(acv||0);
      var nd5=Math.ceil((thr||0.5)+0.5-totC);
      prob=nd5<=0?1:pAtLeast(nd5,remCornH+remCornA);
    }
  }
  else if(cat==='cards'&&m.live){
    var hcdv=(typeof m.live.home_cards==='number')?m.live.home_cards:null;
    var acdv=(typeof m.live.away_cards==='number')?m.live.away_cards:null;
    if(hcdv===null&&acdv===null)return null;
    var lgCards=(m.league&&m.league.avg_yellow)||3.5;
    var perSideCard=lgCards/2;
    var remCardH=perSideCard*remFrac, remCardA=perSideCard*remFrac;
    if(sub==='home'){
      var nd6=Math.ceil((thr||0.5)+0.5-(hcdv||0));
      prob=nd6<=0?1:pAtLeast(nd6,remCardH);
    }else if(sub==='away'){
      var nd7=Math.ceil((thr||0.5)+0.5-(acdv||0));
      prob=nd7<=0?1:pAtLeast(nd7,remCardA);
    }else{
      var totCd=(hcdv||0)+(acdv||0);
      var nd8=Math.ceil((thr||0.5)+0.5-totCd);
      prob=nd8<=0?1:pAtLeast(nd8,remCardH+remCardA);
    }
  }
  else return null;
  return Math.round(100*prob);
}

// EV recalc pentru Generator (similar cu evRecalc din modal)
function g2EvRecalc(inputId, realProb, displayId){
  var el=document.getElementById(inputId);
  var disp=document.getElementById(displayId);
  if(!el||!disp)return;
  var raw=(el.value||'').toString().replace(',','.');
  var cota=parseFloat(raw);
  if(!cota||cota<1.01){disp.innerHTML='&mdash;';disp.style.color='var(--mu)';return;}
  try{localStorage.setItem(inputId, cota.toString());}catch(e){}
  var ev=realProb*cota-1;
  var evPct=Math.round(ev*100);
  var sign=ev>=0?'+':'';
  var color, icon, label;
  if(ev>=0.08){color='#22c55e';icon='✅';label='profitabil';}
  else if(ev>=0){color='#f59e0b';icon='⚠️';label='marginal';}
  else{color='#ef4444';icon='❌';label='NU paria';}
  disp.innerHTML='<span style="color:'+color+'">EV: '+sign+evPct+'% '+icon+' '+label+'</span>';
}

function g2RenderTop10(){
  var el=document.getElementById('g2top10');
  if(!G2.matches.length){
    el.innerHTML='<div class="g2spin-wrap"><div class="g2spin-lbl">Niciun meci disponibil</div></div>';
    return;
  }
  var scored=G2.matches.map(function(m){
    var r=g2Score(m);return{m:m,score:r.calibrated,raw:r.rawScore,confirmed:r.confirmed};
  });
  // Filtru prag minim
  if(G2.minScore>0){
    scored=scored.filter(function(item){return item.confirmed||item.score>=G2.minScore;});
  }
  scored.sort(function(a,b){
    if(a.confirmed!==b.confirmed)return a.confirmed?1:-1;
    return b.score-a.score;
  });
  G2.top10=scored.slice(0,10);
  var isTested=g2CalibrationTested(G2.cat);
  var html='';
  // Construiesc market label din G2 category (folosit pentru pickContext)
  var g2Meta=G2_CATS[G2.cat]||{label:G2.cat};
  var g2SubLbl=G2.sub==='home'?'Gazde ':G2.sub==='away'?'Oaspe&#539;i ':G2.sub==='total'?'Total ':'';
  var g2MktLbl=(G2.cat==='home'||G2.cat==='away')?g2Meta.label:(g2SubLbl+g2Meta.label+' Over '+G2.thr);
  G2.top10.forEach(function(item,idx){
    var m=item.m,pct=item.score,raw=item.raw,done=item.confirmed;
    // Live-adjust pentru lista (afisat ca % principal)
    var pLive=g2LiveAdjust(m, G2.cat, G2.sub, G2.thr);
    var displayPct=(pLive!==null)?pLive:pct;
    var clr=displayPct>=75?'#22c55e':displayPct>=55?'#f59e0b':'#ef4444';
    var sub='';
    if(m.is_live)sub='<span class="gen-live-dot"></span>'+m.minute+'\' · '+m.home_goals+'-'+m.away_goals;
    else if(m.match_date)sub=new Date(m.match_date).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+' · '+(m.league_name||'');
    var fid=m.fixture_id;
    var fav=fid?isFav(fid):false;
    var minCotaG2=displayPct>0?(100/displayPct).toFixed(2):'1.00';
    var roundedPct=Math.round(displayPct);
    var mktLblEsc=g2MktLbl.replace(/'/g,"\\'");
    html+='<div class="g2row'+(done?' g2done':'')+'">';
    var hLogo=m.home_logo?'<img src="'+m.home_logo+'" width="20" height="20" style="border-radius:3px;object-fit:contain;vertical-align:middle;margin-right:4px" onerror="this.style.display=\'none\'">':'';
    var aLogo=m.away_logo?'<img src="'+m.away_logo+'" width="20" height="20" style="border-radius:3px;object-fit:contain;vertical-align:middle;margin-right:4px" onerror="this.style.display=\'none\'">':'';
    // Star + rank inline pentru a economisi spatiu
    html+='<div class="g2rank" style="display:flex;align-items:center;gap:4px">';
    if(fid)html+='<button class="star-btn'+(fav?' active':'')+'" onclick="event.stopPropagation();toggleFavGen('+idx+',this,\''+mktLblEsc+'\','+minCotaG2+','+roundedPct+')">'+(fav?'⭐':'☆')+'</button>';
    html+='#'+(idx+1)+'</div>';
    html+='<div class="g2row-info" onclick="g2Detail('+idx+')" style="cursor:pointer">';
    html+='<div class="g2row-teams">'+hLogo+(m.home_team||'?')+' <span style="color:var(--mu)">vs</span> '+aLogo+(m.away_team||'?')+(done?'<span class="g2conf-badge">✓</span>':'')+'</div>';
    html+='<div class="g2row-sub">'+sub+'</div>';
    html+='</div>';
    html+='<div class="g2row-pct" onclick="g2Detail('+idx+')" style="color:'+clr+';cursor:pointer">'+roundedPct+'%</div>';
    if(pLive!==null&&Math.abs(pLive-pct)>3)html+='<div style="font-size:9px;color:var(--mu);margin-left:4px">pre:'+Math.round(pct)+'%</div>';
    else if(isTested&&Math.abs(raw-pct)>3)html+='<div style="font-size:9px;color:var(--mu);margin-left:4px">brut:'+raw+'%</div>';
    html+='</div>';
  });
  // Header cu disclaimer per categorie
  var header='';
  if(isTested){
    header='<div style="font-size:10px;color:var(--mu);padding:6px 12px;background:rgba(34,197,94,.05);border-left:3px solid #22c55e;margin-bottom:8px">✓ <b>Calibrat empiric</b> pe backtest '+(PREDICTIONS_COUNT>0?PREDICTIONS_COUNT.toLocaleString():'1.000')+' meciuri. Procentele reflectă probabilitatea reală măsurată.</div>';
  }else if(g2CalibrationHeuristic(G2.cat)){
    header='<div style="font-size:10px;color:var(--mu);padding:6px 12px;background:rgba(59,130,246,.05);border-left:3px solid #3b82f6;margin-bottom:8px">📐 <b>Calibrat Poisson teoretic</b> (sample backtest 46 meciuri prea mic — folosim distribuția Poisson pe media de ligă, robustă matematic).</div>';
  }else{
    header='<div style="font-size:10px;color:var(--mu);padding:6px 12px;background:rgba(245,158,11,.05);border-left:3px solid #f59e0b;margin-bottom:8px">⚠ <b>Necalibrat</b>. Procentele sunt scoruri brute.</div>';
  }
  // Filtru prag minim încredere
  var filterUI='<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(255,255,255,.03);border-radius:8px;margin-bottom:8px;font-size:11px">';
  filterUI+='<span style="color:var(--mu);font-weight:600">FILTRU:</span>';
  filterUI+='<span style="color:var(--mu)">prag minim</span>';
  filterUI+='<select onchange="G2.minScore=parseInt(this.value);g2RenderTop10()" style="background:rgba(255,255,255,.05);border:1px solid var(--bor);color:var(--tx);padding:4px 8px;border-radius:6px;font-size:11px;font-weight:600">';
  [0,50,60,70,75,80,85,90].forEach(function(v){
    filterUI+='<option value="'+v+'"'+(G2.minScore===v?' selected':'')+'>'+(v===0?'Toate':v+'%+')+'</option>';
  });
  filterUI+='</select>';
  filterUI+='<span style="color:var(--mu);margin-left:auto">'+G2.top10.length+'/'+G2.matches.length+'</span>';
  filterUI+='</div>';
  el.innerHTML=header+filterUI+html;
}

function g2Detail(idx){
  var item=G2.top10[idx];if(!item)return;
  var m=item.m,pct=item.score;
  var meta=G2_CATS[G2.cat];
  var subLbl=G2.sub==='home'?'Gazde ':G2.sub==='away'?'Oaspeți ':G2.sub==='total'?'Total ':'';
  var mktLbl=(G2.cat==='home'||G2.cat==='away')?meta.label:(subLbl+meta.label+' Over '+G2.thr);
  var clr=pct>=75?'#22c55e':pct>=55?'#f59e0b':'#ef4444';
  document.getElementById('g2s5-title').textContent=(m.home_team||'?')+' vs '+(m.away_team||'?');
  var h='';
  // hero
  var dHLogo=m.home_logo?'<img src="'+m.home_logo+'" width="28" height="28" style="border-radius:4px;object-fit:contain;vertical-align:middle;margin-right:6px" onerror="this.style.display=\'none\'">':'';
  var dALogo=m.away_logo?'<img src="'+m.away_logo+'" width="28" height="28" style="border-radius:4px;object-fit:contain;vertical-align:middle;margin-right:6px" onerror="this.style.display=\'none\'">':'';
  var hInjTxt=(m.injuries&&m.injuries.home>=2)?' <span style="color:#f59e0b;font-size:11px;vertical-align:middle">⚠️ '+m.injuries.home+'</span>':'';
  var aInjTxt=(m.injuries&&m.injuries.away>=2)?' <span style="color:#f59e0b;font-size:11px;vertical-align:middle">⚠️ '+m.injuries.away+'</span>':'';
  // Live-adjusted probability (Bayes Poisson pe minutele ramase)
  var pLive=g2LiveAdjust(m, G2.cat, G2.sub, G2.thr);
  var displayPct=pct, isLiveMatch=(pLive!==null);
  if(isLiveMatch){displayPct=pLive;clr=pLive>=75?'#22c55e':pLive>=55?'#f59e0b':'#ef4444';}
  h+='<div class="g2hero">';
  h+='<div class="g2hero-match">'+dHLogo+(m.home_team||'?')+hInjTxt+' <span style="opacity:.5">vs</span> '+dALogo+(m.away_team||'?')+aInjTxt+'</div>';
  h+='<div class="g2hero-mkt">'+meta.icon+' '+mktLbl+(isLiveMatch?' <span style="color:#ef4444;font-size:10px;font-weight:700;background:rgba(239,68,68,.15);padding:2px 6px;border-radius:4px;margin-left:6px">🔴 LIVE '+(m.minute||0)+"'</span>":'')+'</div>';
  h+='<div class="g2hero-pct" style="color:'+clr+'">'+Math.round(displayPct)+'%</div>';
  if(isLiveMatch){
    var diff=Math.round(pLive-pct);
    var diffSign=diff>=0?'+':'';
    var diffColor=diff>=0?'#22c55e':'#ef4444';
    h+='<div style="font-size:11px;color:var(--mu);margin-top:6px">Pre-meci: <b style="color:var(--tx)">'+Math.round(pct)+'%</b> &middot; Ajustat live: <b style="color:'+diffColor+'">'+diffSign+diff+'pp</b></div>';
  }
  h+='</div>';
  // formă
  h+='<div class="g2section"><div class="g2sec-title">📊 Formă recentă</div>';
  if(m.form.home_avg_scored!==null)h+='<div class="g2srow"><span class="g2srow-l">Media goluri marcate acasă</span><span class="g2srow-v">'+Number(m.form.home_avg_scored).toFixed(2)+'/meci</span></div>';
  if(m.form.away_avg_scored!==null)h+='<div class="g2srow"><span class="g2srow-l">Media goluri marcate deplasare</span><span class="g2srow-v">'+Number(m.form.away_avg_scored).toFixed(2)+'/meci</span></div>';
  if(m.form.home_last5)h+='<div class="g2srow"><span class="g2srow-l">Formă gazde (ult. 5 acasă)</span><span class="g2srow-v" style="font-family:monospace;letter-spacing:2px">'+m.form.home_last5+'</span></div>';
  if(m.form.away_last5)h+='<div class="g2srow"><span class="g2srow-l">Formă oaspeți (ult. 5 deplas.)</span><span class="g2srow-v" style="font-family:monospace;letter-spacing:2px">'+m.form.away_last5+'</span></div>';
  if(m.form._ts_fallback)h+='<div class="g2srow"><span class="g2srow-l" style="color:var(--mu)">Sursa: statistici sezon complet</span></div>';
  else if(!m.form.home_avg_scored&&!m.form.home_last5)h+='<div class="g2srow"><span class="g2srow-l" style="color:var(--mu)">Date insuficiente în DB</span></div>';
  if(m.venue_surface==='artificial')h+='<div class="g2srow"><span class="g2srow-l">⚽ Teren artificial</span><span class="g2srow-v" style="color:var(--ac)">+5% goluri · +8% cornere</span></div>';
  if(m.injuries&&(m.injuries.home>=2||m.injuries.away>=2)){
    h+='<div class="g2srow"><span class="g2srow-l">🚑 Accidentați</span><span class="g2srow-v" style="color:#f59e0b">';
    if(m.injuries.home>=2)h+=(m.home_team||'?')+': '+m.injuries.home;
    if(m.injuries.home>=2&&m.injuries.away>=2)h+=' · ';
    if(m.injuries.away>=2)h+=(m.away_team||'?')+': '+m.injuries.away;
    h+='</span></div>';
  }
  h+='</div>';
  // h2h
  if(m.h2h&&m.h2h.total>=3){
    h+='<div class="g2section"><div class="g2sec-title">📊 Head to Head ('+m.h2h.total+' meciuri)</div>';
    h+='<div class="g2srow"><span class="g2srow-l">Media goluri</span><span class="g2srow-v">'+Number(m.h2h.avg_goals).toFixed(2)+'/meci</span></div>';
    h+='<div class="g2srow"><span class="g2srow-l">% Over 1.5 goluri</span><span class="g2srow-v">'+Math.round(m.h2h.pct_over_15)+'%</span></div>';
    h+='<div class="g2srow"><span class="g2srow-l">% Over 2.5 goluri</span><span class="g2srow-v">'+Math.round(m.h2h.pct_over_25)+'%</span></div>';
    h+='<div class="g2srow"><span class="g2srow-l">% Ambele marchează</span><span class="g2srow-v">'+Math.round(m.h2h.pct_gg)+'%</span></div>';
    h+='</div>';
  }
  // liga
  h+='<div class="g2section"><div class="g2sec-title">📊 Statistică ligă — '+(m.league_name||'')+'</div>';
  h+='<div class="g2srow"><span class="g2srow-l">Media goluri/meci</span><span class="g2srow-v">'+Number(m.league.avg_goals).toFixed(2)+'</span></div>';
  h+='<div class="g2srow"><span class="g2srow-l">% Over 1.5</span><span class="g2srow-v">'+Math.round(m.league.pct_over_15)+'%</span></div>';
  h+='<div class="g2srow"><span class="g2srow-l">% Over 2.5</span><span class="g2srow-v">'+Math.round(m.league.pct_over_25)+'%</span></div>';
  if(G2.cat==='cards')h+='<div class="g2srow"><span class="g2srow-l">Media cartonașe/meci</span><span class="g2srow-v">'+Number(m.league.avg_yellow).toFixed(1)+'</span></div>';
  if(G2.cat==='corners')h+='<div class="g2srow"><span class="g2srow-l">Media cornere/meci</span><span class="g2srow-v">'+Number(m.league.avg_corners).toFixed(1)+'</span></div>';
  h+='</div>';
  // arbitru
  if(m.ref_stats&&m.referee){
    h+='<div class="g2section"><div class="g2sec-title">📊 Arbitru — '+m.referee+'</div>';
    h+='<div class="g2srow"><span class="g2srow-l">Media goluri/meci</span><span class="g2srow-v">'+Number(m.ref_stats.avg_goals).toFixed(2)+'</span></div>';
    h+='<div class="g2srow"><span class="g2srow-l">Media cartonașe galbene</span><span class="g2srow-v">'+Number(m.ref_stats.avg_yellow).toFixed(1)+'/meci</span></div>';
    h+='<div class="g2srow"><span class="g2srow-l">Media cornere</span><span class="g2srow-v">'+Number(m.ref_stats.avg_corners).toFixed(1)+'/meci</span></div>';
    h+='</div>';
  }
  // live context
  if(m.is_live&&m.live){
    var hc=m.live.home_corners, ac=m.live.away_corners;
    var hcd=m.live.home_cards, acd=m.live.away_cards;
    var hcOK=(typeof hc==='number'), acOK=(typeof ac==='number');
    var hcdOK=(typeof hcd==='number'), acdOK=(typeof acd==='number');
    h+='<div class="g2section"><div class="g2sec-title">📊 Context live · '+m.minute+'\'</div>';
    h+='<div class="g2srow"><span class="g2srow-l">Scor</span><span class="g2srow-v">'+m.home_goals+' - '+m.away_goals+'</span></div>';
    if(m.live.home_xg||m.live.away_xg)h+='<div class="g2srow"><span class="g2srow-l">xG total</span><span class="g2srow-v">'+Number(m.live.home_xg+m.live.away_xg).toFixed(2)+'</span></div>';
    // Cornere: afisez intotdeauna daca am date (chiar si 0-0). Highlight daca piata e corners.
    var isCornersMkt=(G2.cat==='corners');
    if(hcOK||acOK){
      var cornStyle=isCornersMkt?' style="background:rgba(59,130,246,.1);padding:6px 8px;border-radius:6px;border-left:2px solid #3b82f6"':'';
      h+='<div class="g2srow"'+cornStyle+'><span class="g2srow-l">⚽ Cornere'+(isCornersMkt?' <b style="color:#3b82f6">(piața ta)</b>':'')+'</span><span class="g2srow-v">'+(hc||0)+' - '+(ac||0)+(isCornersMkt?' (total '+((hc||0)+(ac||0))+')':'')+'</span></div>';
    }else if(isCornersMkt){
      h+='<div class="g2srow" style="background:rgba(245,158,11,.1);padding:6px 8px;border-radius:6px"><span class="g2srow-l" style="color:#f59e0b">⚠ Cornere live indisponibile</span><span class="g2srow-v" style="color:var(--mu);font-size:10px">(statistics nepreluat)</span></div>';
    }
    // Cartonase: la fel
    var isCardsMkt=(G2.cat==='cards');
    if(hcdOK||acdOK){
      var cardStyle=isCardsMkt?' style="background:rgba(59,130,246,.1);padding:6px 8px;border-radius:6px;border-left:2px solid #3b82f6"':'';
      h+='<div class="g2srow"'+cardStyle+'><span class="g2srow-l">🟨 Cartonașe'+(isCardsMkt?' <b style="color:#3b82f6">(piața ta)</b>':'')+'</span><span class="g2srow-v">'+(hcd||0)+' - '+(acd||0)+(isCardsMkt?' (total '+((hcd||0)+(acd||0))+')':'')+'</span></div>';
    }
    h+='</div>';
  }
  // AI concluzie
  h+='<div class="g2ai"><div class="g2ai-title">🧠 Concluzie</div><div class="g2ai-text">'+g2Conclusion(m,pct,mktLbl)+'</div></div>';
  document.getElementById('g2detail').innerHTML=h;
  g2Go(5);
}

function g2Conclusion(m,pct,mktLbl){
  var parts=[];
  var cat=G2.cat;
  parts.push(pct>=75?'Probabilitate ridicată ('+Math.round(pct)+'%) pentru '+mktLbl+'.':pct>=55?'Probabilitate medie ('+Math.round(pct)+'%) pentru '+mktLbl+'.':'Probabilitate relativ scăzută ('+Math.round(pct)+'%) pentru '+mktLbl+'.');
  if(m.h2h&&m.h2h.total>=3&&(cat==='goals'||cat==='home'||cat==='away'))parts.push('H2H arată o medie de '+Number(m.h2h.avg_goals).toFixed(1)+' goluri/meci pe '+(m.h2h.total)+' meciuri directe.');
  if(cat==='gg'){
    if(m.h2h&&m.h2h.total>=3)parts.push('În '+Math.round(m.h2h.pct_gg)+'% din cele '+m.h2h.total+' meciuri directe au marcat ambele echipe.');
    if(m.form.home_avg_scored!=null&&m.form.away_avg_scored!=null)parts.push('Gazda marchează în medie '+Number(m.form.home_avg_scored).toFixed(2)+' goluri/meci acasă, oaspetele '+Number(m.form.away_avg_scored).toFixed(2)+' goluri/meci în deplasare.');
    if(m.is_live&&m.home_goals===0&&m.away_goals===0&&m.minute>=60)parts.push('Scor 0-0 după '+m.minute+' minute — presiunea pentru gol crește semnificativ.');
    if(m.is_live&&(m.home_goals>=1||m.away_goals>=1)&&!(m.home_goals>=1&&m.away_goals>=1))parts.push((m.home_goals>=1?'Gazda':'Oaspetele')+' a marcat deja — acum e nevoie ca și '+(m.home_goals>=1?'oaspetele':'gazda')+' să marcheze.');
  }
  if(m.ref_stats&&m.referee&&cat==='cards')parts.push('Arbitrul '+m.referee+' acordă în medie '+Number(m.ref_stats.avg_yellow).toFixed(1)+' cartonașe galbene per meci.');
  if(m.ref_stats&&m.referee&&cat==='corners')parts.push('Sub arbitrul '+m.referee+' se bat în medie '+Number(m.ref_stats.avg_corners).toFixed(1)+' cornere per meci.');
  if(m.is_live&&m.minute>=60&&(m.home_goals+m.away_goals)===0)parts.push('Scor 0-0 după '+m.minute+' minute — riscul de gol final rămâne ridicat.');
  if(m.form.home_avg_scored>2&&cat==='goals')parts.push('Gazda marchează în medie '+Number(m.form.home_avg_scored).toFixed(2)+' goluri/meci acasă în sezonul curent.');
  return parts.join(' ')||'Analizează contextul și decide cu atenție.';
}

function genOpen(){gen2Open();}
function genClose(){gen2Close();}
function genOpenSim(){
  document.getElementById('gen2-ov').classList.add('open');
  document.getElementById('nav-gen').classList.add('active');
  G2.hist=[1,6];G2.scrn=6;
  g2Show(6);
  simPopulateDropdown();
}

function genOpenAccum(){
  document.getElementById('gen2-ov').classList.add('open');
  document.getElementById('nav-gen').classList.add('active');
  G2.hist=[1,7];G2.scrn=7;
  g2Show(7);
}

async function loadAccumulator(){
  var resEl=document.getElementById('accum-result');
  var tMin=parseFloat(document.getElementById('accum-min').value)||1.50;
  var tMax=parseFloat(document.getElementById('accum-max').value)||2.00;
  var mode=document.getElementById('accum-mode').value||'prematch';
  resEl.innerHTML='<div class="g2spin-wrap"><div class="g2spin"></div><div class="g2spin-lbl">Se calculează biletul optim...</div></div>';
  try{
    var r=await fetch('/api/generator?action=accumulator&mode='+mode+'&target_min='+tMin+'&target_max='+tMax);
    var d=await r.json();
    if(!d.ok)throw new Error(d.error||'Eroare server');
    var ac=d.accumulator;
    if(!ac||!ac.selections||!ac.selections.length){
      resEl.innerHTML='<div style="text-align:center;color:var(--mu);padding:24px">Nu există meciuri suficiente azi pentru bilet.</div>';
      return;
    }
    var html='';
    // Header
    var oddsColor=ac.target_met?'#22c55e':'#f59e0b';
    html+='<div style="background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.25);border-radius:12px;padding:14px;margin-bottom:12px;text-align:center">';
    html+='<div style="font-size:11px;color:var(--mu);margin-bottom:4px">COTĂ COMBINATĂ (fair odds fără marjă)</div>';
    html+='<div style="font-size:32px;font-weight:900;color:'+oddsColor+'">×'+ac.combined_odds+'</div>';
    html+='<div style="font-size:12px;color:var(--mu);margin-top:4px">Probabilitate combinată: <strong style="color:#22c55e">'+ac.combined_prob+'%</strong></div>';
    if(ac.note)html+='<div style="font-size:11px;color:#f59e0b;margin-top:6px">'+ac.note+'</div>';
    html+='</div>';
    // Selecții
    html+='<div style="font-size:11px;color:var(--mu);margin-bottom:6px;font-weight:700;text-transform:uppercase;letter-spacing:.5px">'+ac.selections.length+' SELECȚII</div>';
    ac.selections.forEach(function(s,i){
      var probColor=s.prob>=85?'#22c55e':s.prob>=75?'#f59e0b':'#818cf8';
      html+='<div style="background:rgba(255,255,255,.04);border:1px solid var(--bor);border-radius:10px;padding:12px;margin-bottom:8px">';
      html+='<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">';
      if(s.home_logo)html+='<img src="'+s.home_logo+'" width="16" height="16" style="border-radius:2px" onerror="this.style.display=\'none\'">';
      html+='<span style="font-size:12px;font-weight:700;flex:1">'+htmlEsc(s.match)+'</span>';
      if(s.away_logo)html+='<img src="'+s.away_logo+'" width="16" height="16" style="border-radius:2px" onerror="this.style.display=\'none\'">';
      html+='</div>';
      var leagueLine=htmlEsc(s.league||'');
      if(s.league_country)leagueLine='<span style="opacity:.6">'+htmlEsc(s.league_country)+'</span> · '+leagueLine;
      html+='<div style="font-size:10px;color:var(--mu);margin-bottom:6px">'+leagueLine+'</div>';
      html+='<div style="display:flex;align-items:center;justify-content:space-between">';
      html+='<span style="background:rgba(34,197,94,.12);color:#22c55e;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:800">'+htmlEsc(s.label)+'</span>';
      html+='<span style="font-size:13px;font-weight:800;color:'+probColor+'">'+s.prob+'%</span>';
      html+='<span style="font-size:12px;color:var(--mu)">×'+s.fair_odds+'</span>';
      html+='</div>';
      html+='</div>';
    });
    html+='<div style="font-size:10px;color:var(--mu);margin-top:8px;text-align:center">Fair odds = 1/probabilitate (fără marja bookmaker). Cotele reale pot fi mai mici.</div>';
    resEl.innerHTML=html;
  }catch(e){
    resEl.innerHTML='<div style="color:var(--red);text-align:center;padding:20px">'+e.message+'</div>';
  }
}

function genUpdateBadge(){} // stub — badge înlocuit cu design nou


// ── FAVORITES ─────────────────────────────────────────────────
var FAVS_KEY='alohascan_favs';
function loadFavs(){try{var s=localStorage.getItem(FAVS_KEY);return s?JSON.parse(s):{items:[]};}catch(e){return{items:[]};}}
function saveFavs(d){try{localStorage.setItem(FAVS_KEY,JSON.stringify(d));}catch(e){}}
function isFav(fid){
  var d=loadFavs();
  for(var i=0;i<d.items.length;i++){if(d.items[i].fid===fid)return true;}
  return false;
}
function toggleFav(fid,btn){
  var m=ST.ms.find(function(x){return x.fixture&&x.fixture.id===fid;});
  var ed=m&&(m.enrichData||_genLiveEnrich[fid])||null;
  _toggleFavCommon(fid,'live',m,ed,btn);
}
function toggleFavPM(fid,btn){
  var m=_pmMatches.find(function(x){return x.fixture&&x.fixture.id===fid;});
  var ed=_pmEnrich[fid]||null;
  _toggleFavCommon(fid,'pre',m,ed,btn);
}
function _toggleFavCommon(fid,type,m,ed,btn,pickContext){
  var d=loadFavs();
  var idx=-1;
  for(var i=0;i<d.items.length;i++){if(d.items[i].fid===fid){idx=i;break;}}
  if(idx>=0){
    // Already favorite — daca am pickContext nou, doar updatez context (nu sterg)
    if(pickContext){
      d.items[idx].pickContext=pickContext;
      if(btn){btn.classList.add('active');btn.textContent='⭐';}
    }else{
      // Toggle clasic — sterg
      d.items.splice(idx,1);
      if(btn){btn.classList.remove('active');btn.textContent='☆';}
    }
  }else{
    var entry={fid:fid,type:type,m:m,ed:ed,savedAt:new Date().toISOString()};
    if(pickContext)entry.pickContext=pickContext;
    d.items.push(entry);
    if(btn){btn.classList.add('active');btn.textContent='⭐';}
  }
  saveFavs(d);
  updateFavBadge();
  if(document.getElementById('tab-fav').classList.contains('active'))renderFavs();
}
// Variants pentru a apela cu pick context din Top Oportunitati
function toggleFavPMWithPick(fid,btn,pickMarket,pickMinCota,pickCal){
  var m=_pmMatches.find(function(x){return x.fixture&&x.fixture.id===fid;});
  var ed=_pmEnrich[fid]||null;
  _toggleFavCommon(fid,'pre',m,ed,btn,{market:pickMarket,minCota:pickMinCota,cal:pickCal});
}
// Variant pentru tab-ul Genereaza (G2.top10) — datele sunt in format diferit
function toggleFavGen(idx,btn,pickMarket,pickMinCota,pickCal){
  var item=G2&&G2.top10&&G2.top10[idx];
  if(!item||!item.m)return;
  var gm=item.m;
  var fid=gm.fixture_id;
  if(!fid)return;
  // Convertesc match-ul Gen in format API-Football (necesar pentru renderFavs)
  var converted={
    fixture:{id:fid,date:gm.match_date},
    teams:{
      home:{id:gm.home_team_id||null,name:gm.home_team||'?',logo:gm.home_logo||null},
      away:{id:gm.away_team_id||null,name:gm.away_team||'?',logo:gm.away_logo||null},
    },
    league:{id:gm.league_id||null,name:gm.league_name||'',flag:gm.league_flag||null,logo:gm.league_logo||null},
    goals:{home:gm.home_goals||0,away:gm.away_goals||0},
  };
  var type=gm.is_live?'live':'pre';
  _toggleFavCommon(fid,type,converted,null,btn,{market:pickMarket,minCota:pickMinCota,cal:pickCal});
}
function updateFavBadge(){
  var n=loadFavs().items.length;
  var b=document.getElementById('fav-badge');
  if(b){b.textContent=n>99?'99+':String(n);b.style.display=n>0?'flex':'none';}
}
function removeFav(fid){
  var d=loadFavs();
  d.items=d.items.filter(function(x){return x.fid!==fid;});
  saveFavs(d);
  updateFavBadge();
  renderFavs();
}
function clearAllFavs(){
  if(!confirm('Ștergi toate preferatele?'))return;
  saveFavs({items:[]});
  updateFavBadge();
  renderFavs();
}
function renderFavs(){
  var d=loadFavs();
  var body=document.getElementById('fav-body');
  if(!body)return;
  if(!d.items.length){
    body.innerHTML='<div class="empty"><div class="empty-icon">⭐</div><div class="empty-t">Niciun favorit</div><div class="empty-s">Apasă ⭐ pe orice meci pentru a-l salva</div></div>';
    return;
  }
  var sp=body.scrollTop;
  var ec=function(v){return v==null?'#888':v>=70?'#22c55e':v>=50?'#f59e0b':'#ef4444';};
  function favCard(item){
    var m=item.m;if(!m)return '';
    if(item.type==='live'){
      var lm=ST.ms.find(function(x){return x.fixture&&x.fixture.id===item.fid;});
      if(lm)m=lm;
    }
    var fid=item.fid;
    var hid=m.teams&&m.teams.home&&m.teams.home.id||0;
    var aid=m.teams&&m.teams.away&&m.teams.away.id||0;
    var hn=m.teams&&m.teams.home&&m.teams.home.name||'—';
    var an=m.teams&&m.teams.away&&m.teams.away.name||'—';
    var lg=m.league&&m.league.name||'';
    var flag=m.league&&m.league.flag?'<img src="'+m.league.flag+'" style="width:12px;height:9px;object-fit:cover;border-radius:2px;margin-right:4px;">':'';
    var ed=item.type==='live'?(m.enrichData||_genLiveEnrich[fid]||item.ed):(_pmEnrich[fid]||item.ed);
    var hg=m.goals?m.goals.home||0:0;
    var ag=m.goals?m.goals.away||0:0;
    var timeStr='';
    if(item.type==='live'){
      var mn=m.fixture&&m.fixture.status&&m.fixture.status.elapsed||0;
      var sh=m.fixture&&m.fixture.status&&m.fixture.status.short||'';
      var ex=m.fixture&&m.fixture.status&&m.fixture.status.extra;
      var isLv=['1H','2H','HT','ET','P'].indexOf(sh)>=0;
      var _fb=matchTimeBadge(sh,mn,ex);
      timeStr=isLv?'<span style="color:'+_fb.c+';font-size:10px;font-family:monospace">'+(_fb.dot?'● ':'')+_fb.t+'</span>':'<span style="color:#6b7280;font-size:10px">FINAL</span>';
    }else{
      timeStr=m.fixture&&m.fixture.date?'<span style="font-size:10px;color:var(--mu)">🕐 '+new Date(m.fixture.date).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+'</span>':'';
    }
    var s='<div class="pm-card">';
    s+='<div class="pm-header" style="cursor:pointer" onclick="mdOpen('+fid+','+hid+','+aid+',this)">';
    s+='<div class="pm-kickoff"><button class="star-btn active" onclick="event.stopPropagation();removeFav('+fid+')">⭐</button>'+flag+lg+' · '+timeStr+'</div>';
    s+='<div class="pm-teams">'+tLogo(m.teams&&m.teams.home,32)+'<span>'+hn+'</span><span style="color:var(--mu)">'+hg+' - '+ag+'</span>'+tLogo(m.teams&&m.teams.away,32)+'<span>'+an+'</span></div>';
    s+='</div>';
    if(ed&&ed.homeWin!=null){
      s+='<div class="pm-body" style="cursor:pointer" onclick="mdOpen('+fid+','+hid+','+aid+',this)">';
      s+='<div class="pm-meter-row"><div class="pm-meter-label">Over 1.5</div><div class="pm-meter-bar"><div class="pm-meter-fill" style="width:'+Math.min(Number(ed.over15Prob)||0,100)+'%;background:'+ec(ed.over15Prob)+'"></div></div><div class="pm-meter-pct" style="color:'+ec(ed.over15Prob)+'">'+pctTxt(ed.over15Prob)+'</div></div>';
      s+='<div class="enrich-row hda-row"><span style="color:'+ec(ed.homeWin)+'">H:'+pctTxt(ed.homeWin)+'</span><span style="color:'+ec(ed.draw)+'">D:'+pctTxt(ed.draw)+'</span><span style="color:'+ec(ed.awayWin)+'">A:'+pctTxt(ed.awayWin)+'</span></div>';
      s+='</div>';
    }
    s+='</div>';
    return s;
  }
  var html='<div class="fav-header"><span class="fav-header-t">'+d.items.length+' meciuri salvate</span><button class="fav-clear-btn" onclick="clearAllFavs()">Sterge toate</button></div>';
  var live=d.items.filter(function(x){return x.type==='live';});
  var pre=d.items.filter(function(x){return x.type==='pre';});
  if(live.length){
    html+='<div class="pm-summary"><span class="pm-summary-t">⚽ LIVE ('+live.length+')</span></div>';
    html+=live.map(favCard).join('');
  }
  if(pre.length){
    html+='<div class="pm-summary"><span class="pm-summary-t">📅 UPCOMING ('+pre.length+')</span></div>';
    html+=pre.map(favCard).join('');
  }
  body.innerHTML=html;
  body.scrollTop=sp;
}


// ── INIT ──────────────────────────────────────────────────────
renderWR(loadWR());fetchSupabaseWinRate();
updateFavBadge();
// auto-connect disabled — splash screen handles first connect
// 30s auto-refresh for PM and Favs tabs
setInterval(function(){
  var tabPre=document.getElementById('tab-pre');
  var tabFav=document.getElementById('tab-fav');
  // Bug fix: dacă userul a navigat pe altă zi în date picker (pmLoadDate
  // setează PM_DATE), NU forțez reload-ul la /api/today — altfel view-ul
  // istoric/viitor era suprascris cu meciurile de azi după 30s.
  var todayLocal=(typeof pmTodayStr==='function')?pmTodayStr():null;
  var onOtherDay=(typeof PM_DATE==='string')&&PM_DATE&&todayLocal&&PM_DATE!==todayLocal;
  if(!onOtherDay&&tabPre&&tabPre.classList.contains('active')&&_pmMatches.length){
    fetch('/api/today').then(function(r){return r.json();}).then(function(d){
      var raw=Array.isArray(d.response)?d.response:Array.isArray(d)?d:[];
      if(!raw.length)return;
      var body=document.getElementById('pm-body');
      var sp=body?body.scrollTop:0;
      _pmMatches=raw.sort(function(a,b){return new Date(a.fixture.date)-new Date(b.fixture.date);});
      renderPM();
      if(body)body.scrollTop=sp;
    }).catch(function(){});
  }
  if(tabFav&&tabFav.classList.contains('active')){renderFavs();}
},30000);


// ══════════════════════════════════════════════════════════════
// SIMULATOR
// ══════════════════════════════════════════════════════════════
var _simData=null;

function simPopulateDropdown(){
  var sel=document.getElementById('sim-match-sel');
  if(!sel)return;
  var liveCount=ST&&ST.ms?ST.ms.length:0;
  var pmCount=_pmMatches?_pmMatches.length:0;
  var options='<option value="">— alege meci ('+(liveCount+pmCount)+' disponibile) —</option>';
  // Live matches — all of them
  if(liveCount){
    options+='<optgroup label="🔴 Live ('+liveCount+')">';
    ST.ms.forEach(function(m){
      var fid=m.fixture&&m.fixture.id;
      var hid=m.teams&&m.teams.home&&m.teams.home.id;
      var aid=m.teams&&m.teams.away&&m.teams.away.id;
      var lid=m.league&&m.league.id||0;
      if(!fid||!hid||!aid)return;
      var mn=m.fixture.status&&m.fixture.status.elapsed?m.fixture.status.elapsed+"' ":"";
      var sc=m.goals?(m.goals.home||0)+'-'+(m.goals.away||0):'';
      var label=(m.teams.home.name||'?')+' vs '+(m.teams.away.name||'?');
      if(mn||sc)label+=' ('+mn+(sc?'| '+sc:'').trim()+')';
      options+='<option value="'+fid+','+hid+','+aid+','+lid+'">'+label+'</option>';
    });
    options+='</optgroup>';
  }
  // Pre-match — all available matches
  if(pmCount){
    options+='<optgroup label="📅 Upcoming ('+pmCount+')">';
    _pmMatches.forEach(function(m){
      var fid=m.fixture&&m.fixture.id;
      var hid=m.teams&&m.teams.home&&m.teams.home.id;
      var aid=m.teams&&m.teams.away&&m.teams.away.id;
      var lid=m.league&&m.league.id||0;
      if(!fid||!hid||!aid)return;
      var time=m.fixture&&m.fixture.date?new Date(m.fixture.date).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'';
      var label=(m.teams.home.name||'?')+' vs '+(m.teams.away.name||'?')+(time?' ('+time+')':'');
      options+='<option value="'+fid+','+hid+','+aid+','+lid+'">'+label+'</option>';
    });
    options+='</optgroup>';
  }
  sel.innerHTML=options;
  sel.onchange=function(){
    var v=this.value;if(!v)return;
    var parts=v.split(',');
    document.getElementById('sim-fid').value=parts[0]||'';
    document.getElementById('sim-hid').value=parts[1]||'';
    document.getElementById('sim-aid').value=parts[2]||'';
    document.getElementById('sim-lid').value=parts[3]||'';
  };
}

async function simRun(){
  var fid=parseInt(document.getElementById('sim-fid').value)||0;
  var hid=parseInt(document.getElementById('sim-hid').value)||0;
  var aid=parseInt(document.getElementById('sim-aid').value)||0;
  var lid=parseInt(document.getElementById('sim-lid').value)||0;
  if(!fid||!hid||!aid){alert('Completează Fixture ID, Home ID și Away ID!');return;}

  document.getElementById('sim-run-btn').disabled=true;
  document.getElementById('sim-results').style.display='none';
  document.getElementById('sim-loading').style.display='block';

  // Animate counter
  var countEl=document.getElementById('sim-count-lbl');
  var fillEl=document.getElementById('sim-prog-fill');
  // [P20] Bara e un simplu indicator de încărcare (animație vizuală), NU reflectă
  // progresul real al simulării server-side. Nu mai afișăm un contor fabricat de
  // scenarii („4,231 / 10,000") care sugera fals un progres real — doar o etichetă
  // onestă. Numărul real (10.000) e cel din /api/simulate, afișat la finalizare.
  var step=0,dur=2500,interval=50;
  var steps=dur/interval;
  countEl.textContent='Se simulează 10.000 scenarii…';
  var timer=setInterval(function(){
    step++;
    var pct=Math.min(95,Math.round(step/steps*95));  // se oprește la 95% până vine răspunsul
    fillEl.style.width=pct+'%';
    if(step>=steps)clearInterval(timer);
  },interval);

  try{
    var url='/api/simulate?fixture_id='+fid+'&home_id='+hid+'&away_id='+aid+'&league_id='+lid;
    var r=await fetch(url);
    var d=await r.json();
    clearInterval(timer);
    fillEl.style.width='100%';
    countEl.textContent='10,000 / 10,000 scenarii';
    await new Promise(function(res){setTimeout(res,400);});
    document.getElementById('sim-loading').style.display='none';
    if(d.error){document.getElementById('sim-results').innerHTML='<div class="empty"><div class="empty-icon">⚠️</div><div class="empty-t">Eroare</div><div class="empty-s">'+d.error+'</div></div>';document.getElementById('sim-results').style.display='block';return;}
    _simData=d;
    simRender(d);
  }catch(e){
    clearInterval(timer);
    document.getElementById('sim-loading').style.display='none';
    document.getElementById('sim-results').innerHTML='<div class="empty"><div class="empty-icon">⚠️</div><div class="empty-t">Eroare rețea</div><div class="empty-s">'+e.message+'</div></div>';
    document.getElementById('sim-results').style.display='block';
  }finally{
    document.getElementById('sim-run-btn').disabled=false;
  }
}

function simColor(v){return v>=70?'#22c55e':v>=50?'#f59e0b':'#ef4444';}

function simRender(d){
  var fix=d.fixture||{};
  var rd=d.realData||{};
  var sim=d.simulation||{};
  var mom=d.momentum;
  var rec=d.recommendation;
  var ec=simColor;

  var html='';

  // ── Expected score block ──────────────────────────────────
  html+='<div class="sim-score-block">';
  html+='<div class="sim-teams">'+(fix.homeTeam||'Gazde')+' vs '+(fix.awayTeam||'Oaspeți')+'</div>';
  if(sim.isLive){
    html+='<div style="font-size:11px;color:#ef4444;font-weight:700;margin-bottom:4px">🔴 LIVE · min '+sim.elapsed+"' · Scor "+sim.currentScore+'</div>';
    html+='<div style="font-size:10px;color:var(--mu);margin-bottom:4px">Simulare din minutul '+sim.elapsed+' — probabilitățile se referă la goluri adiționale față de scorul curent</div>';
  }
  html+='<div class="sim-score-big">'+sim.expectedScore+'</div>';
  html+='<div class="sim-likely">Scor probabil: <strong>'+(sim.mostLikelyScore||'?')+'</strong>';
  var topProb=sim.scoreDistribution&&sim.scoreDistribution[0]?sim.scoreDistribution[0].prob:null;
  if(topProb)html+=' ('+topProb+'%)';
  html+='</div>';
  // Badges: model calibrat + ligi WR per istoric DB
  var calibBadge=sim.modelCalibrated?'<span style="font-size:10px;background:rgba(99,102,241,0.18);color:#818cf8;border-radius:8px;padding:2px 8px;font-weight:700">🧠 Model calibrat</span>':'<span style="font-size:10px;background:rgba(100,116,139,0.15);color:var(--mu);border-radius:8px;padding:2px 8px">📊 Model generic</span>';
  var lgId=fix.leagueId||parseInt(document.getElementById('sim-lid')?.value||0,10);
  var lgWrBadge='';
  if(GOOD_LEAGUES[lgId])lgWrBadge=' <span style="font-size:10px;background:rgba(34,197,94,.15);color:#22c55e;border-radius:8px;padding:2px 8px;font-weight:700;border:1px solid rgba(34,197,94,.25)" title="Win rate istoric Over 1.5 in aceasta liga">⚡ Lig&#259; '+GOOD_LEAGUES[lgId].wr+'% WR (n='+GOOD_LEAGUES[lgId].n+')</span>';
  else if(BAD_LEAGUES[lgId])lgWrBadge=' <span style="font-size:10px;background:rgba(239,68,68,.12);color:#ef4444;border-radius:8px;padding:2px 8px;font-weight:700" title="Liga cu performanta slaba pe Over 1.5">⚠ Lig&#259; doar '+BAD_LEAGUES[lgId].wr+'% WR (n='+BAD_LEAGUES[lgId].n+')</span>';
  html+='<div style="margin-top:6px;display:flex;justify-content:center;flex-wrap:wrap;gap:4px">'+calibBadge+lgWrBadge+'</div>';
  html+='</div>';

  // ── Result bars ───────────────────────────────────────────
  html+='<div class="sim-section"><div class="sim-section-title">PROBABILITĂȚI REZULTAT</div>';
  var results=[
    ['1 '+fix.homeTeam,sim.results&&sim.results.homeWin||0,'#22c55e'],
    ['X Egal',         sim.results&&sim.results.draw    ||0,'#f59e0b'],
    ['2 '+fix.awayTeam,sim.results&&sim.results.awayWin ||0,'#ef4444'],
  ];
  results.forEach(function(row){
    html+='<div class="sim-bar-row"><div class="sim-bar-lbl">'+row[0]+'</div>';
    html+='<div class="sim-bar"><div class="sim-bar-fill" style="width:'+row[1]+'%;background:'+row[2]+'"></div></div>';
    html+='<div class="sim-bar-val">'+row[1]+'%</div></div>';
  });
  html+='</div>';

  // ── Score distribution ────────────────────────────────────
  if(sim.scoreDistribution&&sim.scoreDistribution.length){
    html+='<div class="sim-section"><div class="sim-section-title">DISTRIBUȚIE SCORURI (top '+sim.scoreDistribution.length+')</div>';
    html+='<div class="sim-score-grid">';
    sim.scoreDistribution.forEach(function(s,i){
      html+='<div class="sim-score-item"><span class="sim-score-name">'+s.score+(i===0?'<span class="sim-score-badge">TOP</span>':'')+'</span><span class="sim-score-prob">'+s.prob+'%</span></div>';
    });
    html+='</div></div>';
  }

  // ── Markets — RAW (Poisson) + CALIBRAT (din backtest 1000 meciuri post h2h-fix)
  // Calibrarea V2 e antrenata pe meciuri PRE-MECI la final. Pe LIVE matches
  // (lambda dynamic, scor curent != 0-0), aplicarea directa STRICA predictiile
  // (under 40% raw -> 0% cal, peste 70% -> 100%). Pentru LIVE pastram raw.
  if(sim.markets){
    var isLiveSim=!!sim.isLive;
    html+='<div class="sim-section"><div class="sim-section-title">PIEȚE '+(isLiveSim?'— LIVE (Poisson dinamic)':'— calibrat la istoric real')+'</div>';
    var ci=sim.confidenceIntervals||{};
    var calMkts=[
      ['Over 0.5 total', sim.markets.over05, 'goals','total',0.5],
      ['Over 1.5 total', sim.markets.over15, 'goals','total',1.5],
      ['Over 2.5 total', sim.markets.over25, 'goals','total',2.5],
      ['GG ambele marc.',sim.markets.gg,     'gg',   'total',0],
    ];
    // Parse scor curent pentru LIVE calibration lookup
    var liveHg=0, liveAg=0;
    if(isLiveSim&&sim.currentScore){
      var parts=sim.currentScore.split('-');
      liveHg=parseInt(parts[0]||'0',10);
      liveAg=parseInt(parts[1]||'0',10);
    }
    calMkts.forEach(function(row){
      var lbl=row[0],raw=row[1],cat=row[2],sub=row[3],thr=row[4];
      if(typeof raw!=='number')return;
      var displayProb, calSource, calNote;
      if(isLiveSim){
        // LIVE: incearca calibrare LIVE din DB
        var marketKey=cat==='gg'?'gg':(thr>=2.5?'over25':'over15');
        var liveCal=liveCalibrate(sim.elapsed||0,liveHg,liveAg,marketKey);
        if(liveCal&&liveCal.n>=10){
          displayProb=Math.round(liveCal.pct);
          calSource='live-cal';
          calNote='calibrat LIVE (n='+liveCal.n+' meciuri istorice in acelasi context)';
        }else{
          displayProb=Math.round(raw);
          calSource='raw';
          calNote='Poisson live (lambda redus dupa min '+sim.elapsed+')';
        }
      }else{
        displayProb=g2Calibrate(cat,sub,thr,Math.round(raw));
        calSource='pre-cal';
      }
      var minCota=displayProb>0?(100/displayProb).toFixed(2):'—';
      html+='<div style="margin-bottom:10px;padding:8px 10px;background:rgba(255,255,255,.03);border-radius:8px">';
      html+='<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">';
      html+='<span style="font-size:12px;color:var(--tx);font-weight:600">'+lbl+(calSource==='live-cal'?' <span style="font-size:9px;background:rgba(99,102,241,.2);color:#a5b4fc;padding:1px 5px;border-radius:4px;font-weight:700">🎯 LIVE-CAL</span>':'')+'</span>';
      html+='<span style="font-weight:800;font-size:16px;color:'+ec(displayProb)+'">'+displayProb+'%</span>';
      html+='</div>';
      html+='<div style="position:relative;height:6px;background:var(--bor);border-radius:3px;overflow:hidden;margin-bottom:4px">';
      html+='<div style="position:absolute;left:0;width:'+displayProb+'%;height:100%;background:'+ec(displayProb)+';border-radius:3px"></div></div>';
      html+='<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--mu)">';
      if(calSource==='live-cal'){
        html+='<span>'+calNote+(Math.abs(displayProb-Math.round(raw))>3?' <span style="color:var(--ac)">vs Poisson '+Math.round(raw)+'%</span>':'')+'</span>';
      }else if(isLiveSim){
        html+='<span>'+calNote+'</span>';
      }else{
        html+='<span>raw MC: '+Math.round(raw)+'%'+(Math.abs(displayProb-Math.round(raw))>3?' <span style="color:var(--ac)">→ '+(displayProb>raw?'+':'')+(displayProb-Math.round(raw))+'pp</span>':'')+'</span>';
      }
      html+='<span>cot&#259; min &ge; <b style="color:var(--tx)">'+minCota+'</b></span>';
      html+='</div></div>';
    });
    var mkts2=[
      ['Over 3.5',sim.markets.over35],
      ['BTTS No', sim.markets.bttsNo],
    ];
    html+='<div class="sim-market-grid" style="margin-top:4px">';
    mkts2.forEach(function(m){
      html+='<div class="sim-market-item"><div class="sim-market-name">'+m[0]+'</div>';
      html+='<div class="sim-market-val" style="color:'+ec(m[1])+'">'+m[1]+'%</div></div>';
    });
    html+='</div>';
    if(isLiveSim){
      html+='<div style="font-size:10px;color:var(--mu);margin-top:8px;line-height:1.4;padding:6px 8px;background:rgba(239,68,68,.06);border-left:2px solid #ef4444;border-radius:4px">🔴 <b>Mod LIVE</b>: probabilit&#259;&#539;ile sunt Poisson direct (lambda redus dupa minute r&#259;mase). Calibrarea V2 din backtest e antrenat&#259; doar pe pre-meci la final, nu pe momente LIVE.</div>';
    }else{
      html+='<div style="font-size:10px;color:var(--mu);margin-top:8px;line-height:1.4;padding:6px 8px;background:rgba(59,130,246,.05);border-left:2px solid #3b82f6;border-radius:4px">📐 Probabilit&#259;&#539;ile sunt <b>calibrate empiric</b> pe 1000 meciuri istorice post-h2h backfill (Brier 0.08-0.13).</div>';
    }
    html+='</div>';
  }

  // ── Goal timing — real distribution from match_events ────────
  var gmd=sim.goalMinuteDistribution||sim.goalTiming;
  if(gmd){
    var gmdSrc=sim.goalMinuteSource||'';
    var gmdN=sim.goalMinuteCount||0;
    var isReal=gmdSrc&&gmdSrc.indexOf('statistică FIFA')<0;
    var srcNote=isReal
      ?'<span style="color:#22c55e">✅</span> Distribuție calculată din <b>'+gmdN+'</b> goluri reale'
      :'<span style="color:var(--mu)">📊</span> Distribuție statistică FIFA (date insuficiente)';
    html+='<div class="sim-section">';
    html+='<div class="sim-section-title">DISTRIBUȚIE MINUTE GOLURI <span style="font-size:10px;font-weight:400;color:var(--mu)">'+gmdSrc+'</span></div>';
    Object.entries(gmd).forEach(function(e){
      html+='<div class="sim-timing-row"><div class="sim-timing-lbl">'+e[0]+"'</div>";
      html+='<div class="sim-timing-bar"><div class="sim-timing-fill" style="width:'+e[1]+'%"></div></div>';
      html+='<div class="sim-timing-val">'+e[1]+'%</div></div>';
    });
    html+='<div style="font-size:10px;color:var(--mu);margin-top:6px">'+srcNote+'</div>';
    html+='</div>';
  }

  // ── Scenarios ─────────────────────────────────────────────
  if(sim.scenarios&&(sim.scenarios.optimist||sim.scenarios.pessimist||sim.scenarios.surprise)){
    var sc=sim.scenarios;
    html+='<div class="sim-section"><div class="sim-section-title">SCENARII</div>';
    html+='<div style="background:var(--sur2);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:6px">';
    if(sc.optimist)html+='<div style="display:flex;justify-content:space-between;align-items:center"><span>🟢 <strong>Optimist</strong> <span style="font-size:10px;color:var(--mu)">(top 10%)</span></span><span style="font-weight:800;color:#22c55e">'+sc.optimist.score+' <span style="font-size:10px;font-weight:400;color:var(--mu)">('+sc.optimist.prob+'%)</span></span></div>';
    if(sc.pessimist)html+='<div style="display:flex;justify-content:space-between;align-items:center"><span>🔴 <strong>Pesimist</strong> <span style="font-size:10px;color:var(--mu)">(bot 10%)</span></span><span style="font-weight:800;color:#ef4444">'+sc.pessimist.score+' <span style="font-size:10px;font-weight:400;color:var(--mu)">('+sc.pessimist.prob+'%)</span></span></div>';
    if(sc.surprise)html+='<div style="display:flex;justify-content:space-between;align-items:center"><span>⚡ <strong>Surpriză</strong></span><span style="font-weight:800;color:#f59e0b">'+sc.surprise.score+' <span style="font-size:10px;font-weight:400;color:var(--mu)">('+sc.surprise.prob+'%)</span></span></div>';
    html+='</div></div>';
  }

  // ── Contextual factors ────────────────────────────────────
  if(d.factors&&d.factors.length){
    html+='<div class="sim-section"><div class="sim-section-title">FACTORI INFLUENȚĂ</div>';
    html+='<div style="background:var(--sur2);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:6px">';
    d.factors.forEach(function(f){
      html+='<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">';
      html+='<span style="font-size:12px">'+f.icon+' '+htmlEsc(f.text)+'</span>';
      html+='<span style="font-size:11px;color:var(--mu);white-space:nowrap">'+htmlEsc(f.impact)+'</span>';
      html+='</div>';
    });
    html+='</div></div>';
  }

  // ── Momentum ──────────────────────────────────────────────
  if(mom){
    html+='<div class="sim-section"><div class="sim-section-title">MOMENTUM LIVE</div>';
    html+='<div style="background:var(--sur2);border-radius:10px;padding:12px">';
    var ms=mom.score; // -100 to +100
    var pct=Math.round((ms+100)/2); // 0-100% (50=balanced)
    var mColor=ms>0?'#22c55e':ms<0?'#ef4444':'#f59e0b';
    html+='<div class="sim-momentum-wrap">';
    if(ms>=0){
      html+='<div class="sim-momentum-fill" style="left:50%;width:'+Math.min(50,pct-50)+'%;background:'+mColor+'"></div>';
    }else{
      html+='<div class="sim-momentum-fill" style="left:'+pct+'%;width:'+(50-pct)+'%;background:'+mColor+'"></div>';
    }
    html+='</div>';
    html+='<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--mu);margin-top:4px">';
    html+='<span>'+fix.homeTeam+' '+(ms>=0?'<strong style="color:'+mColor+'">+'+ ms+'</strong>':ms)+'</span>';
    html+='<span>'+(ms<0?'<strong style="color:'+mColor+'">'+ms+'</strong>':ms)+' '+fix.awayTeam+'</span>';
    html+='</div>';
    html+='<div style="text-align:center;font-size:11px;color:var(--mu2);margin-top:6px">'+mom.description+'</div>';
    html+='</div></div>';
  }

  // ── Elo ───────────────────────────────────────────────────
  html+='<div class="sim-section"><div class="sim-section-title">ELO RATING</div>';
  html+='<div class="sim-elo-row">';
  html+='<div class="sim-elo-box"><div class="sim-elo-val">'+rd.homeElo+'</div><div class="sim-elo-lbl">'+fix.homeTeam+'</div>';
  if(rd.homeForm&&rd.homeForm.form5){html+='<div class="sim-form-chips">';rd.homeForm.form5.forEach(function(f){html+='<span class="sim-form-chip '+f+'">'+f+'</span>';});html+='</div>';}
  html+='</div>';
  html+='<div style="display:flex;align-items:center;padding:0 8px;font-size:11px;color:var(--mu)">vs</div>';
  html+='<div class="sim-elo-box"><div class="sim-elo-val">'+rd.awayElo+'</div><div class="sim-elo-lbl">'+fix.awayTeam+'</div>';
  if(rd.awayForm&&rd.awayForm.form5){html+='<div class="sim-form-chips">';rd.awayForm.form5.forEach(function(f){html+='<span class="sim-form-chip '+f+'">'+f+'</span>';});html+='</div>';}
  html+='</div></div></div>';

  // ── Referee + League real data ────────────────────────────
  if(rd.referee||rd.leagueAvgGoals){
    html+='<div class="sim-section"><div class="sim-section-title">DATE REALE LIGĂ & ARBITRU</div>';
    html+='<table class="sim-data-tbl">';
    if(rd.leagueAvgGoals){
      html+='<tr><td>Medie goluri/meci ligă</td><td style="text-align:right"><b>'+rd.leagueAvgGoals+'</b> <span style="color:var(--mu);font-size:10px">('+rd.leagueSource+')</span></td></tr>';
    }
    if(rd.leagueOver15Pct!=null)html+='<tr><td>% Over 1.5 în ligă</td><td style="text-align:right"><b>'+rd.leagueOver15Pct+'%</b></td></tr>';
    if(rd.leagueGGPct!=null)html+='<tr><td>% GG în ligă</td><td style="text-align:right"><b>'+rd.leagueGGPct+'%</b></td></tr>';
    if(rd.referee){
      html+='<tr><td>Arbitru</td><td style="text-align:right">'+htmlEsc(rd.referee)+'</td></tr>';
      if(rd.refereeStyle)html+='<tr><td>Stil arbitru</td><td style="text-align:right"><b style="color:var(--ac)">'+rd.refereeStyle+'</b>'+(rd.refereeMatches?' ('+rd.refereeMatches+' meciuri)':'')+'</td></tr>';
      if(rd.refereeAvgGoals)html+='<tr><td>Medie goluri arbitru</td><td style="text-align:right"><b>'+rd.refereeAvgGoals+'</b></td></tr>';
    }
    if(rd.homeFormSource||rd.awayFormSource){
      html+='<tr><td>Sursă formă gazde</td><td style="text-align:right" style="color:var(--mu)">'+( rd.homeFormSource||'—')+'</td></tr>';
      html+='<tr><td>Sursă formă oaspeți</td><td style="text-align:right" style="color:var(--mu)">'+( rd.awayFormSource||'—')+'</td></tr>';
    }
    html+='</table></div>';
  }

  // ── Data sources ──────────────────────────────────────────
  if(rd.dataSources){
    html+='<div class="sim-section"><div class="sim-section-title">SURSE DATE';
    html+='<span style="float:right;color:var(--ac)">'+rd.dataQuality+'</span></div>';
    html+='<table class="sim-data-tbl">';
    var srcLabels={fixture:'Meci curent',homeForm:'Formă gazde',awayForm:'Formă oaspeți',h2h:'H2H',lineups:'Formații',homePlayers:'Jucători gazde',awayPlayers:'Jucători oaspeți',standings:'Clasament',odds:'Cote',leagueStats:'Statistici ligă',referee:'Arbitru',liveStats:'Stats live'};
    Object.entries(rd.dataSources).forEach(function(e){
      html+='<tr><td>'+(srcLabels[e[0]]||e[0])+'</td><td style="text-align:right">'+e[1]+'</td></tr>';
    });
    html+='</table></div>';
  }

  // ── Recommendation ────────────────────────────────────────
  if(rec){
    html+='<div class="sim-rec-box">';
    html+='<div class="sim-rec-title">🎯 CEA MAI BUNĂ PIAȚĂ</div>';
    html+='<div class="sim-rec-bet">'+rec.bestBet+'</div>';
    html+='<div class="sim-rec-meta">Probabilitate model: <span style="color:var(--ac)">'+rec.confidence+'%</span></div>';
    html+='<div class="sim-rec-reason">'+rec.reasoning+'</div>';
    html+='</div>';
  }

  var out=document.getElementById('sim-results');
  out.innerHTML=html;
  out.style.display='block';
}


/* ─── SPLASH SCREEN CONTROLLER (PNG logo) ────────────────────── */
(function(){
  var tapped = false;
  window.splashTap = function(){
    if(tapped) return;
    tapped = true;
    var logo   = document.getElementById('spl-logo');
    var splash = document.getElementById('splash');
    if(logo){ logo.classList.remove('spl-idle'); logo.classList.add('spl-tapped'); }
    if(splash) splash.classList.add('spl-exit');
    setTimeout(function(){
      if(splash) splash.style.display = 'none';
      if(typeof setTab === 'function') setTab('live');
      if(typeof connect === 'function') connect();
    }, 750);
  };
  document.addEventListener('DOMContentLoaded', function(){
    /* Idle pulse pe logo dupa 1.5s (cand fade-in s-a terminat) */
    setTimeout(function(){
      var logo = document.getElementById('spl-logo');
      if(logo && !tapped) logo.classList.add('spl-idle');
    }, 1500);
  });
})();
// adjustPageTop no-op — wr-bar este acum INTERIORUL .page (sticky), zero gap.
function adjustPageTop(){}


// ── MODAL ISTORIC CALIBRARE ───────────────────────────────────────
// Permite verificare: cand modelul zice X%, ce % real are istoric
async function showHistoricModal(){
  var modal=document.getElementById('hist-modal');
  var body=document.getElementById('hist-modal-body');
  modal.style.display='block';
  body.innerHTML='<div style="text-align:center;color:var(--mu);padding:30px;font-size:12px">⏳ Se &icirc;ncarc&#259;...</div>';
  try{
    var r=await fetch('/api/calibration');
    var d=await r.json();
    if(!d.ok){body.innerHTML='<div style="color:#ef4444;padding:14px">Eroare: '+(d.error||'unknown')+'</div>';return;}
    var h='';

    // ─── INTRO ───
    h+='<div style="background:rgba(34,197,94,.06);border-left:3px solid #22c55e;padding:10px;border-radius:6px;margin-bottom:14px;font-size:11.5px;line-height:1.5">';
    h+='💡 <b>Ce vezi aici</b>: harta dintre ce <b>afișeaz&#259; aplica&#539;ia</b> și ce s-a &icirc;nt&acirc;mplat <b>real</b> &icirc;n istoric. Dac&#259; modelul zice 80% și istoric arat&#259; 65%, modelul <b>supraestimeaz&#259;</b>. Folosește ca verificare a &icirc;ncrederii &icirc;n predic&#539;ii.';
    h+='</div>';

    // ─── BRIER LEGENDA ───
    h+='<div style="background:rgba(255,255,255,.03);padding:10px;border-radius:6px;margin-bottom:14px">';
    h+='<div style="font-size:11px;font-weight:800;color:var(--tx);margin-bottom:6px">📐 BRIER SCOR — Cum interpretezi</div>';
    h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px">';
    h+='<div><span style="color:#22c55e;font-weight:800">&lt; 0.10</span> &nbsp;Excep&#539;ional 🌟</div>';
    h+='<div><span style="color:#22c55e;font-weight:800">0.10-0.15</span> &nbsp;Excelent ✅</div>';
    h+='<div><span style="color:#f59e0b;font-weight:800">0.15-0.22</span> &nbsp;OK ⚠️</div>';
    h+='<div><span style="color:#ef4444;font-weight:800">0.22-0.30</span> &nbsp;Slab ❌</div>';
    h+='<div><span style="color:#ef4444;font-weight:800">&gt; 0.30</span> &nbsp;Foarte slab 🔴</div>';
    h+='</div>';
    h+='<div style="font-size:10px;color:var(--mu);margin-top:6px;line-height:1.4">Brier = medie ((predic&#539;ie - real)&#178;). Mai mic = mai precis. Cu mai multe predic&#539;ii rezolvate, scorul scade automat.</div>';
    h+='</div>';

    // ─── PRE-MECI ───
    h+='<div style="margin-bottom:14px">';
    h+='<div style="font-size:13px;font-weight:800;color:#22c55e;margin-bottom:6px">📅 PRE-MECI — Calibrare predic&#539;ii</div>';
    var preMods=d.modules||{};
    var preKeys=Object.keys(preMods);
    if(!preKeys.length){
      h+='<div style="color:var(--mu);padding:10px;font-size:11px">Calibrare lipsește. Cron-ul a rulat dar tabela e goal&#259;.</div>';
    }else{
      preKeys.forEach(function(modKey){
        var m=preMods[modKey];
        var brierClr=!m.brier?'var(--mu)':m.brier<0.15?'#22c55e':m.brier<0.22?'#f59e0b':'#ef4444';
        h+='<div style="background:rgba(255,255,255,.03);padding:10px;border-radius:6px;margin-bottom:10px">';
        h+='<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">';
        h+='<div style="font-weight:700;font-family:monospace;font-size:12px">'+modKey+'</div>';
        h+='<div style="font-size:10px;color:var(--mu)">n='+m.n+' &middot; Brier <b style="color:'+brierClr+'">'+(m.brier?m.brier.toFixed(3):'—')+'</b></div>';
        h+='</div>';
        if(m.buckets&&m.buckets.length){
          h+='<table style="width:100%;border-collapse:collapse;font-size:11px">';
          h+='<thead><tr style="color:var(--mu);font-size:10px"><th style="text-align:left;padding:3px 0">Model zice</th><th style="text-align:right">Real %</th><th style="text-align:right">Diff</th><th style="text-align:right">Samples</th></tr></thead><tbody>';
          m.buckets.forEach(function(b){
            // diff = bucket-mid - real
            var mid=(b.min+b.max)/2;
            var diff=b.pct-mid;
            var diffClr=Math.abs(diff)<5?'var(--mu)':diff>0?'#22c55e':'#ef4444';
            var diffTxt=(diff>=0?'+':'')+Math.round(diff)+'pp';
            h+='<tr style="border-top:1px solid rgba(255,255,255,.04)">';
            h+='<td style="padding:4px 0">'+b.min+'-'+b.max+'%</td>';
            h+='<td style="text-align:right;font-weight:700">'+b.pct+'%</td>';
            h+='<td style="text-align:right;color:'+diffClr+';font-weight:700">'+diffTxt+'</td>';
            h+='<td style="text-align:right;color:var(--mu)">'+b.n+'</td>';
            h+='</tr>';
          });
          h+='</tbody></table>';
          h+='<div style="font-size:10px;color:var(--mu);margin-top:4px;line-height:1.3">📖 Citire: pe linia <b>70-80%</b>, modelul prezice 70-80%. Coloana „Real" arat&#259; <b>ce % din meciuri au avut rezultat pozitiv</b>. Diff <span style="color:#22c55e">verde</span> = real &gt; model (subestima). <span style="color:#ef4444">Roșu</span> = real &lt; model (supraestima).</div>';
        }
        h+='</div>';
      });
    }
    h+='</div>';

    // ─── LIVE ───
    h+='<div>';
    h+='<div style="font-size:13px;font-weight:800;color:#6366f1;margin-bottom:6px">🎯 LIVE — Pattern pe (minut + scor)</div>';
    var live=d.live||{};
    var liveKeys=Object.keys(live);
    if(!liveKeys.length){
      h+='<div style="color:var(--mu);padding:10px;font-size:11px">Calibrare LIVE lipsește.</div>';
    }else{
      // Group by market
      var byMarket={};
      liveKeys.forEach(function(k){
        var parts=k.split('|');
        var mb=parts[0],ss=parts[1],mkt=parts[2];
        if(!byMarket[mkt])byMarket[mkt]={};
        if(!byMarket[mkt][mb])byMarket[mkt][mb]={};
        byMarket[mkt][mb][ss]=live[k];
      });
      var mktOrder=['over15','over25','gg'];
      mktOrder.forEach(function(mkt){
        if(!byMarket[mkt])return;
        var mktLbl=mkt==='over15'?'Over 1.5':mkt==='over25'?'Over 2.5':'GG (ambele marc.)';
        h+='<div style="background:rgba(255,255,255,.03);padding:10px;border-radius:6px;margin-bottom:10px">';
        h+='<div style="font-weight:700;font-size:12px;margin-bottom:6px">'+mktLbl+'</div>';
        h+='<table style="width:100%;border-collapse:collapse;font-size:11px">';
        h+='<thead><tr style="color:var(--mu);font-size:10px"><th style="text-align:left;padding:3px 0">Minut</th><th style="text-align:left">Scor</th><th style="text-align:right">Real %</th><th style="text-align:right">N</th></tr></thead><tbody>';
        var mbOrder=['0-15','16-30','31-45','46-60','61-75','76-90'];
        var ssOrder=['0-0','1-0','0-1','1-1','home_+2','away_+2','other'];
        var ssLbl={'0-0':'0-0','1-0':'1-0','0-1':'0-1','1-1':'1-1','home_+2':'H +2','away_+2':'A +2','other':'altul'};
        mbOrder.forEach(function(mb){
          var byScore=byMarket[mkt][mb];
          if(!byScore)return;
          ssOrder.forEach(function(ss){
            var d=byScore[ss];
            if(!d||d.n<10)return;
            var clr=d.pct>=70?'#22c55e':d.pct>=50?'#f59e0b':'#ef4444';
            h+='<tr style="border-top:1px solid rgba(255,255,255,.04)">';
            h+='<td style="padding:3px 0">'+mb+'\'</td>';
            h+='<td>'+(ssLbl[ss]||ss)+'</td>';
            h+='<td style="text-align:right;font-weight:700;color:'+clr+'">'+d.pct.toFixed(0)+'%</td>';
            h+='<td style="text-align:right;color:var(--mu)">'+d.n+'</td>';
            h+='</tr>';
          });
        });
        h+='</tbody></table>';
        h+='</div>';
      });
      h+='<div style="font-size:10px;color:var(--mu);padding:6px;line-height:1.4">📖 Citire: pe linia <b>61-75\'</b> + <b>0-0</b> la <b>Over 1.5</b>, vezi % real din 5000 meciuri istorice cu același context. Cifre mici (sub 30%) = pattern „blocat", cifre mari (peste 70%) = goluri probabile.</div>';
    }
    h+='</div>';

    h+='<div style="text-align:center;margin-top:14px;padding-top:10px;border-top:1px solid var(--bor);font-size:10px;color:var(--mu)">Actualizat: '+(d.generated_at?new Date(d.generated_at).toLocaleString('ro-RO'):'—')+'</div>';

    body.innerHTML=h;
  }catch(e){
    body.innerHTML='<div style="color:#ef4444;padding:14px">Eroare fetch: '+e.message+'</div>';
  }
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/service-worker.js')
      .then(function(r) { console.log('[SW] registered, scope:', r.scope); })
      .catch(function(e) { console.warn('[SW] registration failed:', e); });
  });
}

