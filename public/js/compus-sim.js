// AlohaScan — Simulator Compus (tab Simulator). Teoretic, 100% in browser: fara API, wallet sau date reale. Cheie proprie: cp_state_v1.
(function(){
var DEF={cap:"250",tgt:"1000",buy:"90",sell:"99.9",fee:"5",fx:"0.892",wk:"2",we:"1",re:"1"};
var KEY="cp_state_v1",IDS=["cap","tgt","buy","sell","fee","fx"],SEL=["wk","we"];
var st=Object.assign({},DEF),inited=false;
function g(i){return document.getElementById(i);}
function num(s){var v=parseFloat(String(s).replace(/\s/g,"").replace(",","."));return isFinite(v)?v:0;}
var f2=new Intl.NumberFormat("de-DE",{minimumFractionDigits:2,maximumFractionDigits:2}),f0=new Intl.NumberFormat("de-DE",{maximumFractionDigits:0});
function usdc(v){return f2.format(v)+" USDC";}
function eur(v){return f2.format(v)+" €";}
function save(){try{localStorage.setItem(KEY,JSON.stringify(st));}catch(e){}}
function ev(c,b,s,fee){var sh0=c/b,fb=sh0*fee*b*(1-b),sh1=sh0-fb/b,gr=sh1*s,fs=sh1*fee*s*(1-s),fin=gr-fs;return{fin:fin,profit:fin-c,fees:fb+fs};}
function days(n,wk,we){if(n<=0)return 0;if(wk*4+we*3<=0)return -1;var d=new Date().getDay(),cum=0,k=0;while(cum<n&&k<36500){cum+=(d>=1&&d<=4)?wk:we;d=(d+1)%7;k++;}return cum>=n?k:-1;}
function calc(){
var c=num(st.cap),t=num(st.tgt),b=num(st.buy)/100,s=num(st.sell)/100,fee=num(st.fee)/100,fx=num(st.fx),wk=Math.max(0,Math.floor(num(st.wk))),we=Math.max(0,Math.floor(num(st.we))),re=st.re==="1";
var r={ok:false,msg:"",n:null,fin:null,days:null};
if(!(c>0)){r.msg="Capitalul inițial trebuie să fie mai mare ca 0.";return r;}
if(!(b>0&&b<1)||!(s>0&&s<=1)){r.msg="Prețurile se introduc în cenți: cumpărare între 0 și 100, vânzare între 0 și 100.";return r;}
if(fee<0||fee>1){r.msg="Comision invalid: introdu o valoare între 0 și 100.";return r;}
var e=ev(c,b,s,fee),n=null;r.ok=true;r.e=e;r.c=c;r.fx=fx;r.roi=e.profit/c*100;
if(t<=c){n=0;}else if(e.profit<=0){r.msg="La aceste prețuri evenimentul nu este profitabil: ținta nu poate fi atinsă.";}
else if(re){n=Math.ceil(Math.log(t/c)/Math.log(e.fin/c)-1e-9);}else{n=Math.ceil((t-c)/e.profit-1e-9);}
if(n!==null&&n>1e6){r.msg="Ținta necesită peste 1.000.000 de evenimente.";n=null;}
if(n!==null){r.n=n;r.fin=re?c*Math.pow(e.fin/c,n):c+n*e.profit;r.days=days(n,wk,we);if(r.days<0&&!r.msg)r.msg="Durata nu poate fi estimată cu planificarea curentă: setează cel puțin un eveniment pe zi.";}
return r;}
function render(){
var r=calc(),P=["o-profit","o-roi","o-fees","o-profit-eur","d-n","d-days","d-fin","d-fin-eur","d-tot-eur"],al=g("cp-alert");
al.textContent=r.msg;al.className=r.msg?"ps-alert":"";
if(!r.ok){P.forEach(function(x){g("cp-"+x).textContent="–";});g("cp-o-profit-eur").className="ps-big";save();return;}
var e=r.e;
g("cp-o-profit").textContent=usdc(e.profit);
g("cp-o-roi").textContent=(r.roi>0?"+":"")+f2.format(r.roi)+"%";
g("cp-o-fees").textContent=usdc(e.fees);
g("cp-o-profit-eur").textContent=(e.profit>0?"+":"")+eur(e.profit*r.fx);
g("cp-o-profit-eur").className="ps-big "+(e.profit>=0?"pos":"neg");
g("cp-d-n").textContent=r.n===null?"–":f0.format(r.n);
g("cp-d-days").textContent=(r.days===null||r.days<0)?"–":f0.format(r.days)+" zile";
g("cp-d-fin").textContent=r.fin===null?"–":usdc(r.fin);
g("cp-d-fin-eur").textContent=r.fin===null?"–":eur(r.fin*r.fx);
g("cp-d-tot-eur").textContent=r.fin===null?"–":eur((r.fin-r.c)*r.fx);
save();}
function F(id,l){return `<div><label class="ps-lbl" for="cp-${id}">${l}</label><input class="ps-inp" id="cp-${id}" type="text" inputmode="decimal" autocomplete="off"></div>`;}
function S(id,l){var o="";for(var k=0;k<=10;k++)o+=`<option>${k}</option>`;return `<div><label class="ps-lbl" for="cp-${id}">${l}</label><select class="ps-inp" id="cp-${id}">${o}</select></div>`;}
function L(id,l){return `<div class="ps-line"><span>${l}</span><span id="cp-${id}">–</span></div>`;}
function html1(){return `<div class="ps-card"><div class="ps-title">Simulator Compus</div><div class="ps-sub">Creștere compusă prin tranzacții Polymarket repetate · simulare teoretică</div><div class="ps-form"><div class="ps-row2">${F("cap","Capital inițial (USDC)")}${F("tgt","Capital țintă (USDC)")}</div><div class="ps-row2">${F("buy","Preț cumpărare (¢)")}${F("sell","Preț vânzare (¢)")}</div><div class="ps-row2">${F("fee","Comision (%)")}${F("fx","Curs 1 USDC = ... €")}</div><div><div class="ps-lbl" style="font-weight:800;color:var(--tx)">Planificare zilnică</div><div class="ps-row2">${S("wk","Luni–Joi")}${S("we","Vineri–Duminică")}</div></div><label class="cp-chk"><input type="checkbox" id="cp-re"><span>Reinvestește profitul la fiecare tranzacție</span></label></div></div>`;}
function html2(){return `<div class="ps-card"><div class="ps-panel">${L("o-profit","Profit net / eveniment")}${L("o-roi","Randament net / eveniment")}${L("o-fees","Comisioane / eveniment")}</div><div class="ps-eye" style="margin-top:14px">Profit net / eveniment în euro</div><div class="ps-big" id="cp-o-profit-eur">–</div><hr class="ps-hr" style="margin:14px 0"><div class="ps-title" style="font-size:14px;margin-bottom:8px">Estimare până la țintă</div><div class="ps-form" style="gap:8px">${L("d-n","Evenimente necesare")}${L("d-days","Zile estimate (aprox.)")}${L("d-fin","Capital final estimat")}${L("d-fin-eur","Capital final estimat în euro")}${L("d-tot-eur","Profit total estimat în euro")}</div><div id="cp-alert"></div><div class="ps-btns"><button type="button" class="ps-btn" id="cp-reset">Resetează valorile inițiale</button></div><div class="ps-note">Simulare teoretică: nu reprezintă profit realizat sau garantat. Presupune execuția integrală și profitabilă a fiecărui eveniment și nu include neapărat spread, slippage, lichiditate insuficientă sau execuții parțiale. Comision = acțiuni × rată × preț × (1 − preț), ca în simulatorul Polymarket. Valorile per eveniment sunt calculate pe capitalul inițial; cu reinvestire, profitul crește de la un eveniment la altul. Zilele sunt o estimare pornind de la ziua curentă, după planificarea zilnică.</div></div>`;}
function showCp(on){g("ps-view-cp").style.display=on?"":"none";g("ps-mode-cp").className=on?"on":"";if(on){g("ps-view-perp").style.display="none";g("ps-view-poly").style.display="none";g("ps-mode-perp").className="";g("ps-mode-poly").className="";}}
function fill(){IDS.concat(SEL).forEach(function(i){g("cp-"+i).value=st[i];});g("cp-re").checked=st.re==="1";}
function cpInit(m){
if(inited)return;var poly=g("ps-view-poly"),seg=g("ps-mode-poly");if(!poly||!seg||!seg.parentNode)return;inited=true;
try{var s=JSON.parse(localStorage.getItem(KEY)||"null");if(s)st=Object.assign(st,s);}catch(e){}
var b=document.createElement("button");b.type="button";b.id="ps-mode-cp";b.textContent="Compus";seg.parentNode.appendChild(b);seg.parentNode.classList.add("cp-3");
var v=document.createElement("div");v.id="ps-view-cp";v.style.display="none";v.innerHTML=html1()+html2();poly.parentNode.insertBefore(v,poly.nextSibling);
fill();
IDS.forEach(function(i){g("cp-"+i).addEventListener("input",function(){st[i]=g("cp-"+i).value;render();});});
SEL.forEach(function(i){["input","change"].forEach(function(t){g("cp-"+i).addEventListener(t,function(){st[i]=g("cp-"+i).value;render();});});});
g("cp-re").addEventListener("change",function(){st.re=g("cp-re").checked?"1":"0";render();});
g("cp-reset").addEventListener("click",function(){st=Object.assign({},DEF);fill();render();});
b.addEventListener("click",function(){showCp(true);try{localStorage.setItem("ps_mode","cp");}catch(e){}});
g("ps-mode-perp").addEventListener("click",function(){showCp(false);});g("ps-mode-poly").addEventListener("click",function(){showCp(false);});
render();if(m==="cp"){showCp(true);try{localStorage.setItem("ps_mode","cp");}catch(e){}}}
window.cpApi={calc:calc,state:function(){return st;}};
var orig=window.psInit;
window.psInit=function(){var m="";try{m=localStorage.getItem("ps_mode")||"";}catch(e){}if(typeof orig==="function")orig.apply(this,arguments);try{cpInit(m);}catch(e){if(window.console)console.error("compus-sim",e);}};
})();
