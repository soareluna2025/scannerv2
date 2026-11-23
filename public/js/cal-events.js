// AlohaScan — Ponturi → Calendar Compus: butoane Trimite (verde) / Scoate (roșu) pe cartonașe.
// Evenimentele stau în DB (api/calendar-events.js). GET public; POST/DELETE cer cheie (x-api-key),
// cerută o singură dată pe dispozitiv (refolosește aloha_admin_key dacă există deja).
(function(){
var EV=[],BY={},forcePrompt=false,busy={},tt=null;
function lsGet(k){try{return localStorage.getItem(k)||"";}catch(e){return "";}}
function lsSet(k,v){try{localStorage.setItem(k,v);}catch(e){}}
function dkey(d){return d.getFullYear()+"-"+d.getMonth()+"-"+d.getDate();}
var MS=["ian.","feb.","mar.","apr.","mai","iun.","iul.","aug.","sept.","oct.","nov.","dec."];

function toast(msg){
  var el=document.getElementById("pc-toast");
  if(!el){el=document.createElement("div");el.id="pc-toast";document.body.appendChild(el);}
  el.textContent=msg;el.className="show";
  clearTimeout(tt);tt=setTimeout(function(){el.className="";},3200);
}

// Locuri pe zi = planificarea Compus (Luni–Joi / Vineri–Duminică); citită direct din cp_state_v1
// ca să meargă și dacă tab-ul Simulator nu a fost deschis în sesiunea curentă.
function plan(){
  var wk=2,we=1,s=null;
  try{s=JSON.parse(lsGet("cp_state_v1")||"null");}catch(e){}
  if(!s&&window.cpApi){try{s=window.cpApi.state();}catch(e){}}
  if(s){
    if(s.wk!=null)wk=Math.max(0,parseInt(s.wk,10)||0);
    if(s.we!=null)we=Math.max(0,parseInt(s.we,10)||0);
  }
  return{wk:wk,we:we};
}
function slotsFor(dow){var p=plan();return(dow>=1&&dow<=4)?p.wk:p.we;}
function onDay(y,m,d){
  var k=y+"-"+m+"-"+d;
  return EV.filter(function(e){return dkey(new Date(e.kickoff))===k;});
}

function refreshPage(){
  var ov=document.getElementById("dp-overlay");
  if(ov&&ov.classList.contains("open")&&typeof dpRenderPage==="function"){
    var b=document.getElementById("dp-page-body"),sy=b?b.scrollTop:0;
    dpRenderPage();if(b)b.scrollTop=sy;
  }
}
function notify(){
  refreshPage();
  try{if(typeof window.ccRefresh==="function")window.ccRefresh();}catch(e){}
}
function load(cb){
  try{
    fetch("/api/calendar-events",{cache:"no-store"}).then(function(r){return r.json();}).then(function(d){
      EV=(d&&d.events)||[];BY={};EV.forEach(function(e){BY[e.fixture_id]=e;});
      notify();if(cb)cb();
    }).catch(function(){if(cb)cb();});
  }catch(e){if(cb)cb();}
}

function getKey(){
  if(forcePrompt)return "";
  return lsGet("aloha_cal_key")||lsGet("aloha_admin_key");
}
function askKey(){
  var k=null;
  try{k=window.prompt("Cheie de acces (o singură dată pe acest dispozitiv):");}catch(e){}
  k=(k||"").trim();
  if(k){lsSet("aloha_cal_key",k);forcePrompt=false;}
  return k;
}
function api(method,url,body){
  var k=getKey()||askKey();
  if(!k)return Promise.resolve({cancel:true});
  var o={method:method,headers:{"x-api-key":k}};
  if(body){o.headers["Content-Type"]="application/json";o.body=JSON.stringify(body);}
  return fetch(url,o).then(function(r){
    if(r.status===401){lsSet("aloha_cal_key","");forcePrompt=true;return{unauth:true};}
    return r.json().then(function(j){j.status=r.status;return j;});
  });
}

function findPick(fid){
  var L=window._dpPicks||[];
  for(var i=0;i<L.length;i++){if(L[i].fixture_id==fid)return L[i];}
  return null;
}

function send(fid){
  if(busy[fid])return;
  if(BY[fid]){toast("Pontul e deja în calendar");return;}
  var p=findPick(fid);if(!p)return;
  var ko=new Date(p.kickoff);if(isNaN(ko.getTime())){toast("Ora meciului lipsește");return;}
  var n=slotsFor(ko.getDay()),c=onDay(ko.getFullYear(),ko.getMonth(),ko.getDate()).length,
      lbl=ko.getDate()+" "+MS[ko.getMonth()];
  if(n<=0){toast("Ziua de "+lbl+" nu are locuri planificate în Compus");return;}
  if(c>=n){toast("Ziua de "+lbl+" e plină ("+c+" / "+n+" evenimente)");return;}
  var slug=(window._pmLinks&&window._pmLinks[fid])||null;
  busy[fid]=1;
  api("POST","/api/calendar-events",{
    fixture_id:p.fixture_id,kickoff:ko.toISOString(),home:p.home,away:p.away,home_id:p.home_id,away_id:p.away_id,
    league_name:p.league_name,country:p.country,market:p.market,p_cal:p.p_cal,confidence:p.confidence,slug:slug
  }).then(function(r){
    busy[fid]=0;
    if(r.cancel)return;
    if(r.unauth){toast("Cheie respinsă — apasă din nou și introdu cheia corectă");return;}
    if(!r.ok){toast("Eroare: "+(r.error||r.status));return;}
    load(function(){toast("Trimis în calendar · "+lbl);});
  }).catch(function(){busy[fid]=0;toast("Fără conexiune la server");});
}

function remove(fid){
  if(busy[fid])return;
  if(!BY[fid])return;
  busy[fid]=1;
  api("DELETE","/api/calendar-events?fixture_id="+encodeURIComponent(fid)).then(function(r){
    busy[fid]=0;
    if(r.cancel)return;
    if(r.unauth){toast("Cheie respinsă — apasă din nou și introdu cheia corectă");return;}
    if(!r.ok){toast("Eroare: "+(r.error||r.status));return;}
    load(function(){toast("Scos din calendar");});
  }).catch(function(){busy[fid]=0;toast("Fără conexiune la server");});
}

// Reia prețul Over 0.5 din Polymarket pentru evenimentele care nu au început (și le completează pe cele fără preț).
function refreshPrices(){
  if(busy.__p)return;busy.__p=1;
  api("POST","/api/calendar-events?refresh_prices=1").then(function(r){
    busy.__p=0;
    if(r.cancel)return;
    if(r.unauth){toast("Cheie respinsă — apasă din nou și introdu cheia corectă");return;}
    if(!r.ok){toast("Eroare: "+(r.error||r.status));return;}
    load(function(){toast("Prețuri actualizate: "+r.updated+" din "+r.checked);});
  }).catch(function(){busy.__p=0;toast("Fără conexiune la server");});
}

var SVG_OK='<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
var SVG_NO='<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/></svg>';
function sent(fid){return !!BY[fid];}
// Butoane: verde = trimite în calendar (plin când e trimis); roșu apare DOAR după trimitere.
function btns(fid){
  var s=sent(fid),h='<div class="pc-act">';
  h+='<button type="button" class="pc-b ok'+(s?' on':'')+'" aria-label="Trimite în calendar" onclick="event.stopPropagation();calEv.send('+fid+')">'+SVG_OK+'</button>';
  if(s)h+='<button type="button" class="pc-b no" aria-label="Scoate din calendar" onclick="event.stopPropagation();calEv.remove('+fid+')">'+SVG_NO+'</button>';
  return h+'</div>';
}

window.calEv={load:load,send:send,remove:remove,sent:sent,btns:btns,onDay:onDay,refreshPrices:refreshPrices,list:function(){return EV;}};

// La deschiderea paginii Ponturi reîncărcăm evenimentele (stare la zi, inclusiv trimise de pe alt dispozitiv).
var od=window.dpOpen;
if(typeof od==="function"){window.dpOpen=function(){var r=od.apply(this,arguments);load();return r;};}
load();
})();
