// AlohaScan — Calendar Compus, Etapa 1: grila lunii, locuri pe zi din planificare, zi tinta. Fara date reale, fara API; citeste Compus prin window.cpApi.
(function(){
var MN=["Ianuarie","Februarie","Martie","Aprilie","Mai","Iunie","Iulie","August","Septembrie","Octombrie","Noiembrie","Decembrie"],MS=["ian.","feb.","mar.","apr.","mai","iun.","iul.","aug.","sept.","oct.","nov.","dec."],DN=["Duminică","Luni","Marți","Miercuri","Joi","Vineri","Sâmbătă"];
var vy=0,vm=0,sel=null,inited=false;
function g(i){return document.getElementById(i);}
function slotsFor(dow,wk,we){return (dow>=1&&dow<=4)?wk:we;}
function getPlan(){var a=window.cpApi;if(!a)return null;var st=a.state(),r=a.calc();return{wk:Math.max(0,parseInt(st.wk,10)||0),we:Math.max(0,parseInt(st.we,10)||0),r:r};}
function targetDay(n,wk,we){if(n===null||n<=0)return null;var d=new Date();d=new Date(d.getFullYear(),d.getMonth(),d.getDate());var cum=0,k=0;while(k<36500){cum+=slotsFor(d.getDay(),wk,we);if(cum>=n)return d;d.setDate(d.getDate()+1);k++;}return null;}
function fd(d){return d.getDate()+" "+MS[d.getMonth()]+" "+d.getFullYear();}
function renderInfo(p){var el=g("cc-info");if(!p){el.textContent="";return;}var r=p.r,t=targetDay(r.n,p.wk,p.we);if(!r.ok){el.textContent=r.msg;return;}if(r.n===0){el.textContent="Ținta e deja atinsă cu capitalul inițial.";return;}if(r.n===null||!t){el.textContent=r.msg||"Ținta nu poate fi estimată cu parametrii actuali.";return;}el.textContent="Ținta se atinge pe "+fd(t)+" \u00b7 "+r.n+" evenimente \u00b7 estimare, pornind de azi";}
function renderGrid(p){
var T=new Date(),ty=T.getFullYear(),tm=T.getMonth(),tdd=T.getDate(),tg=p?targetDay(p.r.n,p.wk,p.we):null;
g("cc-mn").textContent=MN[vm];g("cc-yr").textContent=vy;
var off=(new Date(vy,vm,1).getDay()+6)%7,days=new Date(vy,vm+1,0).getDate(),h="";
for(var i=0;i<off;i++){h+="<span></span>";}
for(var d=1;d<=days;d++){
var dow=new Date(vy,vm,d).getDay(),n=p?slotsFor(dow,p.wk,p.we):0,cl="cc-d",b="";
if(dow===0||dow===6)cl+=" we";
if(vy===ty&&vm===tm&&d===tdd)cl+=" td";
if(sel&&sel.y===vy&&sel.m===vm&&sel.d===d)cl+=" sel";
if(tg&&tg.getFullYear()===vy&&tg.getMonth()===vm&&tg.getDate()===d)cl+=" tg";
var ev=window.calEv?window.calEv.onDay(vy,vm,d):[],tot=Math.max(n,ev.length);
for(var j=0;j<tot;j++){b+=j<ev.length?'<i class="on"></i>':"<i></i>";}
h+=`<button type="button" class="${cl}" data-d="${d}"><span class="cc-n">${d}</span><span class="cc-bars">${b}</span></button>`;
}
g("cc-grid").innerHTML=h;}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function evRow(e){
var t=new Date(e.kickoff),hh=("0"+t.getHours()).slice(-2)+":"+("0"+t.getMinutes()).slice(-2),pct=e.p_cal!=null?Math.round(e.p_cal*100):null,
pm=e.slug?`<a class="cc-pm" href="https://polym.trade/event/${encodeURIComponent(e.slug)}" target="_blank" rel="noopener">Polymarket</a>`:"",
lg=[e.league_name,e.country].filter(Boolean).map(esc).join(" · "),cf=e.confidence!=null?Math.round(e.confidence)+"%":"—";
return `<div class="cc-ev" data-fid="${e.fixture_id}"><div class="cc-evh"><span class="cc-evt">${hh}</span><span class="cc-evm">${esc(e.home)} vs ${esc(e.away)}</span>${pm}</div><div class="cc-evk">${esc(e.market)}${pct!=null?" · "+pct+"%":""}</div><div class="cc-evd" hidden>${lg?`<div>${lg}</div>`:""}<div>Încredere: ${cf}</div></div></div>`;}
function renderDay(p){var el=g("cc-day");if(!sel||!p){el.innerHTML="";return;}var dt=new Date(sel.y,sel.m,sel.d),n=slotsFor(dt.getDay(),p.wk,p.we),ev=window.calEv?window.calEv.onDay(sel.y,sel.m,sel.d):[];
var h=`<div class="cc-dh"><span class="cc-dt">${DN[dt.getDay()]}, ${sel.d} ${MS[sel.m]} ${sel.y}</span><span class="cc-dc">${ev.length} / ${n} evenimente</span></div>`;
ev.forEach(function(e){h+=evRow(e);});
for(var j=ev.length+1;j<=n;j++){h+=`<div class="cc-slot">Loc ${j} \u00b7 eveniment liber</div>`;}
if(n===0&&!ev.length)h+=`<div class="cc-slot">Zi fără evenimente planificate</div>`;
h+=`<div class="ps-note">Locurile urmează planificarea din Compus și se actualizează când o schimbi. Simulare teoretică.</div>`;
el.innerHTML=h;}
function refresh(){var p=null;try{p=getPlan();}catch(e){}renderInfo(p);renderGrid(p);renderDay(p);}
function html(){return `<div class="ps-card"><div class="cc-head"><div><div class="ps-title">Calendar</div><div class="ps-sub" id="cc-info"></div></div><button type="button" class="cc-fold" id="cc-fold" aria-label="Strânge calendarul">&#9662;</button></div><div id="cc-body"><div class="cc-nav"><div><span class="cc-mn" id="cc-mn"></span><span class="cc-yr" id="cc-yr"></span></div><div class="cc-btns"><button type="button" class="cc-b" id="cc-prev" aria-label="Luna precedentă">&lsaquo;</button><button type="button" class="cc-b" id="cc-today">Azi</button><button type="button" class="cc-b" id="cc-next" aria-label="Luna următoare">&rsaquo;</button></div></div><div class="cc-wd"><span>L</span><span>M</span><span>M</span><span>J</span><span>V</span><span>S</span><span>D</span></div><div class="cc-grid" id="cc-grid"></div><div class="cc-leg"><span>Liniuță = un loc de eveniment</span><span>Chenar verde = ziua țintă</span><span>Cerc = azi</span></div></div></div><div class="ps-card" id="cc-day"></div>`;}
function calInit(){
if(inited)return;var host=g("ps-view-cp");if(!host||!window.cpApi)return;inited=true;
var n0=new Date();vy=n0.getFullYear();vm=n0.getMonth();sel={y:vy,m:vm,d:n0.getDate()};
var w=document.createElement("div");w.id="cc-wrap";w.innerHTML=html();host.appendChild(w);
g("cc-grid").addEventListener("click",function(e){var b=e.target.closest("button[data-d]");if(!b)return;sel={y:vy,m:vm,d:parseInt(b.getAttribute("data-d"),10)};refresh();});
g("cc-prev").addEventListener("click",function(){vm--;if(vm<0){vm=11;vy--;}refresh();});
g("cc-next").addEventListener("click",function(){vm++;if(vm>11){vm=0;vy++;}refresh();});
g("cc-today").addEventListener("click",function(){var t=new Date();vy=t.getFullYear();vm=t.getMonth();sel={y:vy,m:vm,d:t.getDate()};refresh();});
g("cc-day").addEventListener("click",function(e){if(e.target.closest("a"))return;var r=e.target.closest(".cc-ev");if(!r)return;var d=r.querySelector(".cc-evd");if(d)d.hidden=!d.hidden;});
window.ccRefresh=refresh;if(window.calEv)window.calEv.load();
var fo=false;g("cc-fold").addEventListener("click",function(){fo=!fo;g("cc-body").style.display=fo?"none":"";this.textContent=fo?"\u25B8":"\u25BE";});
["input","change","click"].forEach(function(t){host.addEventListener(t,function(e){if(e.target.closest&&e.target.closest("#cc-wrap"))return;refresh();});});
refresh();}
var o2=window.psInit;window.psInit=function(){if(typeof o2==="function")o2.apply(this,arguments);try{calInit();}catch(e){if(window.console)console.error("compus-cal",e);}};
})();
