// AlohaPoly — START/STOP. Aloha urmareste meciurile tale in ordine cronologica; moduri: Paper / Alerta (Live nu exista). Date prin /api/camera (x-api-key).
(function(){
var S=null,E=[],ST={},BK=[],G=null,SR=[];
var MK=[["over05","Over 0.5"],["over15","Over 1.5"],["home","Gazde marchează"],["away","Oaspeți marchează"]];
var C={bg:"#171d25",bd:"#263040",mu:"#9aa7b5",ac:"#2dd4bf"};
function lsGet(k){try{return localStorage.getItem(k)||"";}catch(e){return "";}}
function lsSet(k,v){try{localStorage.setItem(k,v);}catch(e){}}
function key(){var k=lsGet("aloha_cal_key")||lsGet("aloha_admin_key");if(k)return k;try{k=(window.prompt("Cheie de acces (o singură dată pe acest dispozitiv):")||"").trim();}catch(e){}if(k)lsSet("aloha_cal_key",k);return k;}
function api(method,body,qs){var k=key();if(!k)return Promise.resolve({cancel:true});var o={method:method,headers:{"x-api-key":k}};if(body){o.headers["Content-Type"]="application/json";o.body=JSON.stringify(body);}
  return fetch("/api/camera"+(qs||""),o).then(function(r){if(r.status===401){lsSet("aloha_cal_key","");return{unauth:true};}return r.json();});}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}
function val(id){var e=document.getElementById(id);return e?e.value:"";}
function load(){return api("GET").then(function(j){if(j&&j.ok){S=j.settings;E=j.entries||[];ST=j.stats||{};BK=j.buckets||[];G=j.geo||null;}render(j);});}
function saveS(p){for(var k in p)S[k]=p[k];return api("POST",{action:"settings",settings:p}).then(load);}
function sel(id,cur){return '<select id="'+id+'" style="min-height:44px;padding:6px;border-radius:8px;border:1px solid '+C.bd+';background:#0f1419;color:#e6edf3">'+MK.map(function(m){return '<option value="'+m[0]+'"'+(m[0]===cur?" selected":"")+'>'+m[1]+'</option>';}).join("")+'</select>';}
function num(id,v,ph,w){return '<input id="'+id+'" type="number" inputmode="decimal" value="'+(v==null?"":v)+'" placeholder="'+ph+'" style="width:'+(w||70)+'px;min-height:44px;padding:6px;border-radius:8px;border:1px solid '+C.bd+';background:#0f1419;color:#e6edf3">';}
function lab(t){return '<span style="font-size:11px;color:'+C.mu+'">'+t+'</span>';}
function box(inner){return '<div style="background:'+C.bg+';border:1px solid '+C.bd+';border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:10px">'+inner+'</div>';}
function chip(st){var m={waiting:["#1f2a3a","#9ec5ff","Așteaptă"],triggered:["#10302b","#2dd4bf","Declanșat"],settled:["#10302b","#2dd4bf","Decontat"],expired:["#2a2530","#b9a9c9","Expirat"],cancelled:["#2a2530","#b9a9c9","Anulat"]}[st]||["#2a2530","#b9a9c9",st];return '<span style="padding:3px 9px;border-radius:999px;font-size:11px;font-weight:700;background:'+m[0]+';color:'+m[1]+'">'+m[2]+'</span>';}
function tb(on,label,fn){return '<button onclick="'+fn+'" style="min-height:44px;padding:8px 14px;border-radius:10px;font-weight:600;font-size:13px;cursor:pointer;border:1px solid '+(on?C.ac:C.bd)+';background:'+(on?C.ac:"transparent")+';color:'+(on?"#06201c":"#e6edf3")+'">'+label+'</button>';}
function n2(v){return Number(v||0).toFixed(2);}
function render(j){
  var el=document.getElementById("cam-root");if(!el)return;
  if(j&&j.unauth){el.innerHTML='<div style="padding:20px;color:#fecaca">Cheie greșită. Redeschide tabul și introdu cheia din nou.</div>';return;}
  if(!S){el.innerHTML='<div style="padding:20px;color:'+C.mu+'">Se încarcă…</div>';return;}
  var run=S.running,h='<div style="padding:14px;display:flex;flex-direction:column;gap:14px">';
  h+='<div><div style="font-size:20px;font-weight:700">AlohaPoly</div><div style="font-size:12px;color:'+C.mu+'">Masa ta: tu pui meciurile, Aloha le pregătește în ordine cronologică. Execuție reală: oprită.</div></div>';
  var gc=!G||!G.ok?["#2a2530","#b9a9c9","Geoblock necunoscut"]:G.blocked?["#2a2112","#fbbf24","Server blocat ("+(G.country||"?")+")"]:["#10302b","#2dd4bf","Server eligibil ("+(G.country||"?")+")"];
  h+='<div style="padding:7px 12px;border-radius:999px;background:'+gc[0]+';color:'+gc[1]+';font-size:12px;font-weight:600;align-self:flex-start">'+gc[2]+' · IP-ul serverului, nu al tău</div>';
  // START / STOP
  h+='<div style="display:flex;gap:12px"><button onclick="camStart()" style="flex:1;min-height:64px;border-radius:14px;border:0;font-size:20px;font-weight:800;cursor:pointer;background:'+(run?"#134e45":C.ac)+';color:'+(run?"#7fe9db":"#06201c")+'">'+(run?"● RULEAZĂ":"START")+'</button><button onclick="camStop()" style="flex:1;min-height:64px;border-radius:14px;border:0;font-size:20px;font-weight:800;cursor:pointer;background:'+(run?"#ef4444":"#4a2326")+';color:'+(run?"#fff":"#c98a8e")+'">STOP</button></div>';
  h+='<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">'+tb(S.mode==="paper","Paper","camMode('paper')")+tb(S.mode==="alert","Alertă Telegram","camMode('alert')")+'<span style="font-size:12px;color:'+C.mu+'">'+(S.mode==="paper"?"Notează ce ar fi cumpărat. Fără bani reali.":"Te anunță pe Telegram. Decizia e a ta.")+'</span></div>';
  // statistici
  var rate=ST.settled>0?Math.round(100*ST.wins/ST.settled):null;
  h+='<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px">'
   +box(lab("P/L azi (paper)")+'<div style="font-size:20px;font-weight:700;color:'+(Number(ST.pnl_today)>=0?C.ac:"#f87171")+'">'+n2(ST.pnl_today)+'</div>')
   +box(lab("Săpt. / Total")+'<div style="font-size:16px;font-weight:700">'+n2(ST.pnl_week)+' / '+n2(ST.pnl_total)+'</div>')
   +box(lab("Bani liberi (cu compus)")+'<div style="font-size:20px;font-weight:700">'+n2(S.bankroll+Number(ST.pnl_total||0)-Number(ST.open_stake||0))+'</div>')
   +box(lab("Rata reală vs. preț mediu")+'<div style="font-size:16px;font-weight:700">'+(rate==null?"—":rate+"% vs "+(ST.avg_price?Math.round(ST.avg_price*1000)/10+"c":"—"))+'</div>')+'</div>';
  // miza
  h+=box('<div style="font-weight:600">Miza</div><div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end"><div style="display:flex;flex-direction:column;gap:2px">'+lab("Miză implicită (USDC)")+num("cam-stake",S.stake,"5",90)+'</div><div style="display:flex;flex-direction:column;gap:2px">'+lab("Sumă de start (USDC)")+num("cam-bank",S.bankroll,"100",90)+'</div><button onclick="camSaveStake()" style="min-height:44px;padding:8px 14px;border-radius:10px;border:0;background:'+C.ac+';color:#06201c;font-weight:700;cursor:pointer">Salvează</button></div>'
   +'<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">'+tb(S.compound,S.compound?"Compus: PORNIT":"Compus: oprit","camCompound()")+'<span style="font-size:12px;color:'+C.mu+'">'+(S.compound?"Fiecare intrare pune toți banii liberi (suma de start + profit).":"Fiecare intrare folosește miza ei manuală.")+'</span></div>');
  // adauga
  h+=box('<div style="font-weight:600">Adaugă meci</div><div style="display:flex;gap:8px"><input id="cam-q" type="search" placeholder="Caută după echipă…" style="flex:1;min-height:44px;padding:6px 10px;border-radius:8px;border:1px solid '+C.bd+';background:#0f1419;color:#e6edf3"><button onclick="camSearch()" style="min-height:44px;padding:8px 14px;border-radius:10px;border:0;background:'+C.ac+';color:#06201c;font-weight:700;cursor:pointer">Caută</button></div>'+resultsHtml()+picksHtml());
  // intrari
  h+=box('<div style="font-weight:600">Coada ta (în ordine cronologică)</div>'+(E.length?E.map(entryHtml).join(""):'<div style="font-size:12px;color:'+C.mu+'">Nicio intrare încă.</div>'));
  // rata reala vs pret
  if(BK.length){h+=box('<div style="font-weight:600">Rata reală vs. prețul plătit</div>'+BK.map(function(b){var r=Math.round(100*b.wins/b.n);var p=Math.round(b.avg_price*1000)/10;return '<div style="display:flex;justify-content:space-between;font-size:13px"><span>'+b.lo+'–'+(b.lo+2)+'c ('+b.n+' intrări)</span><span style="color:'+(r>=p?C.ac:"#f87171")+';font-weight:700">'+r+'% vs '+p+'c</span></div>';}).join("")+'<div style="font-size:11px;color:'+C.mu+'">Verde = rata reală peste preț. Sub ~30 de intrări pe interval, nu te baza pe cifre.</div>');}
  h+='</div>';el.innerHTML=h;
}
function resultsHtml(){if(!SR.length)return "";return SR.map(function(r){var d=new Date(r.match_date);var ts=d.toLocaleString("ro-RO",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"});
  return '<div style="border-top:1px solid '+C.bd+';padding-top:8px;display:flex;flex-direction:column;gap:6px;font-size:13px"><div><b>'+esc(r.home_team_name)+' – '+esc(r.away_team_name)+'</b> <span style="color:'+C.mu+'">'+ts+(r.has_poly?"":" · fără Polymarket")+'</span></div><div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end">'+sel("ns-m-"+r.fixture_id,"over05")+'<div>'+lab("Miză")+'<br>'+num("ns-s-"+r.fixture_id,"","implicit",70)+'</div><div>'+lab("Preț min c")+'<br>'+num("ns-lo-"+r.fixture_id,"","implicit",64)+'</div><div>'+lab("Preț max c")+'<br>'+num("ns-hi-"+r.fixture_id,"","implicit",64)+'</div><div>'+lab("Minut de la")+'<br>'+num("ns-f-"+r.fixture_id,"","—",64)+'</div><div>'+lab("Minut până la")+'<br>'+num("ns-t-"+r.fixture_id,"","—",64)+'</div><button onclick="camAddFx('+Number(r.fixture_id)+','+(r.has_poly?1:0)+')" style="min-height:44px;padding:8px 12px;border-radius:8px;border:0;background:'+C.ac+';color:#06201c;font-weight:700;cursor:pointer">+ Masă</button></div></div>';}).join("");}
function picksHtml(){var picks=(window._dpPicks||[]).filter(function(p){return window._pmLinks&&window._pmLinks[p.fixture_id];});if(!picks.length)return "";
  var inCam={};E.forEach(function(e){if(e.status==="waiting"||e.status==="triggered")inCam[e.fixture_id]=1;});
  return '<div style="font-size:12px;color:'+C.mu+';margin-top:4px">Sau din Ponturi (Over 0.5, miză implicită):</div>'+picks.slice(0,30).map(function(p){return '<div style="display:flex;gap:8px;align-items:center;justify-content:space-between;font-size:13px"><span>'+esc(p.home)+' – '+esc(p.away)+'</span>'+(inCam[p.fixture_id]?'<span style="color:'+C.mu+'">în AlohaPoly</span>':'<button onclick="camAddPick('+Number(p.fixture_id)+')" style="min-height:44px;padding:6px 12px;border-radius:8px;border:0;background:'+C.ac+';color:#06201c;font-weight:700;cursor:pointer">+ Masă</button>')+'</div>';}).join("");}
function entryHtml(e){var w=e.status==="waiting",ts=e.kickoff?new Date(e.kickoff).toLocaleString("ro-RO",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}):"";
  var top='<div style="display:flex;justify-content:space-between;gap:8px"><b>'+esc(e.match_label)+'</b>'+chip(e.status)+'</div><div style="color:'+C.mu+';font-size:12px">'+ts+' · acum '+(e.last_price!=null?Math.round(e.last_price*100)+"c":"—")+(e.trigger_price?" · intrat la "+Math.round(e.trigger_price*100)+"c · "+e.stake+" USDC":"")+(e.result?" · "+(e.result==="win"?"câștig":"pierdere")+" "+e.pnl:"")+(e.note?" · "+esc(e.note):"")+'</div>';
  if(!w)return '<div style="border-top:1px solid '+C.bd+';padding-top:8px;font-size:13px">'+top+'<div style="font-size:12px;color:'+C.mu+'">'+(MK.filter(function(m){return m[0]===e.market;})[0]||["",e.market])[1]+'</div></div>';
  return '<div style="border-top:1px solid '+C.bd+';padding-top:8px;font-size:13px;display:flex;flex-direction:column;gap:8px">'+top+'<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end">'+sel("e-m-"+e.id,e.market)+'<div>'+lab("Miză")+'<br>'+num("e-s-"+e.id,e.stake,"",70)+'</div><div>'+lab("Preț min c")+'<br>'+num("e-lo-"+e.id,e.pmin,"",64)+'</div><div>'+lab("Preț max c")+'<br>'+num("e-hi-"+e.id,e.pmax,"",64)+'</div><div>'+lab("Minut de la")+'<br>'+num("e-f-"+e.id,e.live_from,"—",64)+'</div><div>'+lab("Minut până la")+'<br>'+num("e-t-"+e.id,e.live_to,"—",64)+'</div></div><div style="display:flex;gap:8px"><button onclick="camSaveEntry('+e.id+')" style="min-height:44px;padding:6px 14px;border-radius:8px;border:0;background:'+C.ac+';color:#06201c;font-weight:700;cursor:pointer">Salvează</button><button onclick="camCancel('+e.id+')" style="min-height:44px;padding:6px 14px;border-radius:8px;border:1px solid '+C.bd+';background:transparent;color:#e6edf3;cursor:pointer">Anulează</button></div></div>';}
window.camStart=function(){saveS({running:true});};
window.camStop=function(){saveS({running:false});};
window.camMode=function(m){saveS({mode:m});};
window.camCompound=function(){saveS({compound:!S.compound});};
window.camSaveStake=function(){saveS({stake:Number(val("cam-stake")),bankroll:Number(val("cam-bank"))});};
window.camSearch=function(){var q=val("cam-q").trim();if(q.length<2)return;api("GET",null,"?q="+encodeURIComponent(q)).then(function(j){SR=(j&&j.results)||[];render();});};
window.camAddFx=function(fid,hp){var r=SR.filter(function(x){return x.fixture_id==fid;})[0];api("POST",{action:"add",fixture_id:fid,market:val("ns-m-"+fid),stake:val("ns-s-"+fid),pmin:val("ns-lo-"+fid),pmax:val("ns-hi-"+fid),live_from:val("ns-f-"+fid),live_to:val("ns-t-"+fid),match_label:r?r.home_team_name+" – "+r.away_team_name:null}).then(function(){SR=SR.filter(function(x){return x.fixture_id!=fid;});return load();});};
window.camAddPick=function(fid){var p=(window._dpPicks||[]).filter(function(x){return x.fixture_id==fid;})[0];api("POST",{action:"add",fixture_id:fid,market:"over05",match_label:p?p.home+" – "+p.away:null}).then(load);};
window.camSaveEntry=function(id){api("POST",{action:"update",id:id,market:val("e-m-"+id),stake:val("e-s-"+id),pmin:val("e-lo-"+id),pmax:val("e-hi-"+id),live_from:val("e-f-"+id),live_to:val("e-t-"+id)}).then(load);};
window.camCancel=function(id){api("POST",{action:"cancel",id:id}).then(load);};
window.camInit=function(){render();load();};
})();
