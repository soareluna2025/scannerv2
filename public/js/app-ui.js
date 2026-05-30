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
      _autoIt=setInterval(function(){loadLive();},CFG.RI);
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
  var _b=matchTimeBadge(_sh,mn);
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
  o+='<div class="ngp-pct" style="color:'+c+'">'+ng+'%</div></div>';
  o+='<div class="ngp-bar"><div class="ngp-fill" style="width:'+ng+'%;background:'+c+'"></div></div>';
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
    if(m.fixture.referee&&m.fixture.referee!=='null'){
      u+='&ref='+encodeURIComponent(m.fixture.referee.split(',')[0].trim());
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


// ── MATCH DETAIL ──────────────────────────────────────────────
var _md={data:null,tabIdx:0,fixtureId:0,homeId:0,awayId:0};
var _mdRefreshTimer=null;

function mdOpen(fid,hid,aid,srcEl){
  if(!fid||!hid||!aid)return;
  // stop click from bubbling into any inner button (e.g. analyze)
  if(window.event&&window.event.target&&window.event.target.tagName==='BUTTON'&&window.event.target!==srcEl)return;
  if(_mdRefreshTimer){clearInterval(_mdRefreshTimer);_mdRefreshTimer=null;}
  _md.fixtureId=fid;_md.homeId=hid;_md.awayId=aid;_md.tabIdx=0;_md.data=null;
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
    // On silent refresh always fetch fresh enrich; on first load skip if cached
    var hasCached=(!silent)&&((_pmEnrich&&_pmEnrich[fid]&&_pmEnrich[fid].confidenceScore!=null)||
                  (_genLiveEnrich&&_genLiveEnrich[fid]&&_genLiveEnrich[fid].confidenceScore!=null));
    if(!hasCached&&_md.homeId&&_md.awayId){
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

function mdRender(){
  if(!_md.data){return;}
  var d=_md.data;
  if(_md.tabIdx===0)mdRenderSumar(d);
  else if(_md.tabIdx===1)mdRenderFormatii(d);
  else if(_md.tabIdx===2)mdRenderJucatori(d);
  else if(_md.tabIdx===3)mdRenderForma(d);
  else if(_md.tabIdx===4)mdRenderClasament(d);
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

  out+='<div class="md-score-block">';
  out+='<div class="md-teams-row">';
  out+='<div class="md-team-name">'+tLogo(fix&&fix.teams&&fix.teams.home,48)+'<span>'+hn+'</span></div>';
  out+='<div class="md-score">'+hg+' - '+ag+'</div>';
  out+='<div class="md-team-name">'+tLogo(fix&&fix.teams&&fix.teams.away,48)+'<span>'+an+'</span></div>';
  out+='</div></div>';
  if(isLive){
    var _mb=matchTimeBadge(sh,mn);
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
    out+='<div class="md-section"><div class="md-section-title">Evenimente</div>';
    evts.slice(0,25).forEach(function(e){
      var etype=(e.type||'').toLowerCase();
      var icon=etype==='goal'?(e.detail==='Own Goal'?'⚽🔴':e.detail==='Penalty'?'⚽⚪':'⚽')
              :etype==='card'?(e.detail==='Yellow Card'?'🟨':'🟥')
              :(etype==='subst'||etype==='substitution')?'↔':'•';
      out+='<div class="md-event">';
      out+='<div class="md-event-min">'+(e.time&&e.time.elapsed||'?')+"'</div>";
      out+='<div class="md-event-icon">'+icon+'</div>';
      out+='<div style="flex:1">';
      if(etype==='subst'||etype==='substitution'){
        var playerIn=e.player&&e.player.name||'';
        var playerOut=e.assist&&e.assist.name||'';
        out+='<div class="md-event-detail">'+playerIn+(playerOut?' <span style="color:var(--red);font-size:10px">↓'+playerOut+'</span>':'')+'</div>';
      }else{
        out+='<div class="md-event-detail">'+(e.player&&e.player.name||'')+(e.assist&&e.assist.name?' <span style="color:var(--mu);font-size:10px">('+e.assist.name+')</span>':'')+'</div>';
      }
      out+='<div class="md-event-team">'+(e.team&&e.team.name||'')+'</div>';
      out+='</div></div>';
    });
    out+='</div>';
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
    var minCotaNgp=ngCal>0?(100/ngCal).toFixed(2):'—';
    out+='<div class="md-section"><div class="md-section-title">Probabilitate Gol</div>';
    // Two columns: anytime in match vs next 15 min
    out+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">';
    // Column 1: anytime in match — CALIBRAT din backtest 26297 predictii
    out+='<div style="padding:12px;background:rgba(0,212,168,.06);border-radius:8px;text-align:center">';
    out+='<div style="font-size:9px;color:var(--mu);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px">Gol oric&acirc;nd &icirc;n meci</div>';
    out+='<div style="font-size:24px;font-weight:800;color:'+ngpClr+'">'+ngCal+'%</div>';
    out+='<div style="font-size:9px;color:var(--mu);margin-top:3px">calibrat &middot; cot&#259; min '+minCotaNgp+'</div>';
    if(ngCal!==ngRaw)out+='<div style="font-size:9px;color:var(--mu);margin-top:2px;opacity:.7">raw: '+ngRaw+'%</div>';
    if(ngpData.forte)out+='<div class="badge-forte" style="margin-top:6px;display:inline-block">⚡ FORTE</div>';
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
  if(en.over15Prob!=null){
    var _lambdaStale=Number(en.lambdaTotal||0)<0.5;
    // Live + meciul a progresat = Poisson pre-meci nu mai e relevant
    var _liveProgressed = isLive && (mn > 15 || (hg + ag) > 0);
    out+='<div class="md-section"><div class="md-section-title">Predicții Poisson <span style="font-size:10px;color:var(--mu);font-weight:400">(pre-meci)</span></div>';
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
      var c35=Math.round((+en.cardsOver35||0)*100);
      var c45=Math.round((+en.cardsOver45||0)*100);
      out+='<div class="md-prob-row">';
      out+='<div class="md-prob"><div class="md-prob-val" style="color:'+ec(c35)+'">'+c35+'%</div><div class="md-prob-lbl">🟨 Cărți Over 3.5</div></div>';
      out+='<div class="md-prob"><div class="md-prob-val" style="color:'+ec(c45)+'">'+c45+'%</div><div class="md-prob-lbl">🟨 Cărți Over 4.5</div></div>';
      out+='</div>';
    }
    if(hasCorn){
      var k85=Math.round((+en.cornersOver85||0)*100);
      var k95=Math.round((+en.cornersOver95||0)*100);
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
    document.getElementById('md-body').innerHTML='<div class="empty"><div class="empty-icon">📋</div><div class="empty-t">Formații indisponibile</div>'+msg+'</div>';
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

