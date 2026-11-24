// Camera — tablou de control. Aloha executa DOAR intrarile puse aici; moduri: Paper / Alerta (Live nu exista). Date prin /api/camera (x-api-key).
(function(){
var S=null,E=[],ST={},T=null;
function lsGet(k){try{return localStorage.getItem(k)||"";}catch(e){return "";}}
function lsSet(k,v){try{localStorage.setItem(k,v);}catch(e){}}
function key(){var k=lsGet("aloha_cal_key")||lsGet("aloha_admin_key");if(k)return k;try{k=(window.prompt("Cheie de acces (o singură dată pe acest dispozitiv):")||"").trim();}catch(e){}if(k)lsSet("aloha_cal_key",k);return k;}
function api(method,body){var k=key();if(!k)return Promise.resolve({cancel:true});var o={method:method,headers:{"x-api-key":k}};if(body){o.headers["Content-Type"]="application/json";o.body=JSON.stringify(body);}
  return fetch("/api/camera",o).then(function(r){if(r.status===401){lsSet("aloha_cal_key","");return{unauth:true};}return r.json();});}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}
function load(){return api("GET").then(function(j){if(j&&j.ok){S=j.settings;E=j.entries||[];ST=j.stats||{};}render(j);});}
function save(patch){for(var k in patch)S[k]=patch[k];render();clearTimeout(T);T=setTimeout(function(){api("POST",{action:"settings",settings:patch});},400);}
var SL=[["stake","Miza per intrare","USDC",1,100,1],["pmin","Preț intrare: minim","c",70,98,1],["pmax","Preț intrare: maxim","c",70,98,1],["dailyCap","Plafon zilnic total","USDC",10,500,10],["matchCap","Plafon per meci","USDC",1,100,1],["slip","Slippage maxim","c",0,5,1],["liq","Lichiditate minimă","USDC",0,500,10],["rate","Rata istorică minimă","%",70,99,1],["minute","Nu intra după minutul","'",0,90,5],["losses","Oprire după pierderi consecutive","",1,10,1]];
var C={bg:"#171d25",bd:"#263040",mu:"#9aa7b5",ac:"#2dd4bf"};
function chip(st){var m={waiting:["#1f2a3a","#9ec5ff","Așteaptă"],triggered:["#10302b","#2dd4bf","Declanșat"],settled:["#10302b","#2dd4bf","Decontat"],expired:["#2a2530","#b9a9c9","Expirat"],cancelled:["#2a2530","#b9a9c9","Anulat"]}[st]||["#2a2530","#b9a9c9",st];return '<span style="padding:3px 9px;border-radius:999px;font-size:11px;font-weight:700;background:'+m[0]+';color:'+m[1]+'">'+m[2]+'</span>';}
function btn(on,label,fn){return '<button onclick="'+fn+'" style="min-height:44px;padding:8px 14px;border-radius:10px;font-weight:600;font-size:13px;cursor:pointer;border:1px solid '+(on?C.ac:C.bd)+';background:'+(on?C.ac:"transparent")+';color:'+(on?"#06201c":"#e6edf3")+'">'+label+'</button>';}
function render(j){
  var el=document.getElementById("cam-root");if(!el)return;
  if(j&&j.unauth){el.innerHTML='<div style="padding:20px;color:#fecaca">Cheie greșită. Redeschide tabul și introdu cheia din nou.</div>';return;}
  if(!S){el.innerHTML='<div style="padding:20px;color:'+C.mu+'">Se încarcă…</div>';return;}
  var h='<div style="padding:14px;display:flex;flex-direction:column;gap:14px">';
  h+='<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between"><div><div style="font-size:20px;font-weight:700">Camera</div><div style="font-size:12px;color:'+C.mu+'">Aloha execută doar ce pui tu aici. Live: oprit (geoblock).</div></div><button onclick="camStop()" style="min-height:44px;padding:8px 16px;border-radius:10px;border:0;font-weight:700;cursor:pointer;background:'+(S.stopped?C.ac:"#ef4444")+';color:'+(S.stopped?"#06201c":"#fff")+'">'+(S.stopped?"Repornește":"STOP TOT")+'</button></div>';
  if(S.stopped)h+='<div style="padding:10px 12px;border-radius:10px;background:#3a1517;border:1px solid #7f2a2f;color:#fecaca;font-size:13px;font-weight:600">OPRIT. Nicio intrare nu se declanșează.</div>';
  h+='<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">'+btn(S.mode==="paper","Paper","camMode('paper')")+btn(S.mode==="alert","Alertă Telegram","camMode('alert')")+'<span style="font-size:12px;color:'+C.mu+'">'+(S.mode==="paper"?"Notează ce ar fi cumpărat. Fără bani reali.":"Te anunță pe Telegram. Decizia e a ta.")+'</span></div>';
  var n=function(v){return Number(v||0).toFixed(2);};
  var rate=ST.settled>0?Math.round(100*ST.wins/ST.settled):null;
  h+='<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px">'
   +'<div style="background:'+C.bg+';border:1px solid '+C.bd+';border-radius:12px;padding:12px"><div style="font-size:11px;color:'+C.mu+'">Cheltuit azi</div><div style="font-size:20px;font-weight:700">'+n(ST.spent_today)+' / '+S.dailyCap+'</div></div>'
   +'<div style="background:'+C.bg+';border:1px solid '+C.bd+';border-radius:12px;padding:12px"><div style="font-size:11px;color:'+C.mu+'">P/L azi (paper)</div><div style="font-size:20px;font-weight:700;color:'+(Number(ST.pnl_today)>=0?C.ac:"#f87171")+'">'+n(ST.pnl_today)+'</div></div>'
   +'<div style="background:'+C.bg+';border:1px solid '+C.bd+';border-radius:12px;padding:12px"><div style="font-size:11px;color:'+C.mu+'">Săpt. / Total</div><div style="font-size:16px;font-weight:700">'+n(ST.pnl_week)+' / '+n(ST.pnl_total)+'</div></div>'
   +'<div style="background:'+C.bg+';border:1px solid '+C.bd+';border-radius:12px;padding:12px"><div style="font-size:11px;color:'+C.mu+'">Rata reală vs. preț mediu</div><div style="font-size:16px;font-weight:700">'+(rate==null?"—":rate+"% vs "+(ST.avg_price?Math.round(ST.avg_price*1000)/10+"c":"—"))+'</div></div></div>';
  h+='<div style="background:'+C.bg+';border:1px solid '+C.bd+';border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:12px"><div style="font-weight:600">Setări globale</div>';
  SL.forEach(function(s){h+='<div><div style="display:flex;justify-content:space-between;font-size:13px"><label for="cam-'+s[0]+'">'+s[1]+'</label><b style="color:'+C.ac+'">'+S[s[0]]+s[2]+'</b></div><input id="cam-'+s[0]+'" type="range" min="'+s[3]+'" max="'+s[4]+'" step="'+s[5]+'" value="'+S[s[0]]+'" style="width:100%;accent-color:'+C.ac+'" oninput="camSet(\''+s[0]+'\',this.value)"></div>';});
  h+='</div>';
  var picks=(window._dpPicks||[]).filter(function(p){return window._pmLinks&&window._pmLinks[p.fixture_id];});
  var inCam={};E.forEach(function(e){if(e.status==="waiting"||e.status==="triggered")inCam[e.fixture_id]=1;});
  h+='<div style="background:'+C.bg+';border:1px solid '+C.bd+';border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px"><div style="font-weight:600">Adaugă din Ponturi (doar cu Polymarket)</div>';
  if(!picks.length)h+='<div style="font-size:12px;color:'+C.mu+'">Niciun pont cu Polymarket încărcat. Deschide întâi Ponturile.</div>';
  picks.slice(0,30).forEach(function(p){h+='<div style="display:flex;gap:8px;align-items:center;justify-content:space-between;font-size:13px"><span>'+esc(p.home)+' – '+esc(p.away)+'</span>'+(inCam[p.fixture_id]?'<span style="color:'+C.mu+'">în Cameră</span>':'<button onclick="camAdd('+Number(p.fixture_id)+')" style="min-height:44px;padding:6px 12px;border-radius:8px;border:0;background:'+C.ac+';color:#06201c;font-weight:700;cursor:pointer">+ Cameră</button>')+'</div>';});
  h+='</div>';
  h+='<div style="background:'+C.bg+';border:1px solid '+C.bd+';border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:10px"><div style="font-weight:600">Intrările tale</div>';
  if(!E.length)h+='<div style="font-size:12px;color:'+C.mu+'">Nicio intrare încă.</div>';
  E.forEach(function(e){h+='<div style="border-top:1px solid '+C.bd+';padding-top:8px;font-size:13px"><div style="display:flex;justify-content:space-between;gap:8px"><b>'+esc(e.match_label)+'</b>'+chip(e.status)+'</div><div style="color:'+C.mu+';font-size:12px">Over 0.5 · '+e.stake+' USDC · '+e.pmin+'–'+e.pmax+'c · acum '+(e.last_price!=null?Math.round(e.last_price*100)+"c":"—")+(e.trigger_price?" · intrat la "+Math.round(e.trigger_price*100)+"c":"")+(e.result?" · "+(e.result==="win"?"câștig":"pierdere")+" "+e.pnl:"")+(e.note?" · "+esc(e.note):"")+'</div>'+(e.status==="waiting"?'<button onclick="camCancel('+e.id+')" style="margin-top:6px;min-height:44px;padding:6px 12px;border-radius:8px;border:1px solid '+C.bd+';background:transparent;color:#e6edf3;cursor:pointer">Anulează</button>':'')+'</div>';});
  h+='</div></div>';el.innerHTML=h;
}
window.camSet=function(k,v){var p={};p[k]=Number(v);if(k==="pmin"&&p[k]>S.pmax)p.pmax=p[k];if(k==="pmax"&&p[k]<S.pmin)p.pmin=p[k];save(p);};
window.camMode=function(m){save({mode:m});};
window.camStop=function(){save({stopped:!S.stopped});};
window.camAdd=function(fid){var p=(window._dpPicks||[]).filter(function(x){return x.fixture_id==fid;})[0];api("POST",{action:"add",fixture_id:fid,match_label:p?p.home+" – "+p.away:null}).then(load);};
window.camCancel=function(id){api("POST",{action:"cancel",id:id}).then(load);};
window.camInit=function(){render();load();};
})();
