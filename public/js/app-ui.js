// AlohaScan — app-ui.js
// Extras din index.html (Sprint 3 Pas 2, 28.05.2026)
// WebSocket/Connect, render LIVE cards, PRE-MECI, MATCH DETAIL modal
// Depinde de: app-state.js

// ── WEBSOCKET / CONNECT ───────────────────────────────────────
var _autoIt=null;
var _ws=null;
var _wsReconnectTimer=null;
var _wsHeartbeat=null;
var _wsReconnectDelay=1000;
var _wsMaxDelay=30000;
var _wsLastMsg=0;             // FIX 1: timestamp ultim mesaj WS — gate polling redundant

function updateWSState(state){
  var dot=document.getElementById('ws-dot');
  var lbl=document.getElementById('ws-label');
  var ind=document.getElementById('ws-indicator');
  if(!dot)return;
  ind.style.display='flex';
  dot.className='ws-dot '+state;
  lbl.textContent=state==='connected'?'RT':state==='connecting'?'...':'OFF';
}

function connectWS(){
  if(_ws&&(_ws.readyState===0||_ws.readyState===1))return;
  updateWSState('connecting');
  var proto=location.protocol==='https:'?'wss':'ws';
  _ws=new WebSocket(proto+'://'+location.host);
  _ws.onopen=function(){
    _wsReconnectDelay=1000;
    if(_wsReconnectTimer){clearTimeout(_wsReconnectTimer);_wsReconnectTimer=null;}
    updateWSState('connected');
    if(_wsHeartbeat)clearInterval(_wsHeartbeat);
    _wsHeartbeat=setInterval(function(){
      if(_ws&&_ws.readyState===WebSocket.OPEN)_ws.send(JSON.stringify({type:'PING'}));
    },25000);
  };
  _ws.onmessage=function(ev){
    _wsLastMsg=Date.now();
    try{
      var msg=JSON.parse(ev.data);
      if(msg.type==='LIVE_UPDATE'&&msg.payload&&Array.isArray(msg.payload.matches)){
        var _ed={};var _ngPrev={};var _ng15Prev={};ST.ms.forEach(function(m){
          var fid=m.fixture&&m.fixture.id;
          if(m.enrichData)_ed[fid]=m.enrichData;
          if(typeof m._ng==='number')_ngPrev[fid]=m._ng;
          if(typeof m._ng15==='number')_ng15Prev[fid]=m._ng15;
        });
        ST.ms=msg.payload.matches.map(function(m){
          var fid=m.fixture&&m.fixture.id;
          if(m._ng===undefined && _ngPrev[fid]!==undefined) m._ng=_ngPrev[fid];
          if(m._ng15===undefined && _ng15Prev[fid]!==undefined) m._ng15=_ng15Prev[fid];
          m._s=calcScore(m);
          var e=_ed[fid];if(e)m.enrichData=e;
          return m;
        });
        renderMatches();updateStats();trackWR();genUpdateBadge();
      } else if(msg.type==='LIVE_DELTA'&&msg.payload&&Array.isArray(msg.payload.changed)){
        var _ed={};var _ngPrev={};var _ng15Prev={};ST.ms.forEach(function(m){
          var fid=m.fixture&&m.fixture.id;
          if(m.enrichData)_ed[fid]=m.enrichData;
          if(typeof m._ng==='number')_ngPrev[fid]=m._ng;
          if(typeof m._ng15==='number')_ng15Prev[fid]=m._ng15;
        });
        msg.payload.changed.forEach(function(m){
          var fid=m.fixture&&m.fixture.id;
          if(m._ng===undefined && _ngPrev[fid]!==undefined) m._ng=_ngPrev[fid];
          if(m._ng15===undefined && _ng15Prev[fid]!==undefined) m._ng15=_ng15Prev[fid];
          m._s=calcScore(m);
          var ed=_ed[fid];if(ed)m.enrichData=ed;
          var idx=ST.ms.findIndex(function(x){return x.fixture&&x.fixture.id===fid;});
          if(idx>=0)ST.ms[idx]=m; else ST.ms.push(m);
        });
        renderMatches();updateStats();
        if(msg.payload.ts)document.getElementById('s-upd').textContent=new Date(msg.payload.ts).toTimeString().slice(0,5);
      }
    }catch(_){}
  };
  _ws.onclose=function(){
    _ws=null;
    if(_wsHeartbeat){clearInterval(_wsHeartbeat);_wsHeartbeat=null;}
    if(ST.connected&&!_wsReconnectTimer){
      updateWSState('connecting');
      _wsReconnectTimer=setTimeout(function(){_wsReconnectTimer=null;connectWS();},_wsReconnectDelay);
      _wsReconnectDelay=Math.min(_wsReconnectDelay*2,_wsMaxDelay);
    }
  };
  _ws.onerror=function(){_ws.close();};
}

function toggleConn(){
  if(ST.connected){disconnect();return;}
  connect();
}
function connect(){
  var btn=document.getElementById('btn-conn');
  btn.textContent='Conectare...';btn.disabled=true;
  loadLive(function(ok){
    btn.disabled=false;
    if(ok){
      ST.connected=true;
      sessionStorage.setItem('wasConnected','1');
      document.getElementById('connect-area').style.display='none';
      document.getElementById('live-body').style.display='block';
      document.getElementById('live-badge').style.display='flex';
      document.getElementById('stats-bar').style.display='flex';
      document.getElementById('wr-bar').style.display='flex';
      fetchSupabaseWinRate();
      connectWS();
      // FIX 1: polling REST redundant când WS conectat și activ recent.
      // Skip fetch /api/football dacă WS a primit un mesaj în ultimele 60s.
      _autoIt=setInterval(function(){
        var wsActive=_ws&&_ws.readyState===1&&(Date.now()-_wsLastMsg<60000);
        if(!wsActive)loadLive();
      },CFG.RI);
    } else {
      btn.textContent='CONECTARE';
    }
  });
}
function disconnect(){
  ST.connected=false;
  if(_ws){_ws.close();_ws=null;}
  if(_wsReconnectTimer){clearTimeout(_wsReconnectTimer);_wsReconnectTimer=null;}
  if(_wsHeartbeat){clearInterval(_wsHeartbeat);_wsHeartbeat=null;}
  _wsReconnectDelay=1000;
  clearInterval(_autoIt);
  sessionStorage.removeItem('wasConnected');
  document.getElementById('connect-area').style.display='';
  document.getElementById('btn-conn').textContent='CONECTARE';
  document.getElementById('btn-conn').classList.remove('connected');
  document.getElementById('live-body').style.display='none';
  document.getElementById('live-badge').style.display='none';
  document.getElementById('ws-indicator').style.display='none';
  document.getElementById('stats-bar').style.display='none';
  document.getElementById('wr-bar').style.display='none';
}

async function loadLive(cb){
  try{
    var r=await fetch('/api/football');
    if(!r.ok)throw new Error('HTTP '+r.status);
    var d=await r.json();
    var raw=Array.isArray(d.response)?d.response:(Array.isArray(d)?d:[]);
    var _ed={};ST.ms.forEach(function(m){if(m.enrichData)_ed[m.fixture&&m.fixture.id]=m.enrichData;});
    ST.ms=raw.map(function(m){m._s=calcScore(m);var e=_ed[m.fixture&&m.fixture.id];if(e)m.enrichData=e;return m;});
    renderMatches();
    updateStats();
    trackWR();
    genUpdateBadge();
    if(cb)cb(true);
  }catch(e){
    console.error('loadLive',e);
    if(cb)cb(false);
  }
}

// ── STATS UPDATE ──────────────────────────────────────────────
function updateStats(){
  var rec=ST.ms.filter(function(m){return m._s&&m._s.ng>=CFG.MC;}).length;
  rec=Math.min(rec,CFG.MD);
  var topNg=ST.ms.reduce(function(mx,m){return Math.max(mx,(m._s&&m._s.ng)||0);},0);
  var now=new Date();
  document.getElementById('s-live').textContent=ST.ms.length;
  document.getElementById('s-rec').textContent=rec+'/'+CFG.MD;
  document.getElementById('s-ngp').textContent=topNg+'%';
  document.getElementById('s-upd').textContent=now.toTimeString().slice(0,5);
}

// ── RENDER MATCHES ────────────────────────────────────────────
function ngpColor(p){return p>=80?'#00d4a8':p>=60?'#ffd166':'#ff6b6b';}



function buildCardHtml(m,lgName){
  var s=m._s||{};var mk=s.mk||{};
  var hg=s.hg||0;var ag=s.ag||0;var mn=s.mn||0;var ng=s.ng||0;
  var hWin=hg>ag;var aWin=ag>hg;var c=ngpColor(ng);
  var flag=m.league&&m.league.flag?'<img src="'+m.league.flag+'" style="width:12px;height:9px;object-fit:cover;border-radius:2px;margin-right:4px;">':'';
  var fid2=m.fixture&&m.fixture.id||0;
  var hid2=m.teams&&m.teams.home&&m.teams.home.id||0;
  var aid2=m.teams&&m.teams.away&&m.teams.away.id||0;
  var lgId2=m.league&&m.league.id||0;
  var goodLg=GOOD_LEAGUES[lgId2];  // proven win rate >=75% pe Over 1.5
  var badLg=goodLg?null:BAD_LEAGUES[lgId2];  // win rate <=50%, evita
  var lgBadge='';
  if(goodLg)lgBadge='<span class="good-lg-badge" title="Liga cu '+goodLg.wr+'% win rate pe Over 1.5 (n='+goodLg.n+')">⚡'+goodLg.wr+'%</span>';
  else if(badLg)lgBadge='<span class="bad-lg-badge" title="Liga slaba: doar '+badLg.wr+'% win rate pe Over 1.5 (n='+badLg.n+'). Evita.">⚠'+badLg.wr+'%</span>';
  var hRed=(m.events||[]).some(function(ev){return ev.type==='Card'&&(ev.detail==='Red Card'||ev.detail==='Second Yellow Card')&&ev.team&&ev.team.id===(m.teams&&m.teams.home&&m.teams.home.id);});
  var aRed=(m.events||[]).some(function(ev){return ev.type==='Card'&&(ev.detail==='Red Card'||ev.detail==='Second Yellow Card')&&ev.team&&ev.team.id===(m.teams&&m.teams.away&&m.teams.away.id);});
  var _sh=m.fixture&&m.fixture.status&&m.fixture.status.short||'';
  var _ex=m.fixture&&m.fixture.status&&m.fixture.status.extra;
  var _b=matchTimeBadge(_sh,mn,_ex);
  var o='';
  o+='<div class="card'+(goodLg?' card-good-lg':badLg?' card-bad-lg':'')+'" onclick="mdOpen('+fid2+','+hid2+','+aid2+',this)" style="cursor:pointer">';
  o+='<div class="card-league">';
  o+='<div class="league-name"><button class="star-btn'+(isFav(fid2)?' active':'')+'" onclick="event.stopPropagation();toggleFav('+fid2+',this)">'+(isFav(fid2)?'⭐':'☆')+'</button>'+flag+(lgName||'')+lgBadge+'</div>';
  o+='<div class="card-minute">'+(_b.dot?'<div class="min-dot" style="background:'+_b.c+'"></div>':'')+'<div class="min-val" style="color:'+_b.c+'">'+_b.t+'</div></div>';
  o+='</div>';
  o+='<div class="card-teams">';
  o+='<div class="team-row"><div class="team-name">'+tLogo(m.teams&&m.teams.home,32)+'<span>'+(m.teams&&m.teams.home&&m.teams.home.name||'—')+(hRed?' 🟥':'')+'</span></div><div class="team-score'+(hWin?' winning':'')+'">'+hg+'</div></div>';
  o+='<div class="team-row"><div class="team-name">'+tLogo(m.teams&&m.teams.away,32)+'<span>'+(m.teams&&m.teams.away&&m.teams.away.name||'—')+(aRed?' 🟥':'')+'</span></div><div class="team-score'+(aWin?' winning':'')+'">'+ag+'</div></div>';
  o+='</div>';
  o+='<div class="card-footer">';
  o+='<div class="ngp-row"><div class="ngp-label">Next Goal</div>';
  if(s.forte)o+='<div class="badge-forte">⚡ FORTE</div>';
  // NGP nesigur în primele 10 min (scanner forțează 0) → afișăm „—" în loc de „0%"
  var _ngShow=(mn<10||ng===0)?'—':(ng+'%');
  var _ngW=(mn<10||ng===0)?0:ng;
  o+='<div class="ngp-pct" style="color:'+c+'">'+_ngShow+'</div></div>';
  o+='<div class="ngp-bar"><div class="ngp-fill" style="width:'+_ngW+'%;background:'+c+'"></div></div>';
  var tg=hg+ag;var _cc=(m.league&&m.league.country||'').substring(0,3).toUpperCase();
  o+='<div class="markets">';
  if(tg===0)o+='<div class="mkt">Over 0.5 <span>'+mk.over05+'%</span></div>';
  if(tg<2)o+='<div class="mkt">Over 1.5 <span>'+mk.over15+'%</span></div>';
  if(tg<3)o+='<div class="mkt">Over 2.5 <span>'+mk.over25+'%</span></div>';
  if(tg>=3&&tg<4)o+='<div class="mkt">Over 3.5 <span>'+mk.over35+'%</span></div>';
  if(_cc)o+='<div class="mkt" style="color:var(--mu);margin-left:auto">('+_cc+')</div>';
  o+='</div>';
  var ed=m.enrichData;
  if(ed){
    var ec=function(v){return v==null?'#888':v>=70?'#22c55e':v>=50?'#f59e0b':'#ef4444';};
    if(ed.homeWin!=null)o+='<div class="enrich-row hda-row"><span class="hda-h" style="color:'+ec(ed.homeWin)+'">H:'+ed.homeWin+'%</span><span class="hda-d" style="color:'+ec(ed.draw)+'">D:'+ed.draw+'%</span><span class="hda-a" style="color:'+ec(ed.awayWin)+'">A:'+ed.awayWin+'%</span></div>';
    o+='<div class="enrich-row">';
    if(ed.over15Prob!=null)o+='<span class="enr" style="color:'+ec(ed.over15Prob)+'">O1.5 '+Math.round(ed.over15Prob)+'%</span>';
    if(ed.ggProb!=null)o+='<span class="enr" style="color:'+ec(ed.ggProb)+'">GG '+Math.round(ed.ggProb)+'%</span>';
    if(ed.lambdaTotal!=null)o+='<span class="enr" style="color:var(--mu2)">λ '+Number(ed.lambdaTotal).toFixed(2)+'</span>';
    // Badge LOW/MED/HIGH derivat din confidenceScore (pragurile noi 70/55)
    if(ed.confidenceScore!=null){
      var _cs=ed.confidenceScore;
      var _cb=_cs>=70?'HIGH':_cs>=55?'MED':'LOW';
      o+='<span class="badge-conf '+_cb+'">'+_cb+'</span>';
    }
    o+='</div>';
    o+='<div class="enrich-row">';
    if(ed.homeScoreRate!=null)o+='<span class="enr" style="color:'+ec(ed.homeScoreRate)+'">Gazde '+ed.homeScoreRate+'%</span>';
    if(ed.awayScoreRate!=null)o+='<span class="enr" style="color:'+ec(ed.awayScoreRate)+'">Oaspeti '+ed.awayScoreRate+'%</span>';
    o+='</div>';
  }
  o+='</div></div>';
  return o;
}

function renderMatches(){
  if(typeof wcRenderFeatured==='function')wcRenderFeatured();  // card featured WC sus pe LIVE
  var ms=ST.ms.filter(function(m){
    if(ST.score!=='all'){
      var hg=m.goals?m.goals.home||0:0;
      var ag=m.goals?m.goals.away||0:0;
      var key=hg+'-'+ag;if(key!==ST.score)return false;
    }
    return true;
  });
  // build score chips
  var counts={};
  ST.ms.forEach(function(m){
    var k=(m.goals?m.goals.home||0:0)+'-'+(m.goals?m.goals.away||0:0);
    counts[k]=(counts[k]||0)+1;
  });
  var sc=document.getElementById('score-chips');
  var allActive=ST.score==='all';
  var html='<div class="score-chip'+(allActive?' active':'')+'" onclick="filterScore(this,\'all\')">Toate ('+ST.ms.length+')</div>';
  Object.keys(counts).sort().forEach(function(k){
    var active=ST.score===k;
    html+='<div class="score-chip'+(active?' active':'')+'" onclick="filterScore(this,\''+k+'\')">'+k+' ('+counts[k]+')</div>';
  });
  sc.innerHTML=html;

  var list=document.getElementById('match-list');

  if(!ms.length){
    // API returned nothing — keep existing DOM to avoid blank flash
    if(!ST.ms.length) return;
    list.innerHTML='<div class="empty"><div class="empty-icon">⚽</div><div class="empty-t">Niciun meci</div><div class="empty-s">Nu există meciuri pentru filtrele selectate</div></div>';
    return;
  }

  // Flat sort: cel mai recent început sus, indiferent de campionat
  ms.sort(function(a,b){
    return new Date(b.fixture?.date || 0) -
           new Date(a.fixture?.date || 0);
  });

  // Map existing card elements by fixture id for reuse
  var existing={};
  list.querySelectorAll('.card[data-fid]').forEach(function(el){
    existing[el.dataset.fid]=el;
  });

  // Build ordered node list — reuse unchanged cards, rebuild only changed ones
  var newNodes=[];
  ms.forEach(function(m){
    var s=m._s||{};
    var fid=String(m.fixture&&m.fixture.id||0);
    var sh=m.fixture&&m.fixture.status&&m.fixture.status.short||'';
    var hRed=(m.events||[]).some(function(ev){return ev.type==='Card'&&(ev.detail==='Red Card'||ev.detail==='Second Yellow Card')&&ev.team&&ev.team.id===(m.teams&&m.teams.home&&m.teams.home.id);});
    var aRed=(m.events||[]).some(function(ev){return ev.type==='Card'&&(ev.detail==='Red Card'||ev.detail==='Second Yellow Card')&&ev.team&&ev.team.id===(m.teams&&m.teams.away&&m.teams.away.id);});
    // Include lg+team names în snap pentru a forta rebuild cand datele se populeaza
    // dupa primul render (cauza bug-ului 'card fara header J2/J3 LEAGUE').
    var lgName=m.league&&m.league.name||'';
    var hName=m.teams&&m.teams.home&&m.teams.home.name||'';
    var aName=m.teams&&m.teams.away&&m.teams.away.name||'';
    var snap=[s.hg||0,s.ag||0,s.mn||0,Math.round(s.ng||0),sh,s.forte?1:0,hRed?1:0,aRed?1:0,lgName,hName,aName].join('|');
    var cur=existing[fid];
    if(cur&&cur.dataset.snap===snap){
      newNodes.push(cur);
    } else {
      var tmp=document.createElement('div');
      tmp.innerHTML=buildCardHtml(m,m.league&&m.league.name||'');
      var newEl=tmp.firstElementChild;
      newEl.dataset.fid=fid;
      newEl.dataset.snap=snap;
      newNodes.push(newEl);
    }
  });

  var sy=document.getElementById('page').scrollTop;
  list.replaceChildren.apply(list,newNodes);
  document.getElementById('page').scrollTop=sy;
}


// ── PRE-MECI ──────────────────────────────────────────────────
var PM_SENT=new Set();var PM_LOADED=false;
var _pmMatches=[];
var _pmEnrich={};
// [M1] timestamp ultimul fetch /api/enrich per fixture — la refresh live silent
// NU re-fetch dacă <60s (enrich are oricum cache server-side de 60s live).
var _enrichFetchTs={};

function enrichUrl(hid,aid,m){
  var u='/api/enrich?h='+hid+'&a='+aid;
  if(m&&m.fixture&&m.fixture.id){
    u+='&fid='+m.fixture.id;
    u+='&hn='+encodeURIComponent((m.teams&&m.teams.home&&m.teams.home.name)||'');
    u+='&an='+encodeURIComponent((m.teams&&m.teams.away&&m.teams.away.name)||'');
    u+='&lg='+encodeURIComponent((m.league&&m.league.name)||'');
    u+='&lgid='+((m.league&&m.league.id)||0);
    u+='&dt='+encodeURIComponent((m.fixture&&m.fixture.date)||'');
    // Pass live stats so enrich can calculate dynamic lambda
    var sh=m.fixture&&m.fixture.status&&m.fixture.status.short||'NS';
    var live=['1H','2H','HT','ET','BT','P','LIVE','INT'].indexOf(sh)>=0;
    if(live){
      u+='&elapsed='+(m.fixture.status.elapsed||0);
      u+='&hg='+(m.goals&&m.goals.home!=null?m.goals.home:0);
      u+='&ag='+(m.goals&&m.goals.away!=null?m.goals.away:0);
      var hSt=(m.statistics&&m.statistics[0]&&m.statistics[0].statistics)||[];
      var aSt=(m.statistics&&m.statistics[1]&&m.statistics[1].statistics)||[];
      var soth=hSt.find(function(s){return s.type==='Shots on Goal';});
      var sota=aSt.find(function(s){return s.type==='Shots on Goal';});
      u+='&soth='+(soth&&soth.value!=null?soth.value:0);
      u+='&sota='+(sota&&sota.value!=null?sota.value:0);
      var hDA=hSt.find(function(s){return s.type==='Dangerous Attacks';});
      var aDA=aSt.find(function(s){return s.type==='Dangerous Attacks';});
      u+='&da='+((hDA&&hDA.value!=null?parseFloat(hDA.value):0)+(aDA&&aDA.value!=null?parseFloat(aDA.value):0));
      var hYC=hSt.find(function(s){return s.type==='Yellow Cards';});
      var aYC=aSt.find(function(s){return s.type==='Yellow Cards';});
      u+='&yc='+((hYC&&hYC.value!=null?parseFloat(hYC.value):0)+(aYC&&aYC.value!=null?parseFloat(aYC.value):0));
    }
    // Guard typeof string: referee poate veni ca non-string/format neașteptat →
    // .split() ar arunca; encodeURIComponent pe valoare ciudată putea declanșa
    // "The string did not match the expected pattern" în WebKit.
    if(m.fixture.referee&&m.fixture.referee!=='null'){
      var _ref=String(m.fixture.referee).split(',')[0].trim();
      if(_ref)u+='&ref='+encodeURIComponent(_ref);
    }
  }
  return u;
}

async function loadPM(){
  var btn=document.getElementById('btn-pm');
  btn.textContent='Se încarcă...';btn.disabled=true;
  var body=document.getElementById('pm-body');
  body.innerHTML='<div class="spinner"><div class="spin"></div></div>';
  _pmMatches=[];_pmEnrich={};
  try{
    var r=await fetch('/api/today');
    var d=await r.json();
    console.log('[loadPM] raw response:', d);
    // Accept both d.response (array) and d directly
    var raw=Array.isArray(d.response)?d.response:Array.isArray(d)?d:[];
    console.log('[loadPM] matches found:', raw.length);
    if(!raw.length){
      body.innerHTML='<div class="empty"><div class="empty-icon">📅</div><div class="empty-t">Niciun meci</div><div class="empty-s">API a returnat 0 meciuri'+(d.error?' — '+d.error:'')+'</div></div>';
      btn.textContent='Reîncarcă';btn.disabled=false;return;
    }
    _pmMatches=raw.sort(function(a,b){return new Date(a.fixture.date)-new Date(b.fixture.date);});
    renderPM();
    btn.textContent='Reîncarcă';btn.disabled=false;
    // Lazy enrich: batches of 5, max 100 matches.
    // PERFORMANCE: renderPM() rebuilds DOM pentru ~120 cards — costisitor.
    // Apelat dupa fiecare batch (20 ori) blocheaza UI cand se acumuleaza date.
    // Fix: throttle prin requestAnimationFrame + skip render daca alta cerere e pending.
    var toEnrich=_pmMatches.filter(function(m){
      return m.teams&&m.teams.home&&m.teams.home.id&&m.teams.away&&m.teams.away.id;
    }).slice(0,100);
    var pendingRender=false;
    var lastRenderTs=Date.now();
    function scheduleRender(force){
      var now=Date.now();
      // Daca rendered acum <1500ms si nu e force, skip
      if(!force && now-lastRenderTs<1500){return;}
      if(pendingRender)return;
      pendingRender=true;
      requestAnimationFrame(function(){
        pendingRender=false;
        lastRenderTs=Date.now();
        renderPM();
        if(typeof genUpdateBadge==='function')genUpdateBadge();
      });
    }
    for(var i=0;i<toEnrich.length;i+=5){
      var batch=toEnrich.slice(i,i+5);
      await Promise.all(batch.map(async function(m){
        try{
          var er=await fetch(enrichUrl(m.teams.home.id,m.teams.away.id,m));
          var ed=await er.json();
          if(!ed.error)_pmEnrich[m.fixture.id]=ed;
        }catch(e){}
      }));
      scheduleRender(false);
      // Yield la event loop dupa fiecare batch (permite UI sa raspunda)
      await new Promise(function(r){setTimeout(r,0);});
    }
    // Final render garantat (force) dupa ce toate batch-urile s-au terminat
    scheduleRender(true);
  }catch(e){
    console.error('[loadPM] error:', e);
    body.innerHTML='<div class="empty"><div class="empty-icon">⚠️</div><div class="empty-t">Eroare</div><div class="empty-s">'+e.message+'</div></div>';
    btn.textContent='Reîncarcă';btn.disabled=false;
  }
}

// Top Oportunitati — ranking calibrat al meciurilor pre-meci pe baza:
// - over15Prob (din _pmEnrich) trecut prin G2_CALIBRATION
// - bonus pentru ligi GOOD_LEAGUES, penalty pentru BAD_LEAGUES
// - filtru EV (probabilitate calibrata >= 70%)
// - cota minima afisata per pariu
async function loadTopOpps(){
  var btn=document.getElementById('btn-topopps');
  var panel=document.getElementById('top-opps-panel');
  if(panel.style.display!=='none'){panel.style.display='none';btn.textContent='📊 Top Oportunități';return;}
  btn.textContent='Se încarcă...';btn.disabled=true;
  panel.style.display='block';
  panel.innerHTML='<div class="spinner"><div class="spin"></div></div>';

  try{
    // Refresh cache BETS_ADDED ca sa vad bifele actualizate
    await loadBetsAddedCache();
    // Asigura ca avem meciuri si enrich incarcat (fara await pe loadPM care e long-running)
    if(!_pmMatches.length){
      panel.innerHTML='<div style="padding:14px;text-align:center;color:var(--mu);font-size:12px">📥 Apas&#259; mai &icirc;nt&#226;i „&Icirc;ncarc&#259; Pre-meci" sus pentru a popula datele, apoi reia.</div>';
      btn.textContent='📊 Top Oportunități';btn.disabled=false;return;
    }
    // Asteapta ca enrich-ul sa acumuleze cel putin 10 meciuri analizate (max 6s)
    var t0=Date.now();
    while(Object.keys(_pmEnrich).length<10 && Date.now()-t0<6000){
      panel.innerHTML='<div style="padding:14px;text-align:center;color:var(--mu);font-size:12px">⏳ Analizez meciuri... '+Object.keys(_pmEnrich).length+' din '+_pmMatches.length+' procesate</div>';
      await new Promise(function(r){setTimeout(r,800);});
    }

    // Helper Poisson pentru corners/cards (lambda = liga avg, fallback default)
    function pPoisAtLeast(needed, lambda){
      if(lambda<=0)return needed===0?100:0;
      function p(k){var lp=-lambda+k*Math.log(lambda);for(var i=1;i<=k;i++)lp-=Math.log(i);return Math.exp(lp);}
      var sumBelow=0;for(var i=0;i<needed;i++)sumBelow+=p(i);
      return Math.round(100*Math.max(0,Math.min(1,1-sumBelow)));
    }
    // Threshold dinamic: pentru o lambda data, gaseste cel mai mare X.5 care
    // are inca P(>= X+1) >= minProb. Returneaza {thr, prob}.
    function bestThreshold(lambda, thresholds, minProb){
      var best=null;
      for(var i=thresholds.length-1;i>=0;i--){
        var t=thresholds[i];
        var p=pPoisAtLeast(t+1, lambda);
        if(p>=minProb){best={thr:t+0.5,prob:p};break;}
      }
      return best;
    }

    // Construiesc TOATE (meci, piata) candidatii pentru toate piețele.
    // Categorii grupate la output pentru variete in bilet:
    //   1. Over 1.5 total
    //   2. Over 2.5 total
    //   3. GG (ambele marcheaza)
    //   4. Gazde marcheaza
    //   5. Oaspeti marcheaza
    //   6. Total Cornere
    //   7. Total Cartonase
    var groups={
      'over15': {label:'Over 1.5 goluri',  icon:'⚽', picks:[], minProb:70},
      'over25': {label:'Over 2.5 goluri',  icon:'⚽', picks:[], minProb:55},
      'gg':     {label:'GG (ambele marc.)',icon:'🤝', picks:[], minProb:55},
      'home':   {label:'Gazde marcheaza',   icon:'🏠', picks:[], minProb:70},
      'away':   {label:'Oaspeti marcheaza', icon:'✈️', picks:[], minProb:70},
      'corn':   {label:'Cornere total',     icon:'⛳', picks:[], minProb:70},
      'cards':  {label:'Cartonase total',   icon:'🟨', picks:[], minProb:70},
    };
    _pmMatches.forEach(function(m){
      var fid=m.fixture&&m.fixture.id;
      if(!fid)return;
      var enr=_pmEnrich[fid];
      if(!enr)return;
      var lgId=m.league&&m.league.id;
      var lgBonus=GOOD_LEAGUES[lgId]?5:(BAD_LEAGUES[lgId]?-15:0);
      function addPick(groupKey, label, raw, cal){
        if(typeof cal!=='number'||isNaN(cal))return;
        var final=cal+lgBonus;
        var minProb=groups[groupKey]&&groups[groupKey].minProb||70;
        if(cal<minProb)return;
        groups[groupKey].picks.push({
          fid:fid, m:m, label:label, raw:raw, cal:cal, finalScore:final,
          minCota:cal>0?(100/cal).toFixed(2):'—',
          kickoff:m.fixture&&m.fixture.date,
          lgGood:GOOD_LEAGUES[lgId], lgBad:BAD_LEAGUES[lgId],
        });
      }
      // Sprint 4B: pasăm `m` pentru detectarea league_group (low/mid/high).
      // Calibrarea folosește tabela per-profil dacă există, altfel global.
      // 1. Over 1.5
      if(typeof enr.over15Prob==='number'){
        var cal=g2Calibrate('goals','total',1.5,Math.round(enr.over15Prob),m);
        addPick('over15','Over 1.5 total',enr.over15Prob,cal);
      }
      // 2. Over 2.5
      if(typeof enr.over25Prob==='number'){
        var cal25=g2Calibrate('goals','total',2.5,Math.round(enr.over25Prob),m);
        addPick('over25','Over 2.5 total',enr.over25Prob,cal25);
      }
      // 3. GG
      if(typeof enr.ggProb==='number'){
        var cal2=g2Calibrate('gg','total',0,Math.round(enr.ggProb),m);
        addPick('gg','GG ambele marcheaza',enr.ggProb,cal2);
      }
      // 4. Gazde marcheaza (homeScoreRate)
      if(typeof enr.homeScoreRate==='number'){
        var cal3=g2Calibrate('home','total',0,Math.round(enr.homeScoreRate),m);
        addPick('home','Gazde marcheaza',enr.homeScoreRate,cal3);
      }
      // 5. Oaspeti marcheaza
      if(typeof enr.awayScoreRate==='number'){
        var cal4=g2Calibrate('away','total',0,Math.round(enr.awayScoreRate),m);
        addPick('away','Oaspeti marcheaza',enr.awayScoreRate,cal4);
      }
      // 6. Cornere — scalez lg avg cu intensitatea meciului (lambdaTotal)
      // matches cu mai multe goluri asteptate au probabil mai multe cornere
      var lambdaTot=enr.lambdaTotal||2.5;
      var lgCornBase=enr.leagueStats?.avg_corners??9.5;
      var lambdaCorn=lgCornBase*Math.max(0.7,Math.min(1.4,lambdaTot/2.5));  // scaling factor
      var bestCorn=bestThreshold(lambdaCorn,[4,5,6,7,8,9,10,11,12,13],70);
      if(bestCorn)addPick('corn','Cornere Over '+bestCorn.thr,bestCorn.prob,bestCorn.prob);
      // 6. Cartonase — scalez similar
      var lgCardsBase=enr.leagueStats?.avg_yellow_cards??4;
      var lambdaCards=lgCardsBase*Math.max(0.7,Math.min(1.4,lambdaTot/2.5));
      var bestCards=bestThreshold(lambdaCards,[1,2,3,4,5,6],70);
      if(bestCards)addPick('cards','Cartonase Over '+bestCards.thr,bestCards.prob,bestCards.prob);
    });

    // Sort fiecare grup DESC dupa finalScore, ia top 3
    Object.keys(groups).forEach(function(k){
      groups[k].picks.sort(function(a,b){return b.finalScore-a.finalScore;});
      groups[k].picks=groups[k].picks.slice(0,3);
    });

    var totalPicks=0;
    Object.keys(groups).forEach(function(k){totalPicks+=groups[k].picks.length;});
    if(!totalPicks){
      panel.innerHTML='<div class="empty" style="padding:12px"><div class="empty-icon">📊</div><div class="empty-t">Nicio oportunitate &gt; 70%</div><div class="empty-s">Niciun meci nu indeplineste pragul calibrat. Apasa „Incarca Pre-meci" pentru a actualiza datele.</div></div>';
      btn.textContent='📊 Top Oportunități';btn.disabled=false;return;
    }

    var html='<div style="padding:4px 0 8px">';
    html+='<div style="font-weight:700;font-size:13px;color:#22c55e;margin-bottom:4px">📊 Bilet Calibrat — top 3 per categorie</div>';
    html+='<div style="font-size:10px;color:var(--mu);margin-bottom:12px;line-height:1.4">Prag: 70% Over1.5/Gazde/Oaspe&#539;i/Cornere/Cartona&#537;e &middot; 55% Over2.5/GG (piete inerent mai joase). Bonus +5pp ligi WR&gt;75%, penalty -15pp ligi WR&lt;50%. Click pe pick = detalii meci.</div>';

    function renderPick(o,i){
      var clr=o.cal>=85?'#22c55e':o.cal>=75?'#10b981':'#f59e0b';
      var kick=o.kickoff?new Date(o.kickoff).toLocaleTimeString('ro-RO',{hour:'2-digit',minute:'2-digit'}):'';
      var lgBadge='';
      if(o.lgGood)lgBadge=' <span style="background:rgba(34,197,94,.15);color:#22c55e;font-size:8px;font-weight:800;padding:1px 4px;border-radius:5px">⚡'+o.lgGood.wr+'%</span>';
      else if(o.lgBad)lgBadge=' <span style="background:rgba(239,68,68,.12);color:#ef4444;font-size:8px;font-weight:800;padding:1px 4px;border-radius:5px">⚠'+o.lgBad.wr+'%</span>';
      var hid=o.m.teams&&o.m.teams.home&&o.m.teams.home.id||0;
      var aid=o.m.teams&&o.m.teams.away&&o.m.teams.away.id||0;
      var fav=isFav(o.fid);
      var labelEsc=o.label.replace(/'/g,"\\'");
      var r='<div style="background:#1e2530;border-radius:8px;padding:9px 11px;margin-bottom:6px;border-left:2px solid '+clr+';cursor:pointer" onclick="mdOpen('+o.fid+','+hid+','+aid+',this)">';
      r+='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px">';
      r+='<div style="font-size:9px;font-weight:800;color:'+clr+';letter-spacing:.4px">'
        +'<button class="star-btn'+(fav?' active':'')+'" style="margin-right:6px" onclick="event.stopPropagation();toggleFavPMWithPick('+o.fid+',this,\''+labelEsc+'\','+o.minCota+','+o.cal+')">'+(fav?'⭐':'☆')+'</button>'
        +'#'+(i+1)+' &middot; '+kick+'</div>';
      r+='<div style="font-size:10px;color:var(--mu);max-width:160px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+htmlEsc(o.m.league&&o.m.league.name||'')+lgBadge+'</div></div>';
      r+='<div style="font-size:12px;font-weight:700;color:#fff;margin-bottom:3px">'+htmlEsc(o.m.teams&&o.m.teams.home&&o.m.teams.home.name||'')+' vs '+htmlEsc(o.m.teams&&o.m.teams.away&&o.m.teams.away.name||'')+'</div>';
      r+='<div style="font-size:11px;color:var(--ac);font-weight:600;margin-bottom:4px">'+htmlEsc(o.label)+'</div>';
      r+='<div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">';
      r+='<b style="font-size:15px;color:'+clr+'">'+o.cal+'%</b>';
      r+='<span style="font-size:10px;color:var(--mu)">cot&#259; min &ge; <b style="color:#fff">'+o.minCota+'</b></span>';
      r+='</div></div>';
      return r;
    }

    Object.keys(groups).forEach(function(k){
      var g=groups[k];
      if(!g.picks.length)return;
      html+='<div style="margin:10px 0 6px">';
      html+='<div style="display:flex;align-items:center;gap:6px;font-size:11px;font-weight:800;color:var(--ac);text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px">'+g.icon+' '+g.label+'</div>';
      g.picks.forEach(function(o,i){html+=renderPick(o,i);});
      html+='</div>';
    });
    html+='</div>';
    panel.innerHTML=html;
    btn.textContent='✕ Închide Oportunități';btn.disabled=false;
  }catch(e){
    panel.innerHTML='<div class="empty" style="padding:12px"><div class="empty-icon">⚠️</div><div class="empty-t">Eroare</div><div class="empty-s">'+e.message+'</div></div>';
    btn.textContent='📊 Top Oportunități';btn.disabled=false;
  }
}

function htmlEsc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
async function analyzeMatch(fid,hid,aid){
  var btn=document.getElementById('abtn-'+fid);
  if(btn){btn.textContent='⏳';btn.disabled=true;}
  try{
    var pm=_pmMatches.find(function(x){return x.fixture&&x.fixture.id===fid;});
    var r=await fetch(enrichUrl(hid,aid,pm||null));
    var ed=await r.json();
    if(!ed.error){_pmEnrich[fid]=ed;renderPM();}
    else{if(btn){btn.textContent='ANALIZEAZA';btn.disabled=false;}}
  }catch(e){if(btn){btn.textContent='ANALIZEAZA';btn.disabled=false;}}
}
function renderPM(){
  // Defense in depth: dacă userul e pe altă zi în date picker, NU suprascrie
  // pm-body cu view-ul de azi (analyzeMatch, setInterval, callbacks externe etc).
  var _todayLocal=(typeof pmTodayStr==='function')?pmTodayStr():null;
  if((typeof PM_DATE==='string')&&PM_DATE&&_todayLocal&&PM_DATE!==_todayLocal) return;
  var body=document.getElementById('pm-body');
  var total=_pmMatches.length;
  if(!total){body.innerHTML='<div class="empty"><div class="empty-icon">📅</div><div class="empty-t">Niciun meci</div></div>';return;}
  var ec=function(v){return v==null?'#888':v>=70?'#22c55e':v>=50?'#f59e0b':'#ef4444';};
  // Calculate TOP PICK threshold (top 25% by over15Prob)
  var probs=Object.values(_pmEnrich).map(function(e){return e.over15Prob||0;}).sort(function(a,b){return b-a;});
  var topThresh=probs.length?probs[Math.floor(probs.length*0.25)]||0:999;
  // Sort chronologically by kickoff; TOP PICK badge still shown based on over15Prob threshold
  var sorted=_pmMatches.slice().sort(function(a,b){
    return new Date(a.fixture.date)-new Date(b.fixture.date);
  });
  var analyzedCount=Object.keys(_pmEnrich).length;
  var pendingTxt=analyzedCount<total?' · <span style="opacity:.6">⏳ '+(total-analyzedCount)+' neanalizate</span>':'';
  var html='<div class="pm-summary"><span class="pm-summary-t">'+total+' meciuri · '+analyzedCount+' analizate'+pendingTxt+'</span></div>';
  sorted.forEach(function(m){
    var fid=m.fixture&&m.fixture.id;
    var hid=m.teams&&m.teams.home&&m.teams.home.id;
    var aid=m.teams&&m.teams.away&&m.teams.away.id;
    var hn=m.teams&&m.teams.home&&m.teams.home.name||'—';
    var an=m.teams&&m.teams.away&&m.teams.away.name||'—';
    var lg=m.league&&m.league.name||'';
    var flag=m.league&&m.league.flag?'<img src="'+m.league.flag+'" style="width:12px;height:9px;object-fit:cover;border-radius:2px;margin-right:4px;">':'';
    var kickoff=m.fixture&&m.fixture.date?new Date(m.fixture.date).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'—';
    var enr=_pmEnrich[fid];
    var isTop=enr&&probs.length&&(enr.over15Prob||0)>=topThresh&&topThresh<999;
    var _pmcc=(m.league&&m.league.country||'').substring(0,3).toUpperCase();
    html+='<div class="pm-card" onclick="mdOpen('+fid+','+hid+','+aid+',this)" style="cursor:pointer;position:relative">';
    html+='<div class="pm-header">';
    html+='<div class="pm-kickoff"><button class="star-btn'+(isFav(fid)?' active':'')+'" onclick="event.stopPropagation();toggleFavPM('+fid+',this)">'+(isFav(fid)?'⭐':'☆')+'</button>'+flag+lg+' · 🕐 '+kickoff+'</div>';
    html+='<div class="pm-teams">'+tLogo(m.teams&&m.teams.home,32)+'<span>'+hn+'</span><span style="color:var(--mu);font-size:13px;font-weight:600">vs</span>'+tLogo(m.teams&&m.teams.away,32)+'<span>'+an+'</span></div>';
    html+='</div>';
    if(enr){
      html+='<div class="pm-body">';
      html+='<div class="pm-meter-row"><div class="pm-meter-label">Over 1.5</div><div class="pm-meter-bar"><div class="pm-meter-fill" style="width:'+Math.min(enr.over15Prob||0,100)+'%;background:'+ec(enr.over15Prob)+'"></div></div><div class="pm-meter-pct" style="color:'+ec(enr.over15Prob)+'">'+Math.round(enr.over15Prob||0)+'%</div></div>';
      html+='<div class="pm-meter-row"><div class="pm-meter-label">GG</div><div class="pm-meter-bar"><div class="pm-meter-fill" style="width:'+Math.min(enr.ggProb||0,100)+'%;background:'+ec(enr.ggProb)+'"></div></div><div class="pm-meter-pct" style="color:'+ec(enr.ggProb)+'">'+Math.round(enr.ggProb||0)+'%</div></div>';
      html+='<div class="pm-stats">';
      html+='<span class="pm-stat">λ <span>'+Number(enr.lambdaTotal||0).toFixed(2)+'</span></span>';
      html+='<span class="pm-stat">Gazde <span style="color:'+ec(enr.homeScoreRate)+'">'+( enr.homeScoreRate!=null?enr.homeScoreRate+'%':'—')+'</span></span>';
      html+='<span class="pm-stat">Oaspeti <span style="color:'+ec(enr.awayScoreRate)+'">'+( enr.awayScoreRate!=null?enr.awayScoreRate+'%':'—')+'</span></span>';
      // Badge LOW/MED/HIGH derivat din confidenceScore (pragurile noi 70/55)
      if(enr.confidenceScore!=null){
        var _csPm=enr.confidenceScore;
        var _cbPm=_csPm>=70?'HIGH':_csPm>=55?'MED':'LOW';
        html+='<span class="badge-conf '+_cbPm+'">'+_cbPm+'</span>';
      }
      html+='</div>';
      if(enr.homeWin!=null)html+='<div class="enrich-row hda-row"><span style="color:'+ec(enr.homeWin)+'">H:'+enr.homeWin+'%</span><span style="color:'+ec(enr.draw)+'">D:'+enr.draw+'%</span><span style="color:'+ec(enr.awayWin)+'">A:'+enr.awayWin+'%</span></div>';
      if(enr.confidenceScore!=null){
        var cs=enr.confidenceScore;
        var confColor=cs>=70?'#22c55e':cs>=55?'#f59e0b':'#ef4444';
        var safeBadge='';
        html+='<div class="conf-bar-wrap">'+
          '<div class="conf-bar-bg"><div class="conf-bar-fill" style="width:'+cs+'%;background:'+confColor+'"></div></div>'+
          '<div class="conf-score-row">'+
            '<span class="conf-pct" style="color:'+confColor+'">'+cs+'%</span>'+
            '<span class="conf-label">ÎNCREDERE</span>'+
          '</div>'+safeBadge+'</div>';
      }
      var _hasStr=enr.teamStrengthHome!=null||enr.teamStrengthAway!=null;
      if(_hasStr||isTop||_pmcc){
        html+='<div class="enrich-row" style="margin-top:6px;align-items:center">';
        if(_hasStr){
          var sh=enr.teamStrengthHome!=null?enr.teamStrengthHome:'?';
          var sa=enr.teamStrengthAway!=null?enr.teamStrengthAway:'?';
          html+='<span class="str-badge">STR: '+sh+' vs '+sa+'</span>';
        }
        if(isTop||_pmcc){
          html+='<span style="margin-left:auto;display:flex;align-items:center;gap:6px">';
          if(_pmcc)html+='<span style="font-size:9px;color:var(--mu);font-weight:700">('+_pmcc+')</span>';
          if(isTop)html+='<span class="badge-top">TOP PICK</span>';
          html+='</span>';
        }
        html+='</div>';
      }
      html+='</div>';
    }else{
      html+='<div class="pm-body" style="display:flex;align-items:center;justify-content:space-between">';
      html+='<span style="font-size:11px;color:var(--mu)">Neanalizat</span>';
      if(hid&&aid)html+='<button class="analyze-btn" id="abtn-'+fid+'" onclick="analyzeMatch('+fid+','+hid+','+aid+')">ANALIZEAZA</button>';
      html+='</div>';
    }
    html+='</div>';
  });
  var sy=body.scrollTop;
  body.innerHTML=html;
  body.scrollTop=sy;
}


// ── CALENDAR + ISTORIC MECIURI (FlashScore-like) ──────────────
// Date picker (7 zile: 3 înapoi / azi / 3 înainte) + listă grupată pe
// competiție din /api/matches-history. Tap pe meci (NS/LIVE/FT) → mdOpen existent.
var PM_DATE = null;            // YYYY-MM-DD curent selectat
var _pmHistData = null;
var _PM_DAYS_RO = ['DU','LU','MA','MI','JO','VI','SA'];

function pmTodayStr(){
  var t = new Date();
  var y = t.getFullYear();
  var m = String(t.getMonth() + 1).padStart(2,'0');
  var d = String(t.getDate()).padStart(2,'0');
  return y + '-' + m + '-' + d;
}

function pmDateAdd(base, off){
  var t = new Date(base + 'T00:00:00');
  t.setDate(t.getDate() + off);
  var y = t.getFullYear();
  var m = String(t.getMonth() + 1).padStart(2,'0');
  var d = String(t.getDate()).padStart(2,'0');
  return y + '-' + m + '-' + d;
}

function pmBuildDateBar(){
  var bar = document.getElementById('pm-datebar');
  if (!bar) return;
  var todayStr = pmTodayStr();
  if (!PM_DATE) PM_DATE = todayStr;
  var html = '';
  for (var off = -3; off <= 3; off++) {
    var dStr = pmDateAdd(todayStr, off);
    var d = new Date(dStr + 'T00:00:00');
    var active = dStr === PM_DATE;
    var dayLbl, numLbl;
    if (off === 0) { dayLbl = 'AZI'; numLbl = String(d.getDate()).padStart(2,'0'); }
    else            { dayLbl = _PM_DAYS_RO[d.getDay()]; numLbl = String(d.getDate()).padStart(2,'0'); }
    html += '<button class="pm-datebtn' + (active ? ' active' : '') + '" '
         +  'onclick="pmLoadDate(\'' + dStr + '\')">'
         +  '<span class="pm-datebtn-day">' + dayLbl + '</span>'
         +  '<span class="pm-datebtn-num">' + numLbl + '</span>'
         +  '</button>';
  }
  bar.innerHTML = html;
}

async function pmLoadDate(dateStr){
  PM_DATE = dateStr;
  pmBuildDateBar();
  var body = document.getElementById('pm-body');
  body.innerHTML = '<div class="spinner"><div class="spin"></div></div>';
  try {
    var r = await fetch('/api/matches-history?date=' + encodeURIComponent(dateStr));
    var d = await r.json();
    if (!d.ok) {
      body.innerHTML = '<div class="empty"><div class="empty-icon">⚠️</div>'
        + '<div class="empty-t">Eroare</div><div class="empty-s">'
        + htmlEsc(d.error || 'unknown') + '</div></div>';
      return;
    }
    _pmHistData = d;
    pmRenderHistory(d);
  } catch (e) {
    body.innerHTML = '<div class="empty"><div class="empty-icon">⚠️</div>'
      + '<div class="empty-t">Eroare</div><div class="empty-s">' + htmlEsc(e.message) + '</div></div>';
  }
}

// Maparea numelui de țară (din DB) la emoji-drapel.
// Acoperă întregul whitelist + variante de scriere ('Czech-Republic' vs
// 'Czech Republic'). Țări non-ISO (England/Scotland/Wales) au flag-uri
// tag-sequence speciale. Internaționale → emoji generic 🌍/🌎/🌏.
var PM_FLAG_MAP = {
  'England':'🏴󠁧󠁢󠁥󠁮󠁧󠁿','Scotland':'🏴󠁧󠁢󠁳󠁣󠁴󠁿','Wales':'🏴󠁧󠁢󠁷󠁬󠁳󠁿',
  'World':'🌍','Europe':'🇪🇺','South-America':'🌎','South America':'🌎',
  'North-America':'🌎','North America':'🌎','Africa':'🌍','Asia':'🌏',
  // ISO 3166-1 alpha-2 codes (convertite la flag emoji prin offset 0x1F1E6)
  'Argentina':'AR','Australia':'AU','Austria':'AT','Bahrain':'BH','Belarus':'BY',
  'Belgium':'BE','Bolivia':'BO','Brazil':'BR','Bulgaria':'BG','Cambodia':'KH',
  'Canada':'CA','Chile':'CL','China':'CN','Colombia':'CO',
  'Costa-Rica':'CR','Costa Rica':'CR','Croatia':'HR',
  'Czech-Republic':'CZ','Czech Republic':'CZ','Czechia':'CZ',
  'Denmark':'DK','Ecuador':'EC','Egypt':'EG',
  'El-Salvador':'SV','El Salvador':'SV','Estonia':'EE','Ethiopia':'ET',
  'Finland':'FI','France':'FR','Germany':'DE','Ghana':'GH','Greece':'GR',
  'Guatemala':'GT','Honduras':'HN','Hong-Kong':'HK','Hong Kong':'HK',
  'Hungary':'HU','Iceland':'IS','India':'IN','Indonesia':'ID','Iran':'IR',
  'Iraq':'IQ','Ireland':'IE','Israel':'IL','Italy':'IT',
  'Ivory-Coast':'CI','Ivory Coast':'CI','Côte d\'Ivoire':'CI',
  'Jamaica':'JM','Japan':'JP','Jordan':'JO','Kazakhstan':'KZ','Kenya':'KE',
  'Korea-Republic':'KR','Korea Republic':'KR',
  'Kuwait':'KW','Latvia':'LV','Lithuania':'LT','Luxembourg':'LU',
  'Malaysia':'MY','Malta':'MT','Mexico':'MX','Moldova':'MD','Morocco':'MA',
  'Netherlands':'NL','New-Zealand':'NZ','New Zealand':'NZ','Nicaragua':'NI',
  'Nigeria':'NG','Norway':'NO','Oman':'OM','Panama':'PA','Paraguay':'PY',
  'Peru':'PE','Philippines':'PH','Poland':'PL','Portugal':'PT','Qatar':'QA',
  'Romania':'RO','Russia':'RU','Saudi-Arabia':'SA','Saudi Arabia':'SA',
  'Serbia':'RS','Singapore':'SG','Slovakia':'SK','Slovenia':'SI',
  'South-Africa':'ZA','South Africa':'ZA','South-Korea':'KR','South Korea':'KR',
  'Spain':'ES','Sweden':'SE','Switzerland':'CH','Thailand':'TH',
  'Tunisia':'TN','Turkey':'TR','Türkiye':'TR','UAE':'AE',
  'United-Arab-Emirates':'AE','United Arab Emirates':'AE',
  'Ukraine':'UA','United-States':'US','USA':'US','United States':'US',
  'Uruguay':'UY','Uzbekistan':'UZ','Venezuela':'VE',
  'Vietnam':'VN','Viet Nam':'VN',
};

function countryToFlag(country){
  if (!country) return '';
  var v = PM_FLAG_MAP[country];
  if (!v) return '';
  // Direct emoji (England/World/etc) — return ca atare
  if (v.length > 2) return v;
  // ISO 2-letter code → regional indicators (A=0x1F1E6)
  var A = 0x1F1E6;
  var c0 = v.charCodeAt(0) - 65;
  var c1 = v.charCodeAt(1) - 65;
  if (c0 < 0 || c0 > 25 || c1 < 0 || c1 > 25) return '';
  return String.fromCodePoint(A + c0) + String.fromCodePoint(A + c1);
}

// Format dată scurt românesc: DU/LU/MA/MI/JO/VI/SA + zi luna
function pmFmtDateShort(dateLike){
  if (!dateLike) return '';
  var d = new Date(dateLike);
  if (isNaN(d.getTime())) return '';
  return _PM_DAYS_RO[d.getDay()] + ' ' + String(d.getDate()).padStart(2,'0');
}
function pmFmtTime(dateLike){
  if (!dateLike) return '';
  var d = new Date(dateLike);
  if (isNaN(d.getTime())) return '';
  return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}

// Expand/collapse helpers (state persistat în localStorage per league_id)
function pmIsCollapsed(leagueId){
  try { return localStorage.getItem('pm_collapse_' + leagueId) === '1'; }
  catch(e) { return false; }
}
function pmToggleGroup(leagueId){
  var key = 'pm_collapse_' + leagueId;
  var newCollapsed;
  try {
    newCollapsed = localStorage.getItem(key) === '1' ? '0' : '1';
    localStorage.setItem(key, newCollapsed);
  } catch(e) { newCollapsed = '0'; }
  var grpEl = document.getElementById('pmg_' + leagueId);
  if (grpEl) grpEl.classList.toggle('collapsed', newCollapsed === '1');
  var chevEl = document.getElementById('pmgc_' + leagueId);
  if (chevEl) chevEl.textContent = newCollapsed === '1' ? '▼' : '▲';
}

function pmRenderHistory(data){
  var body = document.getElementById('pm-body');
  if (!data.groups || !data.groups.length) {
    body.innerHTML = '<div class="empty"><div class="empty-icon">📅</div>'
      + '<div class="empty-t">Niciun meci</div>'
      + '<div class="empty-s">Pe ' + htmlEsc(data.date) + ' nu există meciuri în ligile urmărite</div></div>';
    return;
  }
  var LIVE = {'1H':1,'2H':1,'HT':1,'ET':1,'BT':1,'P':1,'LIVE':1,'INT':1};
  var FINAL = {'FT':1,'AET':1,'PEN':1,'AWD':1,'WO':1};
  var html = '<div class="pm-summary"><span class="pm-summary-t">'
    + data.count + ' meciuri · ' + data.groups.length + ' competiții · '
    + htmlEsc(data.date) + '</span></div>';

  data.groups.forEach(function(grp){
    var lid = grp.league_id;
    var collapsed = lid ? pmIsCollapsed(lid) : false;
    var flag = countryToFlag(grp.country);
    var leagueLogo = lid
      ? '<img src="https://media.api-sports.io/football/leagues/' + lid + '.png" class="pm-group-logo" onerror="this.style.display=\'none\'">'
      : '';
    html += '<div class="pm-group' + (collapsed ? ' collapsed' : '') + '" id="pmg_' + lid + '">';
    html += '<div class="pm-group-h" onclick="pmToggleGroup(' + lid + ')">';
    if (flag) html += '<span class="pm-group-flag">' + flag + '</span>';
    html += '<span class="pm-group-country">' + htmlEsc(grp.country || '?') + '</span>';
    html += '<span style="color:var(--mu)">·</span>';
    html += '<span class="pm-group-league">' + htmlEsc(grp.league_name || '?') + '</span>';
    html += leagueLogo;
    html += '<span class="pm-group-cup">' + grp.matches.length + ' meciuri</span>';
    html += '<span class="pm-group-chev" id="pmgc_' + lid + '">' + (collapsed ? '▼' : '▲') + '</span>';
    html += '</div>';
    html += '<div class="pm-group-body">';
    grp.matches.forEach(function(m){
      var st = m.status_short || 'NS';
      var isLive = LIVE[st] === 1;
      var isFT   = FINAL[st] === 1;
      var isNS   = st === 'NS' || st === 'TBD' || st === 'PST';
      var hg = m.home_goals, ag = m.away_goals;
      var hBold = (isFT && hg > ag) ? 'font-weight:800' : '';
      var aBold = (isFT && ag > hg) ? 'font-weight:800' : '';
      var dStr = pmFmtDateShort(m.match_date);
      var tStr = pmFmtTime(m.match_date);
      var mid = '';
      if (isLive) {
        mid = '<span class="hist-date-prefix">' + dStr + '</span>'
            + '<span class="hist-score-live"><span class="live-dot"></span>' + (hg||0) + ' - ' + (ag||0) + '</span>'
            + '<span class="hist-live-badge">LIVE</span>';
      } else if (isFT) {
        mid = '<span class="hist-date-prefix">' + dStr + '</span>'
            + '<span class="hist-score-ft">' + (hg||0) + ' - ' + (ag||0) + '</span>'
            + '<span class="hist-ft-badge">' + st + '</span>';
      } else if (isNS) {
        mid = '<span class="hist-date-prefix">' + dStr + '</span>'
            + '<span class="hist-time">' + tStr + '</span>'
            + '<span class="hist-ns-badge">NS</span>';
      } else {
        mid = '<span class="hist-date-prefix">' + dStr + '</span>'
            + '<span class="hist-time">' + htmlEsc(st) + '</span>';
      }

      // Clickable pentru ORICE status (NS/LIVE/FT) cât timp avem ID-urile —
      // modalul (mdOpen) funcționează pre-meci, live și final. Anterior gated pe
      // isFT → meciurile NS din zile viitoare nu deschideau modalul.
      var clickable = m.fixture_id && m.home_team_id && m.away_team_id;
      var rowAttrs = clickable
        ? 'class="hist-row clickable" onclick="mdOpen(' + m.fixture_id + ',' + m.home_team_id + ',' + m.away_team_id + ',this)"'
        : 'class="hist-row"';

      html += '<div ' + rowAttrs + '>';
      html += '<div class="hist-team home" style="' + hBold + '">';
      if (m.home_logo) html += '<img src="' + m.home_logo + '" class="hist-logo" onerror="this.style.display=\'none\'">';
      html += '<span>' + htmlEsc(m.home_team || '?') + '</span></div>';
      html += '<div class="hist-mid">' + mid + '</div>';
      html += '<div class="hist-team away" style="' + aBold + '">';
      html += '<span>' + htmlEsc(m.away_team || '?') + '</span>';
      if (m.away_logo) html += '<img src="' + m.away_logo + '" class="hist-logo" onerror="this.style.display=\'none\'">';
      html += '</div>';
      html += '</div>';
    });
    html += '</div>';   // /pm-group-body
    html += '</div>';   // /pm-group
  });

  var sy = body.scrollTop;
  body.innerHTML = html;
  body.scrollTop = sy;
}

// Auto-init date bar la load (idempotent — apare gol până când user-ul îl populează)
if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', pmBuildDateBar);
  } else {
    setTimeout(pmBuildDateBar, 0);
  }
}


// ── MATCH DETAIL ──────────────────────────────────────────────
var _md={data:null,tabIdx:0,fixtureId:0,homeId:0,awayId:0};
var _mdRefreshTimer=null;

function mdOpen(fid,hid,aid,srcEl){
  if(!fid||!hid||!aid)return;
  // stop click from bubbling into any inner button (e.g. analyze)
  if(window.event&&window.event.target&&window.event.target.tagName==='BUTTON'&&window.event.target!==srcEl)return;
  if(_mdRefreshTimer){clearInterval(_mdRefreshTimer);_mdRefreshTimer=null;}
  _md.fixtureId=fid;_md.homeId=hid;_md.awayId=aid;_md.tabIdx=0;_md.data=null;
  _scoringExpanded=null; // modal nou → explicație colapsată
  var ov=document.getElementById('md-overlay');
  ov.classList.add('open');
  document.getElementById('md-body').innerHTML='<div class="spinner"><div class="spin"></div></div>';
  document.getElementById('md-title').textContent='Detalii meci';
  document.querySelectorAll('.md-tab').forEach(function(t,i){t.classList.toggle('active',i===0);});
  mdFetch(false);
}
function mdClose(){
  document.getElementById('md-overlay').classList.remove('open');
  if(_mdRefreshTimer){clearInterval(_mdRefreshTimer);_mdRefreshTimer=null;}
  _scoringExpanded=null; // reset stare explicație la închidere
}

// Swipe-down to close
(function(){
  var startY=0;
  var ov=document.getElementById('md-overlay');
  ov.addEventListener('touchstart',function(e){startY=e.touches[0].clientY;},{passive:true});
  ov.addEventListener('touchend',function(e){
    var dy=e.changedTouches[0].clientY-startY;
    if(dy>80&&document.getElementById('md-body').scrollTop<=0)mdClose();
  },{passive:true});
})();

async function mdFetch(silent){
  try{
    var fid=_md.fixtureId;
    var url='/api/match?id='+fid+'&h='+_md.homeId+'&a='+_md.awayId;
    var r=await fetch(url);
    var d=await r.json();
    if(d.error)throw new Error(d.error);
    if(_md.fixtureId!==fid)return;
    // La refresh silent, dacă API returnează fixture null (rate limit), păstrăm ultimul fixture valid
    if(silent&&!d.fixture&&_md.data&&_md.data.fixture){d.fixture=_md.data.fixture;}
    _md.data=d;
    var fix=d.fixture;
    if(fix){
      var hn=fix.teams&&fix.teams.home&&fix.teams.home.name||'?';
      var an=fix.teams&&fix.teams.away&&fix.teams.away.name||'?';
      document.getElementById('md-title').textContent=hn+' vs '+an;
    }
    var sh=fix&&fix.fixture&&fix.fixture.status?fix.fixture.status.short||'NS':'NS';
    var isLive=(['1H','2H','HT','ET','BT','P','LIVE','INT']).indexOf(sh)>=0;
    var liveInd=document.getElementById('md-live-ind');
    if(liveInd)liveInd.style.display=isLive?'inline-block':'none';
    mdRender();
    // On first load skip if cached; on silent refresh re-fetch DOAR dacă >60s
    // de la ultimul enrich (M1) — evită recalcul/redere inutilă la fiecare 10s.
    var hasCached=(!silent)&&((_pmEnrich&&_pmEnrich[fid]&&_pmEnrich[fid].confidenceScore!=null)||
                  (_genLiveEnrich&&_genLiveEnrich[fid]&&_genLiveEnrich[fid].confidenceScore!=null));
    var _recentEnrich=silent&&_enrichFetchTs[fid]&&(Date.now()-_enrichFetchTs[fid]<60000);
    if(!hasCached&&!_recentEnrich&&_md.homeId&&_md.awayId){
      _enrichFetchTs[fid]=Date.now();
      fetch(enrichUrl(_md.homeId,_md.awayId,fix||null)).then(function(er){return er.json();}).then(function(ed){
        if(!ed.error&&_md.fixtureId===fid){
          _genLiveEnrich[fid]=ed;
          mdRender();
        }
      }).catch(function(){});
    }
    // Start auto-refresh for live matches (10s interval)
    if(isLive&&!silent&&!_mdRefreshTimer){
      _mdRefreshTimer=setInterval(function(){
        var ovEl=document.getElementById('md-overlay');
        if(!ovEl||!ovEl.classList.contains('open')){
          clearInterval(_mdRefreshTimer);_mdRefreshTimer=null;return;
        }
        // SKIP refresh daca user-ul scrie intr-un input din modal
        // (altfel pierde focus si cursor la fiecare 10s)
        var act=document.activeElement;
        if(act&&act.tagName==='INPUT'&&ovEl.contains(act))return;
        mdFetch(true);
      },10000);
    }
    if(!isLive&&_mdRefreshTimer){
      clearInterval(_mdRefreshTimer);_mdRefreshTimer=null;
    }
  }catch(e){
    if(!silent){
      document.getElementById('md-body').innerHTML='<div class="empty"><div class="empty-icon">⚠️</div><div class="empty-t">Eroare</div><div class="empty-s">'+e.message+'</div></div>';
    }
  }
}

function mdTab(idx){
  _md.tabIdx=idx;
  document.querySelectorAll('.md-tab').forEach(function(t,i){t.classList.toggle('active',i===idx);});
  mdRender();
}

var _standingsCache={};
var _venueWeatherCache={};

// Stats helpers — bară comparativă home vs away (FlashScore-like)
// home/away pot fi number sau null. Procentuale (possession, pass %) sunt
// deja 0-100. Restul sunt count-uri brute (lățimea barei se normalizează
// față de suma celor 2).
function mdStatBar(label, hVal, aVal, fmt){
  var hRaw = (typeof hVal === 'number' && !isNaN(hVal)) ? hVal : null;
  var aRaw = (typeof aVal === 'number' && !isNaN(aVal)) ? aVal : null;
  if (hRaw === null && aRaw === null) return '';     // ascunde rând complet gol
  var h = hRaw !== null ? hRaw : 0;
  var a = aRaw !== null ? aRaw : 0;
  var total = h + a;
  var hPct = total > 0 ? Math.round(h / total * 100) : 50;
  var aPct = 100 - hPct;
  // Verde = avantaj, roșu = dezavantaj. Egalitate sau ambele 0 → gri.
  var hColor = (h > a) ? '#22c55e' : (h < a ? '#ef4444' : '#64748b');
  var aColor = (a > h) ? '#22c55e' : (a < h ? '#ef4444' : '#64748b');
  var hFmt = hRaw === null ? '—' : (fmt ? fmt(hRaw) : hRaw);
  var aFmt = aRaw === null ? '—' : (fmt ? fmt(aRaw) : aRaw);
  return '<div class="stat-row">'
       +   '<div class="stat-val home" style="color:'+hColor+'">'+hFmt+'</div>'
       +   '<div class="stat-label">'+htmlEsc(label)+'</div>'
       +   '<div class="stat-val away" style="color:'+aColor+'">'+aFmt+'</div>'
       + '</div>'
       + '<div class="stat-bar">'
       +   '<div class="stat-bar-h" style="width:'+hPct+'%;background:'+hColor+'"></div>'
       +   '<div class="stat-bar-a" style="width:'+aPct+'%;background:'+aColor+'"></div>'
       + '</div>';
}

function mdRenderStatistici(d){
  var body = document.getElementById('md-body');
  var ms = d && d.matchStats;
  var H  = ms && ms.home;
  var A  = ms && ms.away;
  if (!H && !A) {
    body.innerHTML = '<div class="empty"><div class="empty-icon">📊</div>'
      + '<div class="empty-t">Statistici indisponibile</div>'
      + '<div class="empty-s">Datele match_stats nu au fost încă colectate pentru acest meci</div></div>';
    return;
  }
  var n = function(o, k){ var v = o ? o[k] : null; return v == null ? null : Number(v); };
  var f1 = function(v){ return Number(v).toFixed(2); };
  var pct = function(v){ return Number(v) + '%'; };

  var hName = H && H.team_name ? H.team_name : (d.fixture && d.fixture.teams && d.fixture.teams.home && d.fixture.teams.home.name) || 'Gazde';
  var aName = A && A.team_name ? A.team_name : (d.fixture && d.fixture.teams && d.fixture.teams.away && d.fixture.teams.away.name) || 'Oaspeți';

  var out = '';
  out += '<div class="stat-header">'
       +   '<div class="stat-team home">'+htmlEsc(hName)+'</div>'
       +   '<div class="stat-vs">vs</div>'
       +   '<div class="stat-team away">'+htmlEsc(aName)+'</div>'
       + '</div>';

  // ── ATAC ──
  out += '<div class="stat-section"><div class="stat-section-title">⚽ ATAC</div>';
  out += mdStatBar('xG (expected goals)', n(H,'expected_goals'), n(A,'expected_goals'), f1);
  out += mdStatBar('Șuturi totale',       n(H,'shots_total'),    n(A,'shots_total'));
  out += mdStatBar('Șuturi pe poartă',    n(H,'shots_on_goal'),  n(A,'shots_on_goal'));
  out += mdStatBar('Șuturi interior',     n(H,'shots_insidebox'),n(A,'shots_insidebox'));
  out += mdStatBar('Șuturi exterior',     n(H,'shots_outsidebox'),n(A,'shots_outsidebox'));
  out += mdStatBar('Șuturi blocate',      n(H,'blocked_shots'),  n(A,'blocked_shots'));
  out += mdStatBar('Cornere',             n(H,'corner_kicks'),   n(A,'corner_kicks'));
  out += mdStatBar('Ofsaiduri',           n(H,'offsides'),       n(A,'offsides'));
  out += '</div>';

  // ── POSESIE & PASE ──
  out += '<div class="stat-section"><div class="stat-section-title">🎯 POSESIE & PASE</div>';
  out += mdStatBar('Posesie',             n(H,'ball_possession'), n(A,'ball_possession'), pct);
  out += mdStatBar('Total pase',          n(H,'total_passes'),    n(A,'total_passes'));
  out += mdStatBar('Pase precise',        n(H,'passes_accurate'), n(A,'passes_accurate'));
  out += mdStatBar('Acuratețe pase',      n(H,'pass_percentage'), n(A,'pass_percentage'), pct);
  out += '</div>';

  // ── APĂRARE ──
  out += '<div class="stat-section"><div class="stat-section-title">🛡️ APĂRARE</div>';
  out += mdStatBar('Faulturi',            n(H,'fouls'),           n(A,'fouls'));
  out += mdStatBar('Cartonașe galbene',   n(H,'yellow_cards'),    n(A,'yellow_cards'));
  out += mdStatBar('Cartonașe roșii',     n(H,'red_cards'),       n(A,'red_cards'));
  out += '</div>';

  // ── PORTARI ──
  out += '<div class="stat-section"><div class="stat-section-title">🧤 PORTARI</div>';
  out += mdStatBar('Intervenții',         n(H,'goalkeeper_saves'),n(A,'goalkeeper_saves'));
  out += '</div>';

  body.innerHTML = out;
}

function mdRender(){
  if(!_md.data){return;}
  var d=_md.data;
  // Guard global: o eroare de parsing într-un singur tab (ex. dată/regex pe format
  // neașteptat) NU mai blochează tot modalul + loghează stack-ul real pentru debug.
  try{
    if(_md.tabIdx===0)mdRenderSumar(d);
    else if(_md.tabIdx===1)mdRenderFormatii(d);
    else if(_md.tabIdx===2)mdRenderJucatori(d);
    else if(_md.tabIdx===3)mdRenderForma(d);
    else if(_md.tabIdx===4)mdRenderClasament(d);
    else if(_md.tabIdx===5)mdRenderStatistici(d);
  }catch(e){
    console.error('[mdRender] tab '+_md.tabIdx+' error:',e&&e.stack?e.stack:e);
    var body=document.getElementById('md-body');
    if(body)body.innerHTML='<div class="empty"><div class="empty-icon">⚠️</div><div class="empty-t">Eroare la afișare</div><div class="empty-s">'+htmlEsc(e&&e.message||String(e))+'</div></div>';
  }
}

// ── PROBABILITATE MARCARE — secțiune NOUĂ, complet independentă ──────────────
// NU citește și NU modifică calcConfidenceLive / calcConfidencePreMatch / NGP /
// score2/3/6/7. Combină DOAR câmpuri deja prezente în obiectul `d` (enrich +
// cache pre-meci + live_stats din fixture.statistics). Greutăți redistribuite
// proporțional când un factor lipsește.
function _msEnrich(d){
  var enrichBase=d.enrich||{};
  var fid=_md&&_md.fixtureId;
  var cached=(_pmEnrich&&_pmEnrich[fid])||(_genLiveEnrich&&_genLiveEnrich[fid])||{};
  return Object.assign({},enrichBase,cached);
}
function _msParseHA(s){
  if(!s||typeof s!=='string')return null;
  var mm=s.match(/H:([0-9.]+)\|A:([0-9.]+)/);
  return mm?{h:parseFloat(mm[1]),a:parseFloat(mm[2])}:null;
}
function calcScoringProbability(d,side){
  var clamp=function(v,lo,hi){return Math.max(lo,Math.min(hi,v));};
  var en=_msEnrich(d);
  var fix=d.fixture||{};
  var sh=(fix.fixture&&fix.fixture.status&&fix.fixture.status.short)||'NS';
  var isLive=(['1H','2H','HT','ET','BT','P','LIVE','INT']).indexOf(sh)>=0;
  var stats=(fix&&fix.statistics)||[];
  var idx=side==='home'?0:1;
  var getSt=function(type){
    var t=stats[idx]&&stats[idx].statistics;
    if(!Array.isArray(t))return null;
    var e=t.find(function(s){return s.type===type;});
    var v=e&&e.value;
    if(v==null||v==='N/A'||v==='')return null;
    var n=parseFloat(v);return isFinite(n)?n:null;
  };
  var factors=[];
  // 1. Formă ofensivă (25%) — % meciuri în care a marcat (fallback medie goluri)
  var rate=side==='home'?en.homeScoreRate:en.awayScoreRate;
  var avg =side==='home'?en.homeAvgScored:en.awayAvgScored;
  if(rate!=null&&isFinite(rate)){
    factors.push({k:'form',w:0.25,s:clamp(rate,0,100),rate:rate,avg:avg});
  } else if(avg!=null&&isFinite(avg)){
    factors.push({k:'form',w:0.25,s:clamp((1-Math.exp(-avg))*100,0,100),rate:null,avg:avg});
  }
  // 2. H2H goluri marcate istoric (20%) — doar dacă H2H real (sample>0)
  if(en.h2hSample>0&&en.h2hGG!=null&&isFinite(en.h2hGG)){
    factors.push({k:'h2h',w:0.20,s:clamp(en.h2hGG,0,100),gg:en.h2hGG,n:en.h2hSample});
  }
  // 3. Poisson λ (25%) — P(marchează≥1) = 1 - e^(-λ)
  var lam=side==='home'?en.lambdaHome:en.lambdaAway;
  if(lam!=null&&isFinite(lam)){
    factors.push({k:'poisson',w:0.25,s:clamp((1-Math.exp(-lam))*100,0,100),lam:lam});
  }
  // 4. Live stats (20%) — DOAR meci LIVE: șuturi pe poartă + atacuri periculoase
  if(isLive){
    var sot=getSt('Shots on Goal');
    var da =getSt('Dangerous Attacks');
    if(sot!=null||da!=null){
      var liveS=Math.min(100,(sot||0)*15+(da||0)*0.4);
      factors.push({k:'live',w:0.20,s:liveS,sot:sot,da:da,mn:en.liveElapsed||(fix.fixture&&fix.fixture.status&&fix.fixture.status.elapsed)||null});
    }
  }
  // 5. Player Intelligence (10%) — penalizare/bonus din factorul atacant de top
  var tsf=_msParseHA(en._topScorerFactor);
  if(tsf){
    var m=side==='home'?tsf.h:tsf.a;
    if(m!=null&&isFinite(m)) factors.push({k:'pi',w:0.10,s:clamp(50+(m-1)*300,0,100),m:m});
  }
  if(!factors.length) return null;
  var wsum=factors.reduce(function(a,f){return a+f.w;},0);
  var p=factors.reduce(function(a,f){return a+f.s*(f.w/wsum);},0);
  return {prob:Math.round(clamp(p,0,100)),factors:factors,isLive:isLive};
}

// Numără cartonașele roșii per echipă din evenimente (Red Card + Second Yellow).
// d.events e singura sursă (calcFeatures/live_stats NU stochează roșii).
function _msRedCards(d,teamId){
  var evs=(d&&d.events)||[];var n=0;
  for(var i=0;i<evs.length;i++){
    var ev=evs[i];
    if(ev.type==='Card' && (ev.detail==='Red Card'||ev.detail==='Second Yellow Card')
       && ev.team && ev.team.id===teamId) n++;
  }
  return n;
}

// PROBABILITATE MARCARE LIVE — „cât de probabil MAI marchează echipa?".
// Poisson dinamic: P(≥1 gol în timpul rămas) = 1 - e^(-λ_ajustat).
// λ_ajustat = λ_baza × timp_rămas × game_state × roșii × formă.
// Memoryless Poisson ⇒ P(următorul gol) e independent de câte a marcat deja;
// „al X-lea gol" = (golurile proprii curente + 1).
function calcScoringProbabilityLive(d,side){
  var clamp=function(v,lo,hi){return Math.max(lo,Math.min(hi,v));};
  var en=_msEnrich(d);
  var fix=d.fixture||{};
  var st=fix.fixture&&fix.fixture.status||{};
  var elapsed=Number(st.elapsed)||0;
  var extra=Number(st.extra)||0;
  var hg=fix.goals?(fix.goals.home==null?0:fix.goals.home):0;
  var ag=fix.goals?(fix.goals.away==null?0:fix.goals.away):0;
  var lamBase=side==='home'?en.lambdaHome:en.lambdaAway;
  if(lamBase==null||!isFinite(lamBase)) return null;
  lamBase=Number(lamBase);

  // 2. Timp rămas (fracție din 90). Include prelungirile dacă elapsed le-a depășit.
  var totalMin=90+(extra>0?extra:0);
  var minutesLeft=Math.max(1,totalMin-elapsed);
  var timeFrac=clamp(minutesLeft/90,0.02,1);

  // Scor din perspectiva echipei
  var myGoals=side==='home'?hg:ag;
  var oppGoals=side==='home'?ag:hg;
  var lead=myGoals-oppGoals;

  // 3. Game state
  var gs;
  if(lead>=2) gs=0.75; else if(lead===1) gs=0.90; else if(lead===0) gs=1.00;
  else if(lead===-1) gs=1.15; else gs=1.25;

  // 4. Cartonașe roșii (din evenimente)
  var myId=side==='home'?(fix.teams&&fix.teams.home&&fix.teams.home.id):(fix.teams&&fix.teams.away&&fix.teams.away.id);
  var oppId=side==='home'?(fix.teams&&fix.teams.away&&fix.teams.away.id):(fix.teams&&fix.teams.home&&fix.teams.home.id);
  var myRed=_msRedCards(d,myId);
  var oppRed=_msRedCards(d,oppId);
  var redOwn=myRed>=2?0.45:myRed===1?0.70:1.0;
  var redOpp=oppRed>=2?1.40:oppRed===1?1.20:1.0;

  // 6. Formă ofensivă: scoreRate ±10% în jurul mediei (50%)
  var rate=side==='home'?en.homeScoreRate:en.awayScoreRate;
  var formF=1.0;
  if(rate!=null&&isFinite(rate)) formF=clamp(1+(Number(rate)-50)/500,0.90,1.10);

  var lamAdj=lamBase*timeFrac*gs*redOwn*redOpp*formF;
  var prob=Math.round(clamp((1-Math.exp(-lamAdj))*100,0,100));

  // Live intensity (informativ + boost ușor): SOT/DA din statistici
  var stats=(fix&&fix.statistics)||[];var idx=side==='home'?0:1;
  var getSt=function(type){
    var t=stats[idx]&&stats[idx].statistics;if(!Array.isArray(t))return null;
    var e=t.find(function(s){return s.type===type;});var v=e&&e.value;
    if(v==null||v==='N/A'||v==='')return null;var n=parseFloat(v);return isFinite(n)?n:null;
  };
  var sot=getSt('Shots on Goal');

  return {
    prob:prob, live:true, nextGoalNum:myGoals+1,
    lamBase:lamBase, lamAdj:lamAdj, minutesLeft:minutesLeft, lead:lead,
    gs:gs, redOwn:redOwn, redOpp:redOpp, myRed:myRed, oppRed:oppRed,
    formF:formF, sot:sot, elapsed:elapsed,
  };
}

// Dispatcher: live → logică dinamică nouă; NS/altele → calcScoringProbability vechi.
function calcScoringProb(d,side){
  var fix=d&&d.fixture||{};
  var sh=(fix.fixture&&fix.fixture.status&&fix.fixture.status.short)||'NS';
  var isLive=(['1H','2H','HT','ET','BT','P','LIVE','INT']).indexOf(sh)>=0;
  if(isLive){
    var r=calcScoringProbabilityLive(d,side);
    if(r) return r;
  }
  return calcScoringProbability(d,side); // fallback NS / date insuficiente
}
var _msOrdinal=['','1ul','2lea','3lea','4lea','5lea','6lea','7lea','8lea'];
function _msOrd(n){return _msOrdinal[n]||(n+'lea');}
function buildScoringExplain(name,res){
  var R=function(v){return Math.round(v);};
  // Forma LIVE (calcScoringProbabilityLive) — explicație din factorii dinamici.
  if(res.live){
    var seg=[];
    seg.push('λ='+Number(res.lamBase).toFixed(2));
    seg.push(res.minutesLeft+' min rămase');
    if(res.lead>=2) seg.push('conduce +'+res.lead+' (-25%)');
    else if(res.lead===1) seg.push('conduce +1 (-10%)');
    else if(res.lead===0) seg.push('egalitate');
    else if(res.lead===-1) seg.push('pierde -1 (+15%)');
    else seg.push('pierde '+res.lead+' (+25%)');
    if(res.myRed>0) seg.push(res.myRed+' roșu propriu ('+(res.redOwn<0.5?'-55%':'-30%')+')');
    if(res.oppRed>0) seg.push(res.oppRed+' roșu advers ('+(res.redOpp>1.3?'+40%':'+20%')+')');
    if(res.sot!=null) seg.push(res.sot+' șuturi pe poartă');
    return 'Sistemul estimează că <b>'+htmlEsc(name)+'</b> mai marchează (al '+_msOrd(res.nextGoalNum)+' gol): '+seg.join(', ')+' → '+res.prob+'%.';
  }
  var parts=[];
  res.factors.forEach(function(f){
    if(f.k==='form'){
      parts.push(f.rate!=null?('formă ofensivă: marchează în '+R(f.rate)+'% din meciurile recente')
                             :('medie '+Number(f.avg).toFixed(2)+' goluri marcate/meci'));
    } else if(f.k==='h2h'){
      parts.push('H2H: '+R(f.gg)+'% meciuri directe cu goluri marcate (n='+f.n+')');
    } else if(f.k==='poisson'){
      parts.push('model Poisson λ='+Number(f.lam).toFixed(2)+' → '+R(f.s)+'% P(marchează)');
    } else if(f.k==='live'){
      var seg=[];
      if(f.sot!=null) seg.push(f.sot+' șuturi pe poartă');
      if(f.da!=null)  seg.push(f.da+' atacuri periculoase');
      var txt=seg.join(' · ');
      if(f.mn) txt+=' în '+f.mn+' min';
      parts.push('live: '+txt);
    } else if(f.k==='pi'){
      var d=R((f.m-1)*100);
      parts.push(f.m<1?('atacant de top absent/diminuat ('+d+'%)')
                      :('atacant de top prezent (+'+d+'%)'));
    }
  });
  return 'Sistemul estimează că <b>'+htmlEsc(name)+'</b> marchează pe baza: '+parts.join('; ')+'.';
}
// Stare persistentă a explicației „Probabilitate marcare" — supraviețuiește
// auto-refresh-ului live (modalul se re-renderează la 2-3s). null|'home'|'away'.
var _scoringExpanded=null;
function applyScoringExpanded(){
  var els=document.querySelectorAll('.ms-exp');
  for(var i=0;i<els.length;i++){
    var s=els[i].getAttribute('data-side');
    els[i].style.display=(_scoringExpanded===s)?'block':'none';
  }
}
function mdToggleScoreExp(side){
  _scoringExpanded=(_scoringExpanded===side)?null:side;
  applyScoringExpanded();
}

function mdRenderSumar(d){
  var fix=d.fixture;
  var enrichBase=d.enrich||{};
  var cached=(_pmEnrich&&_pmEnrich[_md&&_md.fixtureId])||(_genLiveEnrich&&_genLiveEnrich[_md&&_md.fixtureId])||{};
  var en=Object.assign({},enrichBase,cached);
  var stats=(fix&&fix.statistics)||[];
  var hg=fix&&fix.goals?fix.goals.home??0:0;
  var ag=fix&&fix.goals?fix.goals.away??0:0;
  var mn=fix&&fix.fixture&&fix.fixture.status?fix.fixture.status.elapsed||0:0;
  var sh=fix&&fix.fixture&&fix.fixture.status?fix.fixture.status.short||'NS':'NS';
  var hn=fix&&fix.teams&&fix.teams.home?fix.teams.home.name:'?';
  var an=fix&&fix.teams&&fix.teams.away?fix.teams.away.name:'?';
  var isLive=(['1H','2H','HT','ET','BT','P','LIVE','INT']).indexOf(sh)>=0;
  var ec=function(v){return v==null?'#888':v>=70?'#22c55e':v>=50?'#f59e0b':'#ef4444';};
  var fk=String((fix&&fix.fixture&&fix.fixture.id)||0);

  var out='';
  // Confidence circle (from pre-match enrich cache)
  if(en.confidenceScore!=null){
    var cs=en.confidenceScore;
    var ccls=cs>=70?'high':cs>=55?'mid':'low';
    var confColor=cs>=70?'#22c55e':cs>=55?'#f59e0b':'#ef4444';
    var _poOrig=(en.breakdown&&en.breakdown.poisson!=null?en.breakdown.poisson:null);
    var _powVal=(en.breakdown&&en.breakdown.putereEchipe!=null)?0.20:0.25;
    out+='<div class="conf-circle-wrap" id="mdccw_'+fk+'" data-cs="'+cs+'" data-po="'+(_poOrig!=null?_poOrig:'')+'" data-pow="'+_powVal+'">';
    out+='<div class="conf-circle '+ccls+'" id="mdcc_'+fk+'">'+cs+'%</div>';
    if(en.breakdown){
      var bd=en.breakdown;
      var bItems=[['Poisson',bd.poisson],['Formă',bd.forma],['H2H',bd.h2h],['Live',bd.live],['Consistență',bd.consistenta],['Putere Echipe',bd.putereEchipe]];
      out+='<div class="conf-breakdown">';
      bItems.forEach(function(b){
        if(b[1]==null){
          // UPGRADE 2/3: mesaj explicit pentru H2H / Live când lipsesc (NU mai dispar din UI)
          var missingMsg=null;
          if(b[0]==='H2H')  missingMsg='Date insuficiente';
          else if(b[0]==='Live') missingMsg='Doar meciuri active';
          if(missingMsg){
            out+='<div class="conf-bd-row"><div class="conf-bd-lbl">'+b[0]+'</div>'+
              '<div class="conf-bd-bar"></div>'+
              '<div class="conf-bd-val" style="color:var(--mu);font-size:9px;min-width:auto">'+missingMsg+'</div></div>';
          }
          return;
        }
        var bc=b[1]>=80?'#22c55e':b[1]>=60?'#f59e0b':'#ef4444';
        var isPo=b[0]==='Poisson';
        out+='<div class="conf-bd-row"><div class="conf-bd-lbl">'+b[0]+'</div>'+
          '<div class="conf-bd-bar"><div class="conf-bd-fill"'+(isPo?' id="mdbd_'+fk+'_po"':'')+' style="width:'+b[1]+'%;background:'+bc+'"></div></div>'+
          '<div class="conf-bd-val"'+(isPo?' id="mdbdv_'+fk+'_po"':'')+'>'+b[1]+'%</div></div>';
      });
      out+='</div>';
    }
    // FACTORI INFLUENȚĂ — explică DE CE confidence-ul e ce e
    // (date deja calculate de enrich.js, doar neafișate anterior)
    (function(){
      var badges=[];
      var pHA=function(s){
        if(!s||typeof s!=='string')return null;
        var mm=s.match(/H:([0-9.]+)\|A:([0-9.]+)/);
        return mm?{h:parseFloat(mm[1]),a:parseFloat(mm[2])}:null;
      };
      var fmtD=function(f){var d=Math.round((f-1)*100);return (d>=0?'+':'')+d+'%';};
      var addBadge=function(icon,label,value,color){
        badges.push(
          '<span style="display:inline-flex;align-items:center;gap:4px;padding:4px 8px;border-radius:8px;font-size:11px;font-weight:600;background:'+color+'22;border:1px solid '+color+'55;color:'+color+'">'+
          icon+' <b>'+label+'</b>'+(value?' <span style="opacity:.85;font-weight:500">'+value+'</span>':'')+'</span>'
        );
      };
      // 1. Top Scorer factor (boost/reducere lambda din atacanți de top)
      var ts=pHA(en._topScorerFactor);
      if(ts){
        var hasUp=ts.h>1.02||ts.a>1.02;
        var hasDn=ts.h<0.98||ts.a<0.98;
        var clr=hasUp&&!hasDn?'#22c55e':(!hasUp&&hasDn)?'#ef4444':'#f59e0b';
        addBadge('⚽','Top Scorer','H'+fmtD(ts.h)+' A'+fmtD(ts.a),clr);
      }
      // 2. Injury impact (reducere lambda din accidentați)
      var il=pHA(en._injuryLambda);
      if(il&&(il.h<0.99||il.a<0.99)){
        addBadge('🤕','Accidentați','H'+fmtD(il.h)+' A'+fmtD(il.a),'#ef4444');
      }
      // 3. Meteo / stadion impact (altitudine, gazon artificial agregate)
      if(en._venueMeteoImpact){
        var meteoLabel=String(en._venueMeteoImpact)
          .replace(/altitude_extreme/g,'altitudine extremă')
          .replace(/altitude_high/g,'altitudine mare')
          .replace(/altitude_mid/g,'altitudine medie')
          .replace(/artificial_turf/g,'gazon artificial');
        addBadge('🌧️','Stadion',meteoLabel,'#f59e0b');
      }
      // 4. Surface artificial (dacă nu deja inclus în meteo)
      var meteoStr=String(en._venueMeteoImpact||'');
      if(en._venueSurface==='artificial'&&meteoStr.indexOf('artificial')<0){
        addBadge('🏟️','Gazon artificial','','#3b82f6');
      }
      // 5. Altitudine ridicată
      var altM=Number(en._venueAltitude);
      if(isFinite(altM)&&altM>1500&&meteoStr.indexOf('altitude')<0){
        addBadge('⛰️','Altitudine',altM+'m','#f59e0b');
      }
      // 6. Coach impact (factori istorici antrenor)
      if(en._coachImpact){
        addBadge('👔','Coach impact','activ','#3b82f6');
      }
      // 7. Absențe stelare (din breakdown.injuries.note)
      if(en.breakdown&&en.breakdown.injuries&&en.breakdown.injuries.note){
        addBadge('⚠️','Absențe',en.breakdown.injuries.note,'#ef4444');
      }
      // 8. Lot incomplet (squad penalty)
      if(en.breakdown&&en.breakdown.squads&&en.breakdown.squads.penalty<0){
        var sq=en.breakdown.squads;
        addBadge('⚠️','Lot incomplet','H:'+sq.home+' A:'+sq.away+' ('+sq.penalty+'pp)','#ef4444');
      }
      if(badges.length){
        out+='<div class="md-section">';
        out+='<div class="md-section-title">Factori Influență</div>';
        out+='<div style="display:flex;flex-wrap:wrap;gap:6px;padding:6px 0">';
        out+=badges.join('');
        out+='</div></div>';
      }
    })();
    // Player Intelligence section
    if(en.teamStrengthHome!=null||en.teamStrengthAway!=null){
      var sh2=en.teamStrengthHome&&en.teamStrengthHome>0?en.teamStrengthHome:null;
      var sa2=en.teamStrengthAway&&en.teamStrengthAway>0?en.teamStrengthAway:null;
      out+='<div class="pi-section">';
      out+='<div class="pi-title">⚡ Player Intelligence</div>';
      if(!sh2&&!sa2){
        out+='<div class="pi-na">Date indisponibile — statistici jucători lipsesc pentru ambele echipe</div>';
      } else {
        out+='<div class="pi-teams">';
        // UPGRADE 4: badge "(date limitate)" când strength < 40 (date player_stats insuficiente)
        var _limWarn=' <span style="color:var(--mu);font-size:10px;font-weight:500">(date limitate)</span>';
        if(sh2){
          var _shWarn=sh2<40?_limWarn:'';
          out+='<div class="pi-team"><div class="pi-team-name">'+hn+'</div><div class="pi-str-val">'+sh2+_shWarn+'</div><div class="pi-str-bar"><div class="pi-str-fill" style="width:'+sh2+'%"></div></div></div>';
        } else {
          out+='<div class="pi-team"><div class="pi-team-name">'+hn+'</div><div class="pi-str-val pi-str-na">—</div><div class="pi-str-bar"></div></div>';
        }
        if(sa2){
          var _saWarn=sa2<40?_limWarn:'';
          out+='<div class="pi-team"><div class="pi-team-name">'+an+'</div><div class="pi-str-val">'+sa2+_saWarn+'</div><div class="pi-str-bar"><div class="pi-str-fill" style="width:'+sa2+'%"></div></div></div>';
        } else {
          out+='<div class="pi-team"><div class="pi-team-name">'+an+'</div><div class="pi-str-val pi-str-na">—</div><div class="pi-str-bar"></div></div>';
        }
        out+='</div>';
      }
      out+='</div>';
    }
    out+='</div>';
  }

  // ── PROBABILITATE MARCARE (sub Player Intelligence) ──────────────────────
  (function(){
    var rH=calcScoringProb(d,'home');
    var rA=calcScoringProb(d,'away');
    if(rH||rA){
      var scol=function(p){return p==null?'#888':p>=60?'#22c55e':p>=40?'#f59e0b':'#ef4444';};
      var card=function(team,name,res,sideKey){
        var p=res?res.prob:null;
        var pv=p==null?'—':p+'%';
        var expId='msx_'+fk+'_'+sideKey;
        var expHtml=res?buildScoringExplain(name,res):'Date insuficiente pentru estimare.';
        // Sub-etichetă „Al X-lea gol" doar pe meci live (res.live).
        var subLbl=(res&&res.live)?('Al '+_msOrd(res.nextGoalNum)+' gol'):'Marchează în meci';
        // Starea expandată e citită din _scoringExpanded → persistă peste auto-refresh.
        var disp=(_scoringExpanded===sideKey)?'block':'none';
        var _tid=(team&&team.id)?team.id:0;
        var _lg=(fix&&fix.league&&fix.league.id)?fix.league.id:0;
        return '<div onclick="mdToggleScoreExp(\''+sideKey+'\')" style="flex:1;min-width:0;cursor:pointer;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.10);border-radius:12px;padding:12px;text-align:center">'+
          '<div style="display:flex;justify-content:center;margin-bottom:6px" onclick="event.stopPropagation();tpOpen('+_tid+','+_lg+')">'+tLogo(team,40)+'</div>'+
          '<div style="font-size:13px;font-weight:600;margin-bottom:4px;cursor:pointer" onclick="event.stopPropagation();tpOpen('+_tid+','+_lg+')">'+htmlEsc(name)+'</div>'+
          '<div style="font-size:30px;font-weight:800;line-height:1;color:'+scol(p)+'">'+pv+'</div>'+
          '<div style="font-size:10px;color:var(--mu);margin-top:3px">'+subLbl+'</div>'+
          '<div style="font-size:10px;color:var(--mu);margin-top:6px">👆 tap pentru explicație</div>'+
          '<div class="ms-exp" data-side="'+sideKey+'" id="'+expId+'" style="display:'+disp+';font-size:11px;line-height:1.5;color:var(--mu2,#aaa);margin-top:8px;text-align:left;border-top:1px solid rgba(255,255,255,.10);padding-top:8px">'+expHtml+'</div>'+
        '</div>';
      };
      out+='<div class="md-section"><div class="md-section-title">Probabilitate marcare</div>';
      out+='<div style="display:flex;gap:10px;align-items:flex-start">';
      out+=card(fix&&fix.teams&&fix.teams.home,hn,rH,'home');
      out+=card(fix&&fix.teams&&fix.teams.away,an,rA,'away');
      out+='</div></div>';
    }
  })();

  var _lgId=(fix&&fix.league&&fix.league.id)?fix.league.id:0;
  var _hId=(fix&&fix.teams&&fix.teams.home&&fix.teams.home.id)?fix.teams.home.id:(_md.homeId||0);
  var _aId=(fix&&fix.teams&&fix.teams.away&&fix.teams.away.id)?fix.teams.away.id:(_md.awayId||0);
  out+='<div class="md-score-block">';
  out+='<div class="md-teams-row">';
  out+='<div class="md-team-name" style="cursor:pointer" onclick="tpOpen('+_hId+','+_lgId+')">'+tLogo(fix&&fix.teams&&fix.teams.home,48)+'<span>'+hn+'</span></div>';
  out+='<div class="md-score">'+hg+' - '+ag+'</div>';
  out+='<div class="md-team-name" style="cursor:pointer" onclick="tpOpen('+_aId+','+_lgId+')">'+tLogo(fix&&fix.teams&&fix.teams.away,48)+'<span>'+an+'</span></div>';
  out+='</div></div>';
  if(isLive){
    var _mdEx=fix&&fix.fixture&&fix.fixture.status?fix.fixture.status.extra:0;
    var _mb=matchTimeBadge(sh,mn,_mdEx);
    out+='<div class="md-minute"><div class="md-min-badge" style="color:'+_mb.c+';border-color:'+_mb.c+'40;background:'+_mb.c+'18">'
      +(_mb.dot?'<div class="min-dot" style="background:'+_mb.c+'"></div>':'')
      +_mb.t+'</div></div>';
  }

  // Events (goals/cards) summary
  var evts=d.events||[];
  var goalEvts=evts.filter(function(e){return e.type==='Goal';});
  var cardEvts=evts.filter(function(e){return e.type==='Card';});
  var subEvts=evts.filter(function(e){return e.type==='subst';});
  if(evts.length){
    // Timeline 2 coloane (FlashScore-like): home stânga, away dreapta.
    // Sortat cronologic (elapsed ASC, apoi extra ASC pentru prelungiri).
    var _tlHid = (fix && fix.teams && fix.teams.home && fix.teams.home.id);
    var sortedEvts = evts.slice().sort(function(a,b){
      var ea=(a.time&&a.time.elapsed)||0;
      var eb=(b.time&&b.time.elapsed)||0;
      if(ea!==eb) return ea-eb;
      var xa=(a.time&&a.time.extra)||0;
      var xb=(b.time&&b.time.extra)||0;
      return xa-xb;
    });
    out+='<div class="md-section"><div class="md-section-title">Timeline evenimente</div>';
    out+='<div class="md-timeline">';
    sortedEvts.forEach(function(ev){
      var teamId=ev.team&&ev.team.id;
      var isHome=teamId===_tlHid;
      var elapsed=(ev.time&&ev.time.elapsed!=null)?ev.time.elapsed:'?';
      var extra  =(ev.time&&ev.time.extra)?'+'+ev.time.extra:'';
      var minStr =elapsed+extra+"'";
      var t =(ev.type||'').toLowerCase();
      var de=(ev.detail||'').toLowerCase();
      var icon,body='';
      if(t==='goal'){
        icon=(de==='own goal')?'⚽🔴':(de.indexOf('penalty')>=0?'⚽⚪':'⚽');
        body='<span class="md-tl-player">'+htmlEsc(ev.player&&ev.player.name||'?')+'</span>';
        if(ev.assist&&ev.assist.name)
          body+=' <span class="md-tl-assist">('+htmlEsc(ev.assist.name)+')</span>';
      } else if(t==='card'){
        icon=(de==='red card')?'🟥':(de==='yellow+red card'?'🟥':'🟨');
        body='<span class="md-tl-player">'+htmlEsc(ev.player&&ev.player.name||'?')+'</span>';
      } else if(t==='subst'||t==='substitution'){
        icon='🔄';
        var pIn =ev.player&&ev.player.name||'?';
        var pOut=ev.assist&&ev.assist.name||'';
        body='<span class="md-tl-in">'+htmlEsc(pIn)+'</span>';
        if(pOut) body+=' <span class="md-tl-out">↓ '+htmlEsc(pOut)+'</span>';
      } else if(t==='var'){
        icon='📺';
        body=htmlEsc(ev.detail||'VAR');
      } else {
        icon='•';
        body=htmlEsc(ev.detail||ev.type||'');
      }
      out+='<div class="md-tl-row '+(isHome?'home':'away')+'">';
      if(isHome){
        out+='<div class="md-tl-cell home">'
           +   '<span class="md-tl-body">'+body+'</span>'
           +   '<span class="md-tl-icon">'+icon+'</span>'
           +   '<span class="md-tl-min">'+minStr+'</span>'
           +'</div>'
           +'<div class="md-tl-line"></div>'
           +'<div class="md-tl-cell away"></div>';
      } else {
        out+='<div class="md-tl-cell home"></div>'
           +'<div class="md-tl-line"></div>'
           +'<div class="md-tl-cell away">'
           +   '<span class="md-tl-min">'+minStr+'</span>'
           +   '<span class="md-tl-icon">'+icon+'</span>'
           +   '<span class="md-tl-body">'+body+'</span>'
           +'</div>';
      }
      out+='</div>';
    });
    out+='</div></div>';
  }

  // Match statistics bars
  function getSt(idx,type){
    var t=stats&&stats[idx]&&stats[idx].statistics;
    if(!Array.isArray(t))return null;
    var e=t.find(function(s){return s.type===type;});
    var v=e&&e.value;
    if(v===null||v===undefined||v==='N/A'||v==='')return null;
    return v;
  }
  function statRow(label,hv,av){
    if(hv===null&&av===null)return '';
    var hNum=parseFloat(hv)||0;var aNum=parseFloat(av)||0;
    var tot=hNum+aNum;
    var hPct=tot>0?Math.round(hNum/tot*100):50;
    var aPct=100-hPct;
    return '<div class="md-stat-row">'+
      '<div class="md-stat-val">'+hv+'</div>'+
      '<div class="md-stat-bar-wrap">'+
        '<div class="md-stat-bar"><div class="md-stat-bar-fill" style="width:'+hPct+'%;float:right"></div></div>'+
        '<div class="md-stat-label">'+label+'</div>'+
        '<div class="md-stat-bar"><div class="md-stat-bar-fill away" style="width:'+aPct+'%"></div></div>'+
      '</div>'+
      '<div class="md-stat-val">'+av+'</div></div>';
  }
  var statsHTML='';
  var statDefs=[
    ['Ball Possession','Posesie'],['Shots on Goal','Suturi pe poartă'],
    ['Shots off Goal','Suturi pe lângă'],['Total Shots','Total suturi'],
    ['Dangerous Attacks','Atacuri periculoase'],
    ['Corner Kicks','Cornere'],['Fouls','Fault-uri'],['Yellow Cards','Galbene'],
    ['expected_goals','xG']
  ];
  statDefs.forEach(function(sd){
    statsHTML+=statRow(sd[1],getSt(0,sd[0]),getSt(1,sd[0]));
  });
  // Estimated xG when real xG not available
  var realXgH=getSt(0,'expected_goals'),realXgA=getSt(1,'expected_goals');
  if((!realXgH&&!realXgA)){
    var estH=(parseFloat(getSt(0,'Shots on Goal'))||0)*0.35;
    var estA=(parseFloat(getSt(1,'Shots on Goal'))||0)*0.35;
    if(estH||estA){
      statsHTML+='<div style="font-size:11px;color:var(--mu);padding:3px 0">xG estimat: ~'+(estH+estA).toFixed(2)+' ('+estH.toFixed(2)+' — '+estA.toFixed(2)+')</div>';
    }
  }
  if(statsHTML){
    out+='<div class="md-section"><div class="md-section-title">Statistici meci</div>'+statsHTML+'</div>';
  }
  // NGP for live matches — DUAL: gol anytime in meci + gol in urmatoarele 15 min
  if(isLive){
    // Caut _ng + _ng15 pentru acest fixture in ST.ms (calibrat + smoothed de scanner)
    var _fidM=fix&&fix.fixture&&fix.fixture.id;
    var _stMatch=_fidM&&ST.ms.find(function(x){return x.fixture&&x.fixture.id===_fidM;});
    if(_stMatch){
      if(typeof _stMatch._ng==='number')fix._ng=_stMatch._ng;
      if(typeof _stMatch._ng15==='number')fix._ng15=_stMatch._ng15;
    }
    var ngpData=calcScore(fix);
    var ng15=(typeof fix._ng15==='number')?fix._ng15:null;
    var ngRaw=ngpData.ng;
    var ngCal=calibrateNgpRest(ngRaw);
    var ngpClr=ngCal>=80?'#00d4a8':ngCal>=60?'#ffd166':'#ff6b6b';
    var ng15Clr=ng15===null?'#888':ng15>=40?'#00d4a8':ng15>=25?'#ffd166':'#ff6b6b';
    // NGP nesigur în primele 10 min (scanner forțează 0) → „—" în loc de „0%"
    var _ngEarly=(mn<10||ngCal===0);
    var minCotaNgp=ngCal>0?(100/ngCal).toFixed(2):'—';
    out+='<div class="md-section"><div class="md-section-title">Probabilitate Gol</div>';
    // Two columns: anytime in match vs next 15 min
    out+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">';
    // Column 1: anytime in match — CALIBRAT din backtest 26297 predictii
    out+='<div style="padding:12px;background:rgba(0,212,168,.06);border-radius:8px;text-align:center">';
    out+='<div style="font-size:9px;color:var(--mu);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px">Gol oric&acirc;nd &icirc;n meci</div>';
    out+='<div style="font-size:24px;font-weight:800;color:'+(_ngEarly?'#888':ngpClr)+'">'+(_ngEarly?'—':ngCal+'%')+'</div>';
    out+='<div style="font-size:9px;color:var(--mu);margin-top:3px">'+(_ngEarly?'se calculează (min &lt;10)':'calibrat &middot; cot&#259; min '+minCotaNgp)+'</div>';
    if(!_ngEarly&&ngCal!==ngRaw)out+='<div style="font-size:9px;color:var(--mu);margin-top:2px;opacity:.7">raw: '+ngRaw+'%</div>';
    if(!_ngEarly&&ngpData.forte)out+='<div class="badge-forte" style="margin-top:6px;display:inline-block">⚡ FORTE</div>';
    out+='</div>';
    // Column 2: next 15 min — necalibrat (backtest arata discrimination slaba)
    out+='<div style="padding:12px;background:rgba(245,158,11,.06);border-radius:8px;text-align:center">';
    out+='<div style="font-size:9px;color:var(--mu);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px">Gol &icirc;n urm. 15 min</div>';
    out+='<div style="font-size:24px;font-weight:800;color:'+ng15Clr+'">'+(ng15===null?'—':ng15+'%')+'</div>';
    out+='<div style="font-size:9px;color:var(--mu);margin-top:3px">brut · zgomot &gt;30%</div>';
    out+='</div>';
    out+='</div>';  // end grid
    // Disclaimer cu insight backtest
    out+='<div style="font-size:10px;color:var(--mu);margin-top:8px;line-height:1.4">';
    out+='ℹ️ <b>St&acirc;nga</b> calibrat din 26000+ predic&#539;ii reale (Brier 0.28 &rarr; 0.18). ';
    out+='Folose&#537;te pentru pariuri pe tot meciul (Over 0.5/1.5). ';
    out+='<b>Dreapta</b> necalibrat — backtest arat&#259; c&#259; sub 30% e zgomot.';
    out+='</div>';
    out+='</div>';

  }

  // Poisson probs — date PRE-MECI, periculoase la pariere live cand meciul a evoluat
  // Acest bloc e INDEPENDENT de confidenceScore: λ + probabilități se afișează chiar
  // dacă enrich-ul de încredere lipsește (ex. meci NS din zile viitoare). Când
  // confidenceScore lipsește dar λ există → marcăm „date parțiale" (cercul % rămâne
  // ascuns, fiind gated separat pe confidenceScore mai sus).
  if(en.over15Prob!=null){
    var _lambdaStale=Number(en.lambdaTotal||0)<0.5;
    var _partialData=(en.confidenceScore==null);
    // Live + meciul a progresat = Poisson pre-meci nu mai e relevant
    var _liveProgressed = isLive && (mn > 15 || (hg + ag) > 0);
    out+='<div class="md-section"><div class="md-section-title">Predicții Poisson <span style="font-size:10px;color:var(--mu);font-weight:400">(pre-meci)</span>'
      +(_partialData?' <span style="font-size:10px;color:#fbbf24;font-weight:400">· date parțiale</span>':'')
      +'</div>';
    if(_lambdaStale){
      out+='<div style="padding:12px;background:rgba(245,158,11,0.1);border-left:3px solid #f59e0b;border-radius:6px;font-size:12px;color:#fbbf24;">';
      out+='⚠ Predicțiile Poisson nu sunt fiabile pentru acest meci (λ='+Number(en.lambdaTotal||0).toFixed(2)+' indică date pre-meci incomplete sau corupte). Folosește NGP de mai sus pentru deciziile live.';
      out+='</div>';
    } else if(_liveProgressed){
      out+='<div style="padding:12px;background:rgba(239,68,68,0.08);border-left:3px solid #ef4444;border-radius:6px;font-size:12px;color:#fca5a5;">';
      out+='⛔ <b>NU folosi pentru pariere live.</b> Aceste predicții sunt calculate <b>înainte de începutul meciului</b> (estimare 90 min total). Meciul a evoluat — scor '+hg+'-'+ag+' la min '+mn+'. Folosește <b>NGP de mai sus</b> care reflectă starea actuală.';
      out+='</div>';
      out+='<details style="margin-top:8px"><summary style="cursor:pointer;font-size:11px;color:var(--mu);padding:4px 0">Vezi totuși predicțiile pre-meci →</summary>';
      out+='<div class="md-prob-row" style="margin-top:8px;opacity:0.6">';
      out+='<div class="md-prob"><div class="md-prob-val" style="color:'+ec(en.over15Prob)+'">'+Math.round(en.over15Prob)+'%</div><div class="md-prob-lbl">Over 1.5</div></div>';
      out+='<div class="md-prob"><div class="md-prob-val" style="color:'+ec(en.over25Prob)+'">'+Math.round(en.over25Prob)+'%</div><div class="md-prob-lbl">Over 2.5</div></div>';
      out+='<div class="md-prob"><div class="md-prob-val" style="color:'+ec(en.ggProb)+'">'+Math.round(en.ggProb)+'%</div><div class="md-prob-lbl">GG</div></div>';
      out+='</div>';
      out+='<div class="md-prob-row" style="opacity:0.6">';
      out+='<div class="md-prob"><div class="md-prob-val" style="color:'+ec(en.homeScoreRate)+'">'+(en.homeScoreRate!=null?en.homeScoreRate+'%':'—')+'</div><div class="md-prob-lbl">Gazde marcheaza</div></div>';
      out+='<div class="md-prob"><div class="md-prob-val" style="color:var(--mu2)">'+Number(en.lambdaTotal||0).toFixed(2)+'</div><div class="md-prob-lbl">λ Total</div></div>';
      out+='<div class="md-prob"><div class="md-prob-val" style="color:'+ec(en.awayScoreRate)+'">'+(en.awayScoreRate!=null?en.awayScoreRate+'%':'—')+'</div><div class="md-prob-lbl">Oaspeti marcheaza</div></div>';
      out+='</div></details>';
    } else {
      out+='<div class="md-prob-row">';
      out+='<div class="md-prob"><div class="md-prob-val" id="mdpv_'+fk+'_o15" style="color:'+ec(en.over15Prob)+'">'+Math.round(en.over15Prob)+'%</div><div class="md-prob-lbl">Over 1.5</div></div>';
      out+='<div class="md-prob"><div class="md-prob-val" id="mdpv_'+fk+'_o25" style="color:'+ec(en.over25Prob)+'">'+Math.round(en.over25Prob)+'%</div><div class="md-prob-lbl">Over 2.5</div></div>';
      out+='<div class="md-prob"><div class="md-prob-val" id="mdpv_'+fk+'_gg" style="color:'+ec(en.ggProb)+'">'+Math.round(en.ggProb)+'%</div><div class="md-prob-lbl">GG</div></div>';
      out+='</div>';
      out+='<div class="md-prob-row">';
      out+='<div class="md-prob"><div class="md-prob-val" id="mdpv_'+fk+'_hsc" style="color:'+ec(en.homeScoreRate)+'">'+(en.homeScoreRate!=null?en.homeScoreRate+'%':'—')+'</div><div class="md-prob-lbl">Gazde marcheaza</div></div>';
      out+='<div class="md-prob"><div class="md-prob-val" id="mdpv_'+fk+'_lt" style="color:var(--mu2)">'+Number(en.lambdaTotal||0).toFixed(2)+'</div><div class="md-prob-lbl">λ Total</div></div>';
      out+='<div class="md-prob"><div class="md-prob-val" id="mdpv_'+fk+'_asc" style="color:'+ec(en.awayScoreRate)+'">'+(en.awayScoreRate!=null?en.awayScoreRate+'%':'—')+'</div><div class="md-prob-lbl">Oaspeti marcheaza</div></div>';
      out+='</div>';
      // FIX 2 — λ split per echipă (date deja calculate, neexpuse anterior)
      if(en.lambdaHome!=null||en.lambdaAway!=null){
        out+='<div class="md-prob-row">';
        out+='<div class="md-prob"><div class="md-prob-val" style="color:var(--mu2)">'+Number(en.lambdaHome||0).toFixed(2)+'</div><div class="md-prob-lbl">λ Gazde</div></div>';
        out+='<div class="md-prob"><div class="md-prob-val" style="color:var(--mu2)">'+Number(en.lambdaAway||0).toFixed(2)+'</div><div class="md-prob-lbl">λ Oaspeți</div></div>';
        out+='</div>';
      }
      // FIX 3 — 1X2 medalions + Double Chance (dc1x, dcx2 deja calculate)
      if(en.homeWin!=null){
        out+='<div class="md-prob-row">';
        out+='<div class="md-prob"><div class="md-prob-val" style="color:'+ec(en.homeWin)+'">'+Math.round(en.homeWin)+'%</div><div class="md-prob-lbl">1 (Gazde)</div></div>';
        out+='<div class="md-prob"><div class="md-prob-val" style="color:'+ec(en.draw)+'">'+Math.round(en.draw)+'%</div><div class="md-prob-lbl">X (Egal)</div></div>';
        out+='<div class="md-prob"><div class="md-prob-val" style="color:'+ec(en.awayWin)+'">'+Math.round(en.awayWin)+'%</div><div class="md-prob-lbl">2 (Oaspeți)</div></div>';
        out+='</div>';
      }
      if(en.dc1x!=null||en.dcx2!=null){
        out+='<div class="md-prob-row">';
        out+='<div class="md-prob"><div class="md-prob-val" style="color:'+ec(en.dc1x)+'">'+Math.round(en.dc1x||0)+'%</div><div class="md-prob-lbl">1X</div></div>';
        out+='<div class="md-prob"><div class="md-prob-val" style="color:'+ec(en.dcx2)+'">'+Math.round(en.dcx2||0)+'%</div><div class="md-prob-lbl">X2</div></div>';
        out+='</div>';
      }
      // Badge LOW/MED/HIGH derivat din confidenceScore (pragurile noi 70/55)
      if(en.confidenceScore!=null){
        var _csMd=en.confidenceScore;
        var _cbMd=_csMd>=70?'HIGH':_csMd>=55?'MED':'LOW';
        out+='<div style="text-align:center;margin-top:6px"><span class="badge-conf '+_cbMd+'">Incredere: '+_cbMd+'</span></div>';
      }
    }
    out+='</div>';
  }

  // FIX 4 — PIEȚE SPECIALE (cărți / cornere, deja calculate de enrich)
  (function(){
    var hasCards=(en.cardsOver35!=null&&en.cardsOver35>0)||(en.cardsOver45!=null&&en.cardsOver45>0);
    var hasCorn =(en.cornersOver85!=null&&en.cornersOver85>0)||(en.cornersOver95!=null&&en.cornersOver95>0);
    if(!hasCards&&!hasCorn)return;
    out+='<div class="md-section"><div class="md-section-title">Piețe Speciale</div>';
    if(hasCards){
      // BUG FIX: poissonProbOver returnează deja 0-100 (vezi calc-utils.js).
      // Înmulțirea cu 100 producea valori 7500% etc. Folosim direct valoarea.
      var c35=Math.round(+en.cardsOver35||0);
      var c45=Math.round(+en.cardsOver45||0);
      out+='<div class="md-prob-row">';
      out+='<div class="md-prob"><div class="md-prob-val" style="color:'+ec(c35)+'">'+c35+'%</div><div class="md-prob-lbl">🟨 Cărți Over 3.5</div></div>';
      out+='<div class="md-prob"><div class="md-prob-val" style="color:'+ec(c45)+'">'+c45+'%</div><div class="md-prob-lbl">🟨 Cărți Over 4.5</div></div>';
      out+='</div>';
    }
    if(hasCorn){
      var k85=Math.round(+en.cornersOver85||0);
      var k95=Math.round(+en.cornersOver95||0);
      out+='<div class="md-prob-row">';
      out+='<div class="md-prob"><div class="md-prob-val" style="color:'+ec(k85)+'">'+k85+'%</div><div class="md-prob-lbl">📐 Cornere Over 8.5</div></div>';
      out+='<div class="md-prob"><div class="md-prob-val" style="color:'+ec(k95)+'">'+k95+'%</div><div class="md-prob-lbl">📐 Cornere Over 9.5</div></div>';
      out+='</div>';
    }
    out+='</div>';
  })();

  // ── CALIBRARE CU COTE REALE ───────────────────────────────────────
  if(en.homeWin!=null||en.over15Prob!=null){
    var _lH=+(en.lambdaHome)||1.3, _lA=+(en.lambdaAway)||1.1;
    out+='<div class="md-section">';
    out+='<div class="md-section-title">🔄 Calibrare cu cote reale</div>';
    out+='<div style="font-size:10px;color:var(--mu);margin-bottom:14px">Introdu cotele 1/X/2 de la bookmaker. Sistemul recalculează λ și actualizează <b>toate piețele</b>.</div>';
    out+='<div style="display:flex;gap:10px;margin-bottom:14px">';
    out+='<div style="flex:1"><div style="font-size:10px;font-weight:600;color:var(--mu);margin-bottom:5px;text-align:center">1 GAZDE</div>';
    out+='<input type="text" inputmode="decimal" id="mev_c1_'+fk+'" value="" placeholder="1.80" oninput="mevCalibrate(\''+fk+'\')" style="width:100%;background:rgba(255,255,255,.07);border:2px solid rgba(255,255,255,.15);color:var(--tx);padding:10px 6px;border-radius:8px;font-size:18px;font-weight:800;text-align:center;outline:none;box-sizing:border-box"></div>';
    out+='<div style="flex:1"><div style="font-size:10px;font-weight:600;color:var(--mu);margin-bottom:5px;text-align:center">X EGAL</div>';
    out+='<input type="text" inputmode="decimal" id="mev_cx_'+fk+'" value="" placeholder="3.40" oninput="mevCalibrate(\''+fk+'\')" style="width:100%;background:rgba(255,255,255,.07);border:2px solid rgba(255,255,255,.15);color:var(--tx);padding:10px 6px;border-radius:8px;font-size:18px;font-weight:800;text-align:center;outline:none;box-sizing:border-box"></div>';
    out+='<div style="flex:1"><div style="font-size:10px;font-weight:600;color:var(--mu);margin-bottom:5px;text-align:center">2 OASPEȚI</div>';
    out+='<input type="text" inputmode="decimal" id="mev_c2_'+fk+'" value="" placeholder="4.50" oninput="mevCalibrate(\''+fk+'\')" style="width:100%;background:rgba(255,255,255,.07);border:2px solid rgba(255,255,255,.15);color:var(--tx);padding:10px 6px;border-radius:8px;font-size:18px;font-weight:800;text-align:center;outline:none;box-sizing:border-box"></div>';
    out+='</div>';
    out+='<div id="mev_res_'+fk+'"'
      +' data-lh="'+_lH+'" data-la="'+_lA+'"'
      +' data-hw="'+(en.homeWin||'')+'" data-dr="'+(en.draw||'')+'" data-aw="'+(en.awayWin||'')+'"'
      +' data-o15="'+(en.over15Prob!=null?Math.round(en.over15Prob):'')+'"'
      +' data-o25="'+(en.over25Prob!=null?Math.round(en.over25Prob):'')+'"'
      +' data-gg="'+(en.ggProb!=null?Math.round(en.ggProb):'')+'"'
      +' data-hsc="'+(en.homeScoreRate||'')+'" data-asc="'+(en.awayScoreRate||'')+'"'
      +' data-lt="'+Number(en.lambdaTotal||0).toFixed(2)+'"'
      +' data-cs="'+(en.confidenceScore!=null?en.confidenceScore:'')+'"'
      +' data-po="'+(_poOrig!=null?_poOrig:'')+'"'
      +' data-pow="'+_powVal+'">'
      +'<div style="color:var(--mu);font-size:11px;padding:6px 0">Introdu cotele pentru 1, X și 2 →</div></div>';
    out+='</div>';
  }

  // League Profile
  if(en.leagueStats){
    var ls=en.leagueStats;
    var ltMap={open:{icon:'🟢',label:'Deschisă'},closed:{icon:'🔴',label:'Închisă'},aggressive:{icon:'🟡',label:'Agresivă'},balanced:{icon:'⚪',label:'Echilibrată'}};
    var lt=ltMap[ls.league_type]||ltMap.balanced;
    out+='<div class="md-section"><div class="md-section-title">Profil Ligă</div>';
    out+='<div class="league-profile">';
    out+='<div class="lp-row"><span class="lp-label">Tip ligă</span><span class="lp-val">'+lt.icon+' '+lt.label+'</span></div>';
    out+='<div class="lp-row"><span class="lp-label">Medie goluri</span><span class="lp-val">'+(ls.avg_goals_per_match!=null?parseFloat(ls.avg_goals_per_match).toFixed(2):'—')+' / meci</span></div>';
    out+='<div class="lp-row"><span class="lp-label">Over 1.5 / Over 2.5</span><span class="lp-val">'+(ls.pct_over_15!=null?Math.round(ls.pct_over_15):'—')+'% / '+(ls.pct_over_25!=null?Math.round(ls.pct_over_25):'—')+'%</span></div>';
    out+='<div class="lp-row"><span class="lp-label">GG</span><span class="lp-val">'+(ls.pct_gg!=null?Math.round(ls.pct_gg):'—')+'%</span></div>';
    out+='</div></div>';
  }

  // ── PROFIL ARBITRU (Task 3) ───────────────────────────────
  (function(){
    var refName=fix&&fix.fixture&&fix.fixture.referee?fix.fixture.referee:null;
    var rs=en.refereeStats||null;
    var hasStats=rs&&Number(rs.total_matches)>=5;
    var rsStyleMap={
      strict:{icon:'🔴',label:'Strict'},lenient:{icon:'🟢',label:'Permisiv'},
      open:{icon:'⚽',label:'Ofensiv'},closed:{icon:'🛡️',label:'Defensiv'},
      neutral:{icon:'⚪',label:'Neutru'},high_scorer:{icon:'⚽',label:'Ofensiv'},
      low_scorer:{icon:'🛡️',label:'Defensiv'}
    };
    out+='<div class="md-section"><div class="md-section-title">Profil Arbitru</div>';
    out+='<div class="league-profile">';
    if(refName){
      out+='<div class="lp-row"><span class="lp-label">Nume</span><span class="lp-val" style="font-size:11px">'+htmlEsc(refName)+'</span></div>';
    } else {
      out+='<div class="lp-row"><span class="lp-label">Arbitru</span><span class="lp-val" style="color:var(--mu)">Necunoscut</span></div>';
    }
    if(hasStats){
      var rst=rsStyleMap[rs.referee_style]||rsStyleMap.neutral;
      out+='<div class="lp-row"><span class="lp-label">Stil</span><span class="lp-val">'+rst.icon+' '+rst.label+'</span></div>';
      out+='<div class="lp-row"><span class="lp-label">🟡 Galbene</span><span class="lp-val">'+parseFloat(rs.avg_yellow_cards||0).toFixed(1)+' / meci</span></div>';
      out+='<div class="lp-row"><span class="lp-label">🔴 Roșii</span><span class="lp-val">'+parseFloat(rs.avg_red_cards||0).toFixed(1)+' / meci</span></div>';
      out+='<div class="lp-row"><span class="lp-label">⚽ Goluri</span><span class="lp-val">'+parseFloat(rs.avg_goals||0).toFixed(1)+' / meci</span></div>';
      if(rs.avg_corners!=null)out+='<div class="lp-row"><span class="lp-label">📐 Cornere</span><span class="lp-val">'+parseFloat(rs.avg_corners).toFixed(1)+' / meci</span></div>';
      if(rs.avg_penalties!=null)out+='<div class="lp-row"><span class="lp-label">🎯 Penalty</span><span class="lp-val">'+parseFloat(rs.avg_penalties).toFixed(1)+' / meci</span></div>';
      // Pattern text
      var pattern=[];
      var avgY=parseFloat(rs.avg_yellow_cards||0);
      var avgG=parseFloat(rs.avg_goals||0);
      var pctGG=parseFloat(rs.pct_gg||0);
      if(avgY>4.5)pattern.push('Arbitru sever — intervine frecvent, echipele agresive sunt dezavantajate');
      else if(avgY<2.5)pattern.push('Arbitru permisiv — lasă jocul să curgă, meciurile tind spre mai multe goluri');
      if(avgG>2.8)pattern.push('Favorabil meciurilor cu goluri — Over 2.5 are istoric bun cu acest arbitru');
      if(pctGG>55)pattern.push('Ambele echipe marchează frecvent în meciurile conduse de acest arbitru');
      if(pattern.length){
        out+='<div style="margin-top:6px;padding:8px;background:rgba(99,102,241,.1);border-radius:8px;font-size:11px;color:var(--mu2);line-height:1.5">';
        pattern.forEach(function(p){out+='<div>💡 '+htmlEsc(p)+'</div>';});
        out+='</div>';
      }
    } else {
      out+='<div class="lp-row"><span class="lp-label">Statistici</span><span class="lp-val" style="color:var(--mu)">Date indisponibile</span></div>';
    }
    out+='</div></div>';
  })();

  // ── STADION & METEO placeholder (Tasks 4 + 5) ────────────────
  (function(){
    var fid=_md.fixtureId;
    var cached=_venueWeatherCache[fid];
    var venueId=fix&&fix.fixture&&fix.fixture.venue&&fix.fixture.venue.id?fix.fixture.venue.id:0;
    var venueName=fix&&fix.fixture&&fix.fixture.venue&&fix.fixture.venue.name?fix.fixture.venue.name:null;
    var venueCity=fix&&fix.fixture&&fix.fixture.venue&&fix.fixture.venue.city?fix.fixture.venue.city:null;
    var matchDt=fix&&fix.fixture&&fix.fixture.date?fix.fixture.date:null;
    out+='<div id="md-venue-sec-'+fid+'"></div>';
    if(cached){
      out=out.replace('<div id="md-venue-sec-'+fid+'"></div>', mdBuildVenueWeatherHTML(cached, venueName, venueCity));
    } else if(venueId&&matchDt){
      // Fire async fetch
      setTimeout(function(){
        fetch('/api/venue-weather?venue_id='+venueId+'&dt='+encodeURIComponent(matchDt))
          .then(function(r){return r.json();})
          .then(function(d){
            if(_md.fixtureId!==fid)return;
            _venueWeatherCache[fid]=d;
            var el=document.getElementById('md-venue-sec-'+fid);
            if(el)el.outerHTML=mdBuildVenueWeatherHTML(d, venueName, venueCity);
          }).catch(function(){});
      },0);
    }
  })();

  // H2H
  if(en.h2hForm&&en.h2hForm.length){
    out+='<div class="md-section"><div class="md-section-title">H2H Direct (ultimele 5)</div>';
    en.h2hForm.forEach(function(h){
      var hT=h.homeTeam||h.home||'?';
      var aT=h.awayTeam||h.away||'?';
      var sc=(h.homeGoals!=null&&h.awayGoals!=null)?(h.homeGoals+'-'+h.awayGoals):(h.score||'—');
      var dt=h.date?new Date(h.date).toLocaleDateString('ro-RO',{day:'2-digit',month:'2-digit',year:'numeric'}):'';
      out+='<div class="md-h2h-row">';
      out+='<div class="md-h2h-teams">'+hT+' vs '+aT+'</div>';
      out+='<div class="md-h2h-score">'+sc+'</div>';
      out+='<div class="md-h2h-date">'+dt+'</div>';
      out+='</div>';
    });
    out+='</div>';
  }

  document.getElementById('md-body').innerHTML=out;
}

function mdRenderFormatii(d){
  var lineups=d.lineups||[];
  if(!lineups.length){
    var st=_md&&_md.data&&_md.data.fixture&&_md.data.fixture.fixture&&_md.data.fixture.fixture.status&&_md.data.fixture.fixture.status.short||'';
    var msg='';
    if(st==='NS'||st==='TBD'||st==='PST'||st==='CANC'||st==='ABD'){
      msg='<div class="empty-s">Formațiile vor fi disponibile cu ~1h înainte de startul meciului</div>';
    } else if(st==='FT'||st==='AET'||st==='PEN'||st==='AWD'||st==='WO'){
      msg='<div class="empty-s">Formațiile nu au fost transmise de API pentru acest meci</div>';
    } else if(st==='1H'||st==='2H'||st==='HT'||st==='ET'||st==='BT'||st==='P'){
      msg='<div class="empty-s">Formațiile nu sunt disponibile pentru această ligă sau competiție</div>';
    } else {
      msg='<div class="empty-s">Formațiile nu sunt disponibile pentru această ligă sau meciul nu a început</div>';
    }
    // Fallback ANTRENORI din prematch_data (PAS 3) — afișăm cel puțin antrenorii
    // când lineup-urile încă nu sunt anunțate.
    var co=d.coaches||{};
    var hn=_md&&_md.data&&_md.data.fixture&&_md.data.fixture.teams&&_md.data.fixture.teams.home&&_md.data.fixture.teams.home.name||'Gazde';
    var an=_md&&_md.data&&_md.data.fixture&&_md.data.fixture.teams&&_md.data.fixture.teams.away&&_md.data.fixture.teams.away.name||'Oaspeți';
    var coachHtml='';
    if((co.home&&co.home.name)||(co.away&&co.away.name)){
      coachHtml='<div class="md-section"><div class="md-section-title">Antrenori</div>';
      coachHtml+='<div class="lp-row"><span class="lp-label">'+htmlEsc(hn)+'</span><span class="lp-val">'+(co.home&&co.home.name?'👔 '+htmlEsc(co.home.name):'—')+'</span></div>';
      coachHtml+='<div class="lp-row"><span class="lp-label">'+htmlEsc(an)+'</span><span class="lp-val">'+(co.away&&co.away.name?'👔 '+htmlEsc(co.away.name):'—')+'</span></div>';
      coachHtml+='</div>';
    }
    document.getElementById('md-body').innerHTML=coachHtml+'<div class="empty"><div class="empty-icon">📋</div><div class="empty-t">Formații indisponibile</div>'+msg+'</div>';
    return;
  }
  var out='';
  lineups.forEach(function(team){
    var tn=team.team&&team.team.name||'?';
    var fm=team.formation||'?';
    out+='<div class="md-section">';
    out+='<div class="md-section-title">'+tn+'</div>';
    out+='<div class="md-formation-label">'+fm+'</div>';
    var starters=team.startXI||[];
    starters.forEach(function(p){
      var pl=p.player||{};
      out+=mdPlayerRow(pl,d.players);
    });
    var subs=team.substitutes||[];
    if(subs.length){
      out+='<div class="md-sub-divider">REZERVE</div>';
      subs.forEach(function(p){
        var pl=p.player||{};
        out+=mdPlayerRow(pl,d.players);
      });
    }
    out+='</div>';
  });
  document.getElementById('md-body').innerHTML=out;
}

function mdPlayerRow(pl,allPlayers){
  var name=pl.name||'?';
  var num=pl.number||'';
  var matched=allPlayers&&allPlayers.find(function(p){return p.id===pl.id;});
  var rating=matched&&matched.rating;
  var rClass=rating?rating>=7.5?'high':rating>=6.5?'mid':'low':'';
  var rText=rating?Number(rating).toFixed(1):'';
  return '<div class="md-player-row">'+
    '<div class="md-player-num">'+num+'</div>'+
    '<div class="md-player-name">'+name+'</div>'+
    (rText?'<div class="md-player-rating '+rClass+'">'+rText+'</div>':'')+
    '</div>';
}

function mdRenderJucatori(d){
  var players=d.players||[];
  if(!players.length){
    var st=_md&&_md.data&&_md.data.fixture&&_md.data.fixture.fixture&&_md.data.fixture.fixture.status&&_md.data.fixture.fixture.status.short||'';
    var msg='';
    if(st==='NS'||st==='TBD'||st==='PST'||st==='CANC'||st==='ABD'){
      msg='<div class="empty-s">Statisticile jucătorilor vor fi disponibile după startul meciului</div>';
    } else if(st==='FT'||st==='AET'||st==='PEN'||st==='AWD'||st==='WO'){
      msg='<div class="empty-s">Statisticile nu au fost transmise de API pentru acest meci finalizat</div>';
    } else {
      msg='<div class="empty-s">Statistici jucători indisponibile pentru această ligă</div>';
    }
    document.getElementById('md-body').innerHTML='<div class="empty"><div class="empty-icon">👤</div><div class="empty-t">Statistici indisponibile</div>'+msg+'</div>';
    return;
  }
  var out='<div class="md-section"><div class="md-section-title">Top jucători după rating</div>';
  players.slice(0,20).forEach(function(p){
    if(!p.rating&&!p.goals&&!p.assists)return;
    var rClass=p.rating?p.rating>=7.5?'high':p.rating>=6.5?'mid':'low':'';
    out+='<div class="md-player-card">';
    out+='<div class="md-pc-top">';
    out+='<div><div class="md-pc-name">'+p.name+'</div><div class="md-pc-team">'+p.teamName+' · '+p.position+'</div></div>';
    if(p.rating)out+='<div class="md-player-rating '+rClass+'">'+Number(p.rating).toFixed(1)+'</div>';
    out+='</div>';
    out+='<div class="md-pc-stats">';
    if(p.goals)out+='<span class="md-pc-stat">Goluri <span>'+p.goals+'</span></span>';
    if(p.assists)out+='<span class="md-pc-stat">Assist <span>'+p.assists+'</span></span>';
    if(p.passAcc)out+='<span class="md-pc-stat">Pase% <span>'+p.passAcc+'</span></span>';
    if(p.dribbles)out+='<span class="md-pc-stat">Drib <span>'+p.dribbles+'</span></span>';
    var shTxt=(p.shots_total==null)?'-':(p.shots_total+'/'+(p.shots_on_target==null?0:p.shots_on_target));
    out+='<span class="md-pc-stat">Șut/SOT <span>'+shTxt+'</span></span>';
    if(p.yellowCards)out+='<span class="md-pc-stat">🟨 <span>'+p.yellowCards+'</span></span>';
    if(p.redCards)out+='<span class="md-pc-stat">🟥 <span>'+p.redCards+'</span></span>';
    out+='<span class="md-pc-stat">Min <span>'+p.minutes+'</span></span>';
    out+='</div></div>';
  });
  out+='</div>';
  document.getElementById('md-body').innerHTML=out;
}

function mdRenderForma(d){
  var en=d.enrich||{};
  var fix=d.fixture;
  var hn=fix&&fix.teams&&fix.teams.home?fix.teams.home.name:'Gazde';
  var an=fix&&fix.teams&&fix.teams.away?fix.teams.away.name:'Oaspeti';
  var out='';

  function formSection(title,form){
    if(!form||!form.length)return '<div class="md-section"><div class="md-section-title">'+title+'</div><div style="color:var(--mu);font-size:12px">Fără date</div></div>';
    var s='<div class="md-section"><div class="md-section-title">'+title+'</div>';
    form.forEach(function(f){
      s+='<div class="md-form-row">';
      s+='<div class="md-form-badge '+(f.result||'D')+'">'+(f.result||'D')+'</div>';
      s+='<div class="md-form-score">'+(f.score||'')+'</div>';
      s+='<div class="md-form-opp">vs '+(f.opponent||'?')+'</div>';
      s+='<div class="md-form-date">'+(f.date||'')+'</div>';
      s+='</div>';
    });
    s+='</div>';
    return s;
  }

  out+=formSection('Forma '+hn+' (ultimele 5 acasă)',en.homeForm);
  out+=formSection('Forma '+an+' (ultimele 5 deplasare)',en.awayForm);

  if(en.h2hForm&&en.h2hForm.length){
    out+='<div class="md-section"><div class="md-section-title">H2H Direct (ultimele 5)</div>';
    en.h2hForm.forEach(function(h){
      var hT=h.homeTeam||h.home||'?';
      var aT=h.awayTeam||h.away||'?';
      var sc=(h.homeGoals!=null&&h.awayGoals!=null)?(h.homeGoals+'-'+h.awayGoals):(h.score||'—');
      var dt=h.date?new Date(h.date).toLocaleDateString('ro-RO',{day:'2-digit',month:'2-digit',year:'numeric'}):'';
      out+='<div class="md-h2h-row">';
      out+='<div class="md-h2h-teams">'+hT+' vs '+aT+'</div>';
      out+='<div class="md-h2h-score">'+sc+'</div>';
      out+='<div class="md-h2h-date">'+dt+'</div>';
      out+='</div>';
    });
    out+='</div>';
  }

  if(en.h2hOver15!=null){
    // Bug fix: când h2hSample === 0 (sau null), procentele NU sunt H2H reale —
    // în api/enrich.js, h2hOver15/h2hGG cad pe `?? matrix.X` (Poisson model)
    // când nu există h2h în DB. Afișarea acelor procente ca „H2H" e falsă.
    var nH2H=(typeof en.h2hSample==='number')?en.h2hSample:0;
    out+='<div class="md-section"><div class="md-section-title">Statistici H2H</div>';
    out+='<div class="md-prob-row">';
    var ec=function(v){return v==null?'#888':v>=70?'#22c55e':v>=50?'#f59e0b':'#ef4444';};
    if(nH2H>0){
      out+='<div class="md-prob"><div class="md-prob-val" style="color:'+ec(en.h2hOver15)+'">'+en.h2hOver15+'%</div><div class="md-prob-lbl">H2H Over 1.5</div></div>';
      out+='<div class="md-prob"><div class="md-prob-val" style="color:'+ec(en.h2hGG)+'">'+en.h2hGG+'%</div><div class="md-prob-lbl">H2H GG</div></div>';
    }else{
      out+='<div class="md-prob"><div class="md-prob-val" style="color:var(--mu2);font-size:11px">Date insuficiente</div><div class="md-prob-lbl">H2H Over 1.5</div></div>';
      out+='<div class="md-prob"><div class="md-prob-val" style="color:var(--mu2);font-size:11px">Date insuficiente</div><div class="md-prob-lbl">H2H GG</div></div>';
    }
    out+='<div class="md-prob"><div class="md-prob-val" style="color:var(--mu2)">'+nH2H+'</div><div class="md-prob-lbl">Meciuri H2H</div></div>';
    out+='</div></div>';
  }

  document.getElementById('md-body').innerHTML=out;
}

// ── STADION + METEO HTML builder ──────────────────────────────
function mdBuildVenueWeatherHTML(data, fallbackName, fallbackCity) {
  var v=data&&data.venue;
  var w=data&&data.weather;
  var out='';

  // STADION
  out+='<div class="md-section"><div class="md-section-title">Stadion & Locație</div>';
  out+='<div class="league-profile">';
  var name=v?v.name:fallbackName;
  var city=v?v.city:fallbackCity;
  if(name)out+='<div class="lp-row"><span class="lp-label">🏟️ Stadion</span><span class="lp-val" style="font-size:11px">'+htmlEsc(name)+'</span></div>';
  if(city){
    var loc=htmlEsc(city)+(v&&v.country?', '+htmlEsc(v.country):'');
    out+='<div class="lp-row"><span class="lp-label">🌍 Oraș</span><span class="lp-val">'+loc+'</span></div>';
  }
  if(v&&v.capacity&&Number(v.capacity)>0)out+='<div class="lp-row"><span class="lp-label">👥 Capacitate</span><span class="lp-val">'+Number(v.capacity).toLocaleString()+' locuri</span></div>';
  if(v&&v.surface){
    var surfLabel=v.surface==='artificial'?'Teren artificial ⚡':v.surface==='grass'?'Gazon natural 🌿':htmlEsc(v.surface);
    out+='<div class="lp-row"><span class="lp-label">🌱 Suprafață</span><span class="lp-val">'+surfLabel+'</span></div>';
  }
  if(!v&&!name&&!city)out+='<div class="lp-row"><span style="color:var(--mu);font-size:11px">Date stadion indisponibile</span></div>';
  out+='</div></div>';

  // METEO
  out+='<div class="md-section"><div class="md-section-title">Meteo la Ora Meciului</div>';
  if(w){
    out+='<div class="league-profile">';
    out+='<div class="lp-row"><span class="lp-label">'+w.icon+' Condiții</span><span class="lp-val">'+htmlEsc(w.description)+'</span></div>';
    if(w.temperature!=null)out+='<div class="lp-row"><span class="lp-label">🌡️ Temperatură</span><span class="lp-val">'+w.temperature+'°C</span></div>';
    out+='<div class="lp-row"><span class="lp-label">💨 Vânt</span><span class="lp-val">'+w.wind+' km/h</span></div>';
    out+='<div class="lp-row"><span class="lp-label">💧 Precipitații</span><span class="lp-val">'+w.precipitation+' mm</span></div>';
    out+='</div>';
    if(w.influence&&w.influence.length){
      out+='<div style="margin-top:6px;padding:8px;background:rgba(99,102,241,.1);border-radius:8px;font-size:11px;color:var(--mu2);line-height:1.6">';
      w.influence.forEach(function(n){out+='<div>'+htmlEsc(n)+'</div>';});
      out+='</div>';
    }
  } else if(v&&v.latitude&&Number(v.latitude)){
    out+='<div style="color:var(--mu);font-size:11px;padding:4px 0">⏳ Se încarcă prognoza...</div>';
  } else {
    out+='<div style="color:var(--mu);font-size:11px;padding:4px 0">Meteo indisponibil — coordonate stadion lipsă</div>';
  }
  out+='</div>';
  return out;
}

// ── CLASAMENT tab renderer ─────────────────────────────────────
async function mdRenderClasament(d) {
  var body=document.getElementById('md-body');
  var fid=_md.fixtureId;
  var fix=d.fixture;
  var lid=fix&&fix.league&&fix.league.id?fix.league.id:0;
  var hid=fix&&fix.teams&&fix.teams.home&&fix.teams.home.id?fix.teams.home.id:_md.homeId;
  var aid=fix&&fix.teams&&fix.teams.away&&fix.teams.away.id?fix.teams.away.id:_md.awayId;
  // BUG #14 FIX: înainte de iulie = sezonul trecut; din iulie încolo = sezonul curent
  var _seasonNow=new Date();
  var _seasonFallback=_seasonNow.getMonth()<6?_seasonNow.getFullYear()-1:_seasonNow.getFullYear();
  var season=fix&&fix.league&&fix.league.season?fix.league.season:_seasonFallback;

  if(!lid){
    body.innerHTML='<div class="empty"><div class="empty-icon">📊</div><div class="empty-t">Indisponibil</div><div class="empty-s">Liga nu a putut fi identificată</div></div>';
    return;
  }

  // Use cache or fetch
  var cacheKey=lid+'_'+season;
  if(!_standingsCache[cacheKey]){
    body.innerHTML='<div class="spinner"><div class="spin"></div></div>';
    try{
      var r=await fetch('/api/standings-data?league='+lid+'&season='+season+'&hid='+hid+'&aid='+aid);
      var data2=await r.json();
      if(data2.error)throw new Error(data2.error);
      _standingsCache[cacheKey]=data2;
    }catch(e){
      body.innerHTML='<div class="empty"><div class="empty-icon">⚠️</div><div class="empty-t">Eroare</div><div class="empty-s">'+e.message+'</div></div>';
      return;
    }
    // Check still on clasament tab and same fixture
    if(_md.tabIdx!==4||_md.fixtureId!==fid)return;
  }

  var sd=_standingsCache[cacheKey];
  var rows=sd.standings||[];
  if(!rows.length){
    body.innerHTML='<div class="empty"><div class="empty-icon">📊</div><div class="empty-t">Date indisponibile</div><div class="empty-s">Clasamentul nu este disponibil în baza de date și nu s-a putut prelua din API</div></div>';
    return;
  }

  var homeId2=Number(hid),awayId2=Number(aid);
  var homePoints=sd.homePoints,awayPoints=sd.awayPoints;

  var out='<div style="padding:0 0 8px"><div style="font-size:11px;color:var(--mu);margin-bottom:8px">'+
    (fix&&fix.league?fix.league.name:'')+'<span style="float:right">Sezon '+season+'</span></div>';
  out+='<div style="overflow-x:auto"><table class="standings-tbl">';
  out+='<thead><tr><th>#</th><th class="tn">Echipă</th><th>J</th><th>V</th><th>E</th><th>Î</th><th>GF</th><th>GA</th><th>GD</th><th style="color:var(--ac)">Pct</th></tr></thead>';
  out+='<tbody>';
  rows.forEach(function(row){
    var tid=Number(row.team_id);
    var isHome=tid===homeId2,isAway=tid===awayId2;
    var rowCls='';
    if(isHome||isAway){
      // BUG #15 FIX: guard explicit înainte de logica de comparare puncte
      if(homePoints==null||awayPoints==null){
        rowCls=isHome?'srow-home':'srow-away';
      } else if(homePoints===awayPoints){
        rowCls='srow-even';
      } else if(isHome&&homePoints>awayPoints){
        rowCls='srow-home';
      } else if(isAway&&awayPoints>homePoints){
        rowCls='srow-home';
      } else {
        rowCls='srow-away';
      }
    }
    var logoHtml=row.team_logo?'<img src="'+row.team_logo+'" width="16" height="16" style="vertical-align:middle;margin-right:4px;border-radius:2px" onerror="this.style.display=\'none\'">':'';
    var bold=isHome||isAway?'font-weight:800;':'';
    out+='<tr class="'+rowCls+'">';
    out+='<td style="color:var(--mu)">'+row.rank+'</td>';
    out+='<td class="tn" style="'+bold+'">'+logoHtml+htmlEsc(row.team_name||'')+'</td>';
    out+='<td>'+row.played+'</td><td>'+row.win+'</td><td>'+row.draw+'</td><td>'+row.lose+'</td>';
    out+='<td>'+row.goals_for+'</td><td>'+row.goals_against+'</td>';
    out+='<td style="color:'+(Number(row.goals_diff)>=0?'#22c55e':'#ef4444')+'">'+
      (Number(row.goals_diff)>0?'+':'')+row.goals_diff+'</td>';
    out+='<td style="font-weight:800;color:var(--ac)">'+row.points+'</td>';
    out+='</tr>';
  });
  out+='</tbody></table></div>';
  // Legend
  out+='<div style="display:flex;gap:12px;font-size:10px;color:var(--mu);margin-top:8px">';
  out+='<span><span style="display:inline-block;width:10px;height:10px;background:rgba(34,197,94,.3);border-radius:2px;margin-right:4px"></span>Echipă în avantaj</span>';
  out+='<span><span style="display:inline-block;width:10px;height:10px;background:rgba(239,68,68,.2);border-radius:2px;margin-right:4px"></span>Echipă în dezavantaj</span>';
  out+='<span><span style="display:inline-block;width:10px;height:10px;background:rgba(245,158,11,.15);border-radius:2px;margin-right:4px"></span>Egal</span>';
  out+='</div>';
  out+='</div>';
  body.innerHTML=out;
}

// ══════════════════════════════════════════════════════════════════════════
// PAGINA DE ECHIPĂ — refolosită din pagina de meci (tap pe logo/nume echipă).
// Folosește EXCLUSIV clasele CSS existente (md-overlay, md-tabs, md-tab,
// md-section, md-player-card, md-form-row, standings-tbl, srow-home, empty).
// Backend: GET /api/team?id=&league_id=&season= (read-only DB).
// ══════════════════════════════════════════════════════════════════════════
var _tp={data:null,tabIdx:0,teamId:0,leagueId:0};

// Deschide pagina echipei. leagueId opțional (din fixture) → join sezon corect.
function tpOpen(teamId,leagueId){
  if(!teamId)return;
  _tp.teamId=Number(teamId);_tp.leagueId=Number(leagueId)||0;_tp.tabIdx=0;_tp.data=null;
  var ov=document.getElementById('tp-overlay');
  ov.classList.add('open');
  document.getElementById('tp-body').innerHTML='<div class="spinner"><div class="spin"></div></div>';
  document.getElementById('tp-title').textContent='Echipă';
  document.querySelectorAll('#tp-overlay .md-tab').forEach(function(t,i){t.classList.toggle('active',i===0);});
  tpFetch();
}
function tpClose(){
  document.getElementById('tp-overlay').classList.remove('open');
}
function tpTab(idx){
  _tp.tabIdx=idx;
  document.querySelectorAll('#tp-overlay .md-tab').forEach(function(t,i){t.classList.toggle('active',i===idx);});
  tpRender();
}

// Swipe-down to close (același pattern ca md-overlay)
(function(){
  var startY=0;
  var ov=document.getElementById('tp-overlay');
  if(!ov)return;
  ov.addEventListener('touchstart',function(e){startY=e.touches[0].clientY;},{passive:true});
  ov.addEventListener('touchend',function(e){
    var dy=e.changedTouches[0].clientY-startY;
    if(dy>80&&document.getElementById('tp-body').scrollTop<=0)tpClose();
  },{passive:true});
})();

async function tpFetch(){
  try{
    var tid=_tp.teamId;
    var url='/api/team?id='+tid+(_tp.leagueId?'&league_id='+_tp.leagueId:'');
    var r=await fetch(url);
    var d=await r.json();
    if(d.error)throw new Error(d.error);
    if(_tp.teamId!==tid)return;
    _tp.data=d;
    var m=d.meta||{};
    document.getElementById('tp-title').textContent=m.teamName||'Echipă';
    tpRender();
  }catch(e){
    document.getElementById('tp-body').innerHTML='<div class="empty"><div class="empty-icon">⚠️</div><div class="empty-t">Eroare</div><div class="empty-s">'+htmlEsc(e.message)+'</div></div>';
  }
}

function tpRender(){
  var d=_tp.data;if(!d)return;
  try{
    if(_tp.tabIdx===0)tpRenderJucatori(d);
    else if(_tp.tabIdx===1)tpRenderForma(d);
    else if(_tp.tabIdx===2)tpRenderClasament(d);
    else if(_tp.tabIdx===3)tpRenderStatistici(d);
  }catch(e){
    console.error('[tpRender] tab '+_tp.tabIdx+' error:',e&&e.stack?e.stack:e);
    document.getElementById('tp-body').innerHTML='<div class="empty"><div class="empty-icon">⚠️</div><div class="empty-t">Eroare</div><div class="empty-s">'+htmlEsc(e.message)+'</div></div>';
  }
}

// Antet reutilizabil: logo + nume + ligă + loc (clasele md-section existente).
function tpHeaderHtml(m){
  var loc=m.rank?('Locul '+m.rank):'';
  var sub=(m.leagueName||'')+(m.season?(' · '+m.season):'')+(loc?(' · '+loc):'');
  var logo=m.logo?'<img src="'+m.logo+'" width="40" height="40" style="border-radius:6px;object-fit:contain;vertical-align:middle;margin-right:10px" onerror="this.style.display=\'none\'">':'';
  return '<div class="md-section"><div style="display:flex;align-items:center">'+logo+
    '<div><div style="font-size:16px;font-weight:800">'+htmlEsc(m.teamName||'Echipă')+'</div>'+
    '<div style="font-size:11px;color:var(--mu);margin-top:2px">'+htmlEsc(sub)+'</div></div></div></div>';
}

function tpRenderJucatori(d){
  var body=document.getElementById('tp-body');
  var g=d.players||{G:[],D:[],M:[],F:[]};
  var total=(g.G.length+g.D.length+g.M.length+g.F.length);
  var out=tpHeaderHtml(d.meta||{});
  if(!total){
    out+='<div class="empty"><div class="empty-icon">👤</div><div class="empty-t">Lot indisponibil</div><div class="empty-s">Statisticile jucătorilor nu au fost colectate pentru sezonul curent al acestei echipe</div></div>';
    body.innerHTML=out;return;
  }
  var groupTitles={G:'Portari',D:'Fundași',M:'Mijlocași',F:'Atacanți'};
  ['G','D','M','F'].forEach(function(key){
    var arr=g[key];if(!arr||!arr.length)return;
    out+='<div class="md-section"><div class="md-section-title">'+groupTitles[key]+'</div>';
    arr.forEach(function(p){
      var rClass=p.rating?p.rating>=7.5?'high':p.rating>=6.5?'mid':'low':'';
      out+='<div class="md-player-card">';
      out+='<div class="md-pc-top">';
      out+='<div><div class="md-pc-name">'+htmlEsc(p.name)+'</div><div class="md-pc-team">'+(p.position?htmlEsc(p.position)+' · ':'')+p.apps+' meciuri</div></div>';
      if(p.rating)out+='<div class="md-player-rating '+rClass+'">'+Number(p.rating).toFixed(1)+'</div>';
      out+='</div>';
      out+='<div class="md-pc-stats">';
      if(p.goals)out+='<span class="md-pc-stat">Goluri <span>'+p.goals+'</span></span>';
      if(p.assists)out+='<span class="md-pc-stat">Assist <span>'+p.assists+'</span></span>';
      if(p.yellows)out+='<span class="md-pc-stat">🟨 <span>'+p.yellows+'</span></span>';
      if(p.reds)out+='<span class="md-pc-stat">🟥 <span>'+p.reds+'</span></span>';
      out+='<span class="md-pc-stat">Min <span>'+p.minutes+'</span></span>';
      out+='</div></div>';
    });
    out+='</div>';
  });
  body.innerHTML=out;
}

function tpRenderForma(d){
  var body=document.getElementById('tp-body');
  var form=d.form||[];
  var out=tpHeaderHtml(d.meta||{});
  if(!form.length){
    out+='<div class="empty"><div class="empty-icon">📋</div><div class="empty-t">Fără formă</div><div class="empty-s">Niciun meci finalizat în istoricul acestei echipe</div></div>';
    body.innerHTML=out;return;
  }
  // Rezumat V-E-I din meciurile afișate (result e W/D/L, ca badge-urile existente)
  var w=0,dr=0,l=0;
  form.forEach(function(f){if(f.result==='W')w++;else if(f.result==='D')dr++;else l++;});
  out+='<div class="md-section"><div class="md-section-title">Ultimele '+form.length+' meciuri ('+w+'V '+dr+'E '+l+'I)</div>';
  form.forEach(function(f){
    var dt=f.date?new Date(f.date).toLocaleDateString('ro-RO',{day:'2-digit',month:'2-digit'}):'';
    out+='<div class="md-form-row">';
    out+='<div class="md-form-badge '+f.result+'">'+f.result+'</div>';
    out+='<div class="md-form-score">'+htmlEsc(f.score)+'</div>';
    out+='<div class="md-form-opp">'+(f.home?'acasă':'deplasare')+' vs '+htmlEsc(f.opponent)+'</div>';
    out+='<div class="md-form-date">'+dt+'</div>';
    out+='</div>';
  });
  out+='</div>';
  body.innerHTML=out;
}

function tpRenderClasament(d){
  var body=document.getElementById('tp-body');
  var rows=d.standings||[];
  var out=tpHeaderHtml(d.meta||{});
  if(!rows.length){
    out+='<div class="empty"><div class="empty-icon">📊</div><div class="empty-t">Clasament indisponibil</div><div class="empty-s">Nu există meciuri finalizate în baza de date pentru această ligă/sezon</div></div>';
    body.innerHTML=out;return;
  }
  var myId=Number(d.meta&&d.meta.teamId);
  out+='<div style="overflow-x:auto"><table class="standings-tbl">';
  out+='<thead><tr><th>#</th><th class="tn">Echipă</th><th>J</th><th>V</th><th>E</th><th>Î</th><th>GF</th><th>GA</th><th>GD</th><th style="color:var(--ac)">Pct</th></tr></thead><tbody>';
  rows.forEach(function(row){
    var isMe=Number(row.team_id)===myId;
    var logoHtml=row.team_logo?'<img src="'+row.team_logo+'" width="16" height="16" style="vertical-align:middle;margin-right:4px;border-radius:2px" onerror="this.style.display=\'none\'">':'';
    out+='<tr class="'+(isMe?'srow-home':'')+'">';
    out+='<td style="color:var(--mu)">'+row.rank+'</td>';
    out+='<td class="tn" style="'+(isMe?'font-weight:800;':'')+'">'+logoHtml+htmlEsc(row.team_name||'')+'</td>';
    out+='<td>'+row.played+'</td><td>'+row.win+'</td><td>'+row.draw+'</td><td>'+row.lose+'</td>';
    out+='<td>'+row.goals_for+'</td><td>'+row.goals_against+'</td>';
    out+='<td style="color:'+(Number(row.goals_diff)>=0?'#22c55e':'#ef4444')+'">'+(Number(row.goals_diff)>0?'+':'')+row.goals_diff+'</td>';
    out+='<td style="font-weight:800;color:var(--ac)">'+row.points+'</td>';
    out+='</tr>';
  });
  out+='</tbody></table></div>';
  out+='<div style="display:flex;gap:12px;font-size:10px;color:var(--mu);margin-top:8px"><span><span style="display:inline-block;width:10px;height:10px;background:rgba(34,197,94,.3);border-radius:2px;margin-right:4px"></span>Echipa curentă</span></div>';
  body.innerHTML=out;
}

function tpRenderStatistici(d){
  var body=document.getElementById('tp-body');
  var s=d.stats||{};
  var out=tpHeaderHtml(d.meta||{});
  if(!s.played){
    out+='<div class="empty"><div class="empty-icon">📊</div><div class="empty-t">Statistici indisponibile</div><div class="empty-s">Niciun meci finalizat în istoricul echipei</div></div>';
    body.innerHTML=out;return;
  }
  out+='<div class="md-section"><div class="md-section-title">Statistici (toate meciurile finalizate)</div>';
  out+='<div class="league-profile">';
  function rowKV(label,val){return '<div class="lp-row"><span class="lp-label">'+label+'</span><span class="lp-val">'+val+'</span></div>';}
  out+=rowKV('🎮 Meciuri jucate',s.played);
  out+=rowKV('⚽ Goluri marcate',s.gf+(s.gfPerGame!=null?' ('+s.gfPerGame+'/meci)':''));
  out+=rowKV('🥅 Goluri primite',s.ga+(s.gaPerGame!=null?' ('+s.gaPerGame+'/meci)':''));
  out+=rowKV('🛡️ Clean sheets',s.cleanSheets);
  out+=rowKV('🚫 Meciuri fără gol marcat',s.failedToScore);
  out+='</div></div>';
  if(s.teamStrength!=null){
    var col=s.teamStrength>=70?'#22c55e':s.teamStrength>=50?'#f59e0b':'#ef4444';
    out+='<div class="md-section"><div class="md-section-title">Putere Echipă</div>';
    out+='<div class="pi-team"><div class="pi-team-name">'+htmlEsc((d.meta&&d.meta.teamName)||'Echipă')+'</div>';
    out+='<div class="pi-str-val" style="color:'+col+'">'+s.teamStrength+'</div>';
    out+='<div class="pi-str-bar"><div class="pi-str-fill" style="width:'+s.teamStrength+'%"></div></div></div>';
    out+='<div style="font-size:10px;color:var(--mu);margin-top:6px">Calculată din rating/goluri/pase/șuturi jucători (sursa score7, citită).</div>';
    out+='</div>';
  }
  body.innerHTML=out;
}

// ══════════════════════════════════════════════════════════════════════════
// CUPA MONDIALĂ 2026 — card featured pe LIVE + hub overlay (accent auriu).
// READ-ONLY: citește /api/worldcup (predicții existente), zero recalcul scoring/NGP.
// ══════════════════════════════════════════════════════════════════════════
var SPORTSBET_AFFILIATE_URL = 'https://sportsbet.io/';  // placeholder — completează tu
var WC_START = new Date('2026-06-11T00:00:00');
var WC_END   = new Date('2026-07-19T23:59:59');
var _wc={data:null,tabIdx:0,day:null};

// Drapel echipă — GARANTAT pentru orice națională.
// Strategie: nume țară → ISO2 (mapă completă). Din ISO2 derivăm:
//   • imaginea reală: media.api-sports.io/flags/{iso2}.svg
//   • emoji (regional indicators) ca fallback la onerror → ZERO drapele goale.
// Dacă numele nu e în mapă, cădem pe logoUrl (crest din teams) apoi pe 🏳️.
var WC_ISO2 = {
  // CONMEBOL
  'argentina':'ar','brazil':'br','uruguay':'uy','colombia':'co','ecuador':'ec',
  'paraguay':'py','peru':'pe','chile':'cl','bolivia':'bo','venezuela':'ve',
  // CONCACAF
  'usa':'us','united states':'us','canada':'ca','mexico':'mx','costa rica':'cr',
  'panama':'pa','jamaica':'jm','honduras':'hn','el salvador':'sv','guatemala':'gt',
  'haiti':'ht','trinidad and tobago':'tt','curacao':'cw',
  // UEFA
  'france':'fr','spain':'es','england':'gb-eng','germany':'de','portugal':'pt',
  'netherlands':'nl','italy':'it','belgium':'be','croatia':'hr','denmark':'dk',
  'switzerland':'ch','poland':'pl','serbia':'rs','wales':'gb-wls','scotland':'gb-sct',
  'austria':'at','ukraine':'ua','sweden':'se','turkey':'tr','norway':'no',
  'czech republic':'cz','czechia':'cz','hungary':'hu','romania':'ro','greece':'gr',
  'slovakia':'sk','slovenia':'si','republic of ireland':'ie','ireland':'ie','albania':'al',
  // CAF
  'morocco':'ma','senegal':'sn','tunisia':'tn','algeria':'dz','egypt':'eg',
  'nigeria':'ng','ghana':'gh','cameroon':'cm','ivory coast':'ci',"cote d'ivoire":'ci',
  'mali':'ml','south africa':'za','cape verde':'cv','dr congo':'cd','burkina faso':'bf',
  // AFC
  'japan':'jp','south korea':'kr','korea republic':'kr','iran':'ir','saudi arabia':'sa',
  'australia':'au','qatar':'qa','iraq':'iq','uae':'ae','united arab emirates':'ae',
  'uzbekistan':'uz','jordan':'jo','china':'cn','china pr':'cn','bahrain':'bh','oman':'om',
  // OFC
  'new zealand':'nz','new caledonia':'nc','fiji':'fj','solomon islands':'sb',
};
function _iso2ToEmoji(iso2){
  if(!iso2)return null;
  // coduri sub-naționale (Anglia/Scoția/Țara Galilor) — emoji dedicat
  if(iso2==='gb-eng')return '🏴󠁧󠁢󠁥󠁮󠁧󠁿';
  if(iso2==='gb-sct')return '🏴󠁧󠁢󠁳󠁣󠁴󠁿';
  if(iso2==='gb-wls')return '🏴󠁧󠁢󠁷󠁬󠁳󠁿';
  if(iso2.length!==2)return null;
  var cc=iso2.toUpperCase();
  return String.fromCodePoint(0x1F1E6+(cc.charCodeAt(0)-65), 0x1F1E6+(cc.charCodeAt(1)-65));
}
function wcCountryIso(name){ return WC_ISO2[String(name||'').trim().toLowerCase()] || null; }

function wcFlag(logoUrl, teamName, sz){
  sz=sz||18;
  var iso=wcCountryIso(teamName);
  var emoji=_iso2ToEmoji(iso);
  var emojiSpan='<span style="vertical-align:middle">'+(emoji||'🏳️')+'</span>';
  // 1) avem ISO2 → drapel SVG real garantat, cu fallback la emoji ISO2 (nu gol)
  if(iso){
    var url='https://media.api-sports.io/flags/'+iso+'.svg';
    return '<img src="'+url+'" width="'+sz+'" height="'+Math.round(sz*0.72)+'" style="border-radius:2px;object-fit:cover;vertical-align:middle;flex-shrink:0" '+
      'onerror="this.outerHTML=decodeURIComponent(\''+encodeURIComponent(emojiSpan)+'\')">';
  }
  // 2) fără ISO2 dar avem crest din teams → folosește-l, fallback emoji/glob
  if(logoUrl){
    return '<img src="'+logoUrl+'" width="'+sz+'" height="'+sz+'" style="border-radius:3px;object-fit:contain;vertical-align:middle;flex-shrink:0" '+
      'onerror="this.outerHTML=decodeURIComponent(\''+encodeURIComponent(emojiSpan)+'\')">';
  }
  // 3) nimic → emoji (sau glob neutru)
  return emojiSpan;
}
function wcFlagEmoji(name){
  var emoji=_iso2ToEmoji(wcCountryIso(name));
  return '<span style="vertical-align:middle">'+(emoji||'🏳️')+'</span>';
}

// Card featured pe feed-ul LIVE — 3 stări după dată. Apelat din renderMatches/loadLive.
function wcRenderFeatured(){
  var el=document.getElementById('wc-featured');
  if(!el)return;
  var now=new Date();
  if(now>WC_END){ el.style.display='none'; el.innerHTML=''; return; }  // după turneu: ascuns
  var pill='';
  if(now<WC_START){
    var days=Math.max(0,Math.ceil((WC_START-now)/86400000));
    pill='<span class="wc-pill gold">⏳ ÎNCEPE ÎN '+days+' ZILE</span>';
  } else {
    // 11 iun–19 iul: pill roșu cu N live (din ST.ms, league id 1)
    var n=0;
    try{ n=(ST.ms||[]).filter(function(m){return m.league&&Number(m.league.id)===1;}).length; }catch(e){}
    pill='<span class="wc-pill livep"><span class="dotpulse"></span>'+n+' LIVE</span>';
  }
  el.style.display='block';
  el.innerHTML='<div class="wc-card" onclick="wcOpen()">'+
    '<div class="wc-card-top">'+
      '<span class="wc-trophy">🏆</span>'+
      '<div style="min-width:0"><div class="wc-card-title">CUPA MONDIALĂ 2026</div>'+
      '<div class="wc-card-sub">SUA · Canada · Mexic · 48 echipe</div></div>'+
      pill+
    '</div></div>';
}

function wcOpen(){
  _wc.tabIdx=0;_wc.data=null;
  var ov=document.getElementById('wc-overlay');ov.classList.add('open');
  document.getElementById('wc-body').innerHTML='<div class="spinner"><div class="spin"></div></div>';
  document.querySelectorAll('#wc-overlay .md-tab').forEach(function(t,i){t.classList.toggle('active',i===0);});
  wcFetch();
}
function wcClose(){ document.getElementById('wc-overlay').classList.remove('open'); }
function wcTab(idx){
  _wc.tabIdx=idx;
  document.querySelectorAll('#wc-overlay .md-tab').forEach(function(t,i){t.classList.toggle('active',i===idx);});
  wcRender();
}
// Swipe-down close (același pattern ca md/tp)
(function(){
  var startY=0;var ov=document.getElementById('wc-overlay');if(!ov)return;
  ov.addEventListener('touchstart',function(e){startY=e.touches[0].clientY;},{passive:true});
  ov.addEventListener('touchend',function(e){
    var dy=e.changedTouches[0].clientY-startY;
    if(dy>80&&document.getElementById('wc-body').scrollTop<=0)wcClose();
  },{passive:true});
})();

async function wcFetch(){
  try{
    var r=await fetch('/api/worldcup');var d=await r.json();
    if(d.error)throw new Error(d.error);
    _wc.data=d;wcRender();
  }catch(e){
    document.getElementById('wc-body').innerHTML='<div class="empty"><div class="empty-icon">⚠️</div><div class="empty-t">Eroare</div><div class="empty-s">'+htmlEsc(e.message)+'</div></div>';
  }
}
function wcRender(){
  var d=_wc.data;if(!d)return;
  try{
    if(_wc.tabIdx===0)wcRenderPont(d);
    else if(_wc.tabIdx===1)wcRenderMatches(d);
    else if(_wc.tabIdx===2)wcRenderGroups(d);
    else if(_wc.tabIdx===3)wcRenderBracket(d);
  }catch(e){
    document.getElementById('wc-body').innerHTML='<div class="empty"><div class="empty-icon">⚠️</div><div class="empty-t">Eroare</div><div class="empty-s">'+htmlEsc(e.message)+'</div></div>';
  }
}

function wcRenderPont(d){
  var body=document.getElementById('wc-body');
  var p=d.pont;
  if(!p){ body.innerHTML='<div class="empty"><div class="empty-icon">🎯</div><div class="empty-t">Niciun pont azi</div><div class="empty-s">Nu există predicții WC pentru meciurile de azi</div></div>'; return; }
  var cota=(p.cota!=null)?(' · cotă <b>'+Number(p.cota).toFixed(2)+'</b>'):'';
  var mk=p.market?(p.market+(p.marketProb!=null?(' ('+p.marketProb+'%)'):'')):'—';
  var out='<div class="wc-pont">';
  out+='<div class="wc-pont-match">'+htmlEsc(p.home||'?')+' vs '+htmlEsc(p.away||'?')+'</div>';
  out+='<div class="wc-pont-conf">'+(p.confidence!=null?Math.round(p.confidence)+'%':'—')+'</div>';
  out+='<div class="wc-pont-market">Piață recomandată: <b style="color:var(--gold)">'+htmlEsc(mk)+'</b>'+cota+'</div>';
  out+='<a class="wc-bet-btn" href="'+SPORTSBET_AFFILIATE_URL+'" target="_blank" rel="noopener">PARIAZĂ PE SPORTSBET.IO →</a>';
  out+='</div>';
  body.innerHTML=out;
}

// Navigare pe zi (FlashScore-style) — schimbă ziua și re-randează.
function wcSetDay(day){ _wc.day=day; wcRenderMatches(_wc.data); }

function wcRenderMatches(d){
  var body=document.getElementById('wc-body');
  var ms=d.matches||[];
  var days=d.days||[];
  if(!ms.length){ body.innerHTML='<div class="empty"><div class="empty-icon">⚽</div><div class="empty-t">Program indisponibil</div><div class="empty-s">Programul WC nu e încă în baza de date (se colectează din collect-daily)</div></div>'; return; }
  var ec=function(v){return v==null?'#888':v>=70?'#22c55e':v>=50?'#f59e0b':'#ef4444';};
  // Ziua default: ziua selectată → azi (dacă are meciuri) → prima zi din program.
  var todayStr=new Date().toISOString().slice(0,10);
  if(!_wc.day || days.indexOf(_wc.day)<0){
    _wc.day = (days.indexOf(todayStr)>=0) ? todayStr : days[0];
  }
  // Bara de zile (calendar)
  var out='<div id="wc-datebar" style="display:flex;gap:4px;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;padding:2px 0 10px">';
  days.forEach(function(day){
    var dt=new Date(day+'T00:00:00');
    var lbl=dt.toLocaleDateString('ro-RO',{day:'2-digit',month:'short'});
    var active=(day===_wc.day);
    out+='<div onclick="wcSetDay(\''+day+'\')" style="flex:none;padding:7px 11px;border-radius:8px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;'+
      (active?'background:linear-gradient(135deg,var(--gold),var(--gold2));color:#1a1500':'background:var(--sur2);color:var(--mu2)')+'">'+lbl+'</div>';
  });
  out+='</div>';
  // Meciurile zilei selectate — ACELAȘI stil de card ca tab-ul PRE-MECI (clasele pm-*).
  var dayMs=ms.filter(function(m){return m.day===_wc.day;});
  if(!dayMs.length){
    out+='<div class="md-section"><div class="bf-label" style="color:var(--mu)">Niciun meci în această zi</div></div>';
    body.innerHTML=out;return;
  }
  dayMs.forEach(function(m){
    var fid=m.fixtureId, hid=m.homeId||0, aid=m.awayId||0;
    var hn=m.home||'—', an=m.away||'—';
    // Eticheta competiție = numele grupei (ex "Group A"); crest = steag SVG (wcFlag).
    var grp=m.round||'Cupa Mondială';
    var kickoff=m.matchDate?new Date(m.matchDate).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'—';
    var liveTxt=m.live?'<span style="color:var(--red);font-weight:700">● LIVE'+(m.ng!=null?(' '+m.ng+'%'):'')+'</span>':('🕐 '+kickoff);
    out+='<div class="pm-card" onclick="wcClose();mdOpen('+fid+','+hid+','+aid+',this)" style="cursor:pointer;position:relative">';
    out+='<div class="pm-header">';
    out+='<div class="pm-kickoff">'+htmlEsc(grp)+' · '+liveTxt+'</div>';
    out+='<div class="pm-teams">'+wcFlag(m.homeLogo,hn,32)+'<span>'+htmlEsc(hn)+'</span><span style="color:var(--mu);font-size:13px;font-weight:600">vs</span>'+wcFlag(m.awayLogo,an,32)+'<span>'+htmlEsc(an)+'</span></div>';
    out+='</div>';
    var hasPred=(m.over15!=null)||(m.gg!=null)||(m.confidence!=null);
    if(hasPred){
      out+='<div class="pm-body">';
      if(m.over15!=null)out+='<div class="pm-meter-row"><div class="pm-meter-label">Over 1.5</div><div class="pm-meter-bar"><div class="pm-meter-fill" style="width:'+Math.min(m.over15||0,100)+'%;background:'+ec(m.over15)+'"></div></div><div class="pm-meter-pct" style="color:'+ec(m.over15)+'">'+Math.round(m.over15||0)+'%</div></div>';
      if(m.gg!=null)out+='<div class="pm-meter-row"><div class="pm-meter-label">GG</div><div class="pm-meter-bar"><div class="pm-meter-fill" style="width:'+Math.min(m.gg||0,100)+'%;background:'+ec(m.gg)+'"></div></div><div class="pm-meter-pct" style="color:'+ec(m.gg)+'">'+Math.round(m.gg||0)+'%</div></div>';
      if(m.over25!=null){
        out+='<div class="pm-stats"><span class="pm-stat">Over 2.5 <span style="color:'+ec(m.over25)+'">'+Math.round(m.over25)+'%</span></span></div>';
      }
      if(m.confidence!=null){
        var cs=Math.round(m.confidence);
        var confColor=cs>=70?'#22c55e':cs>=55?'#f59e0b':'#ef4444';
        out+='<div class="conf-bar-wrap">'+
          '<div class="conf-bar-bg"><div class="conf-bar-fill" style="width:'+cs+'%;background:'+confColor+'"></div></div>'+
          '<div class="conf-score-row">'+
            '<span class="conf-pct" style="color:'+confColor+'">'+cs+'%</span>'+
            '<span class="conf-label">ÎNCREDERE</span>'+
          '</div></div>';
      }
      out+='</div>';
    }else{
      out+='<div class="pm-body" style="display:flex;align-items:center;justify-content:space-between">';
      out+='<span style="font-size:11px;color:var(--mu)">Predicția apare mai aproape de start</span>';
      out+='</div>';
    }
    out+='</div>';
  });
  body.innerHTML=out;
}

function wcRenderGroups(d){
  var body=document.getElementById('wc-body');
  var groups=d.groups||[];
  if(!groups.length){ body.innerHTML='<div class="empty"><div class="empty-icon">📊</div><div class="empty-t">Grupe indisponibile</div><div class="empty-s">Clasamentul pe grupe nu e încă în baza de date</div></div>'; return; }
  var out='';
  groups.forEach(function(g){
    out+='<div class="md-section"><div class="md-section-title" style="color:var(--gold)">'+htmlEsc(g.name)+'</div>';
    out+='<div style="overflow-x:auto"><table class="standings-tbl"><thead><tr><th>#</th><th class="tn">Echipă</th><th>J</th><th>V</th><th>E</th><th>Î</th><th>GD</th><th style="color:var(--ac)">Pct</th></tr></thead><tbody>';
    g.rows.forEach(function(r){
      var qual=(r.rank<=2)?'srow-home':'';
      var logo=wcFlag(r.teamLogo,r.teamName,16)+' ';
      out+='<tr class="'+qual+'">';
      out+='<td style="color:var(--mu)">'+r.rank+'</td>';
      out+='<td class="tn" style="'+(r.rank<=2?'font-weight:800;':'')+'">'+logo+htmlEsc(r.teamName||'')+'</td>';
      out+='<td>'+r.played+'</td><td>'+r.win+'</td><td>'+r.draw+'</td><td>'+r.lose+'</td>';
      out+='<td style="color:'+(Number(r.goalsDiff)>=0?'#22c55e':'#ef4444')+'">'+(Number(r.goalsDiff)>0?'+':'')+r.goalsDiff+'</td>';
      out+='<td style="font-weight:800;color:var(--ac)">'+r.points+'</td></tr>';
    });
    out+='</tbody></table></div>';
    out+='<div style="font-size:10px;color:var(--mu);margin-top:6px"><span style="display:inline-block;width:10px;height:10px;background:rgba(34,197,94,.3);border-radius:2px;margin-right:4px"></span>Primele 2 — calificare</div>';
    out+='</div>';
  });
  body.innerHTML=out;
}

function wcRenderBracket(d){
  var body=document.getElementById('wc-body');
  var br=d.bracket||[];
  if(!br.length){ body.innerHTML='<div class="empty"><div class="empty-icon">🏆</div><div class="empty-t">Bracket indisponibil</div><div class="empty-s">Fazele eliminatorii nu sunt încă programate (TBD)</div></div>'; return; }
  var out='';
  br.forEach(function(rnd){
    out+='<div class="wc-br-round"><div class="md-section-title" style="color:var(--gold)">'+htmlEsc(rnd.round)+'</div>';
    rnd.matches.forEach(function(m){
      var sc=(m.homeGoals!=null&&m.awayGoals!=null)?(m.homeGoals+'-'+m.awayGoals):'–';
      var hf=m.tbd?'':wcFlag(m.homeLogo,m.home,16)+' ';
      var af=m.tbd?'':' '+wcFlag(m.awayLogo,m.away,16);
      out+='<div class="wc-br-row'+(m.tbd?' tbd':'')+'">';
      out+='<span class="wc-br-team">'+hf+htmlEsc(m.home||'TBD')+'</span>';
      out+='<span class="wc-br-score">'+sc+'</span>';
      out+='<span class="wc-br-team" style="text-align:right">'+htmlEsc(m.away||'TBD')+af+'</span>';
      out+='</div>';
    });
    out+='</div>';
  });
  body.innerHTML=out;
}

