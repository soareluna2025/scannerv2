// AlohaScan — Simulator Perpetuals (tab „Simulator")
// Calcul 100% în browser; nu apelează API-ul și nu atinge scoring-ul / ML.
// Valorile se păstrează în localStorage (cheia ps_state_v1).
(function(){
  var DEF={capital:'5000',coin:'AVAX',side:'long',lev:'3',entry:'6.5',exit:'11',fee:'0.05',funding:'0',mmr:'0.5'};
  var KEY='ps_state_v1';
  var IDS=['capital','coin','lev','entry','exit','fee','funding','mmr'];
  var st=Object.assign({},DEF);
  var inited=false;

  function $(id){return document.getElementById(id);}
  function num(s){var v=parseFloat(String(s).replace(/\s/g,'').replace(',','.'));return isFinite(v)?v:0;}
  function fmt(d){return new Intl.NumberFormat('de-DE',{minimumFractionDigits:d,maximumFractionDigits:d});}
  var f2=fmt(2),f6=fmt(6);
  function usd(v){return f2.format(v)+' USD';}

  function calc(){
    var cap=num(st.capital),lev=Math.max(num(st.lev),0),entry=num(st.entry),exit=num(st.exit);
    var fee=num(st.fee)/100,funding=num(st.funding),mmr=num(st.mmr)/100;
    var isLong=st.side==='long';
    var notional=cap*lev;
    var qty=entry>0?notional/entry:0;
    var gross=isLong?qty*(exit-entry):qty*(entry-exit);
    var fees=notional*fee+qty*exit*fee;
    var net=gross-fees-funding;
    var liq=0;
    if(lev>0&&entry>0){
      liq=isLong?entry*(1-1/lev+mmr):entry*(1+1/lev-mmr);
      if(liq<0)liq=0;
    }
    var liquidated=lev>0&&entry>0&&(isLong?exit<=liq:exit>=liq);
    if(liquidated)net=-cap;
    return {cap:cap,notional:notional,qty:qty,gross:gross,fees:fees,funding:funding,net:net,
            roi:cap>0?net/cap*100:0,final:cap+net,liq:liq,liquidated:liquidated};
  }

  function render(){
    var r=calc();
    var coin=(st.coin||'').trim().toUpperCase()||'—';
    $('ps-o-notional').textContent=usd(r.notional);
    $('ps-o-qty').textContent=f6.format(r.qty)+' '+coin;
    $('ps-o-gross').textContent=usd(r.gross);
    $('ps-o-fees').textContent=usd(r.fees);
    $('ps-o-funding').textContent=usd(r.funding);
    $('ps-o-net').textContent=usd(r.net);
    $('ps-o-roi').textContent='ROI '+f2.format(r.roi)+'%';
    $('ps-o-final').textContent=usd(r.final);
    $('ps-o-liq').textContent=usd(r.liq);
    var c=r.net>=0?'pos':'neg';
    $('ps-o-net').className='ps-big '+c;
    $('ps-o-roi').className='ps-roi '+c;
    var a=$('ps-alert');
    if(r.liquidated){a.style.display='block';a.textContent='Prețul de ieșire depășește prețul de lichidare. Poziția ar fi lichidată și pierzi tot capitalul.';}
    else a.style.display='none';
    $('ps-long').className='long'+(st.side==='long'?' on':'');
    $('ps-short').className='short'+(st.side==='short'?' on':'');
    $('ps-range').value=Math.min(Math.max(Math.round(num(st.lev)),1),100);
    try{localStorage.setItem(KEY,JSON.stringify(st));}catch(e){}
  }

  function fill(){IDS.forEach(function(id){$('ps-'+id).value=st[id];});}

  function copy(){
    var r=calc(),coin=(st.coin||'').trim().toUpperCase();
    var t=['Simulator Perpetuals — '+coin+' '+st.side.toUpperCase()+' x'+st.lev,
      'Capital: '+usd(r.cap),
      'Intrare: '+st.entry+' USD | Ieșire: '+st.exit+' USD',
      'Valoarea poziției: '+usd(r.notional),
      'Cantitate: '+f6.format(r.qty)+' '+coin,
      'Profit brut: '+usd(r.gross),
      'Comisioane: '+usd(r.fees),
      'Funding: '+usd(r.funding),
      'Profit/pierdere netă: '+usd(r.net)+' (ROI '+f2.format(r.roi)+'%)',
      'Capital final: '+usd(r.final),
      'Lichidare aproximativă: '+usd(r.liq)].join('\n');
    var b=$('ps-copy');
    function done(m){b.textContent=m;setTimeout(function(){b.textContent='Copiază calculul';},1600);}
    function fb(){
      var ta=document.createElement('textarea');ta.value=t;ta.style.cssText='position:fixed;opacity:0';
      document.body.appendChild(ta);ta.select();
      var ok=false;try{ok=document.execCommand('copy');}catch(e){}
      document.body.removeChild(ta);done(ok?'Copiat':'Copierea nu a reușit');
    }
    if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(t).then(function(){done('Copiat');},fb);
    else fb();
  }

  // ── Polymarket ───────────────────────────────────────────────
  // fee = acțiuni × rată × p × (1−p); la cumpărare reținut în acțiuni, la vânzare scăzut din încasare.
  var PM_FEE=0.05;
  var PM_DEF={inv:'2500',buy:'85',sell:'99.99999',fx:'0.892'};
  var PM_KEY='pm_state_v1';
  var PM_IDS=['inv','buy','sell','fx'];
  var pm=Object.assign({},PM_DEF);
  var f4=fmt(4);
  function eur(v){return f2.format(v)+' €';}
  function usdc(v){return f2.format(v)+' USDC';}

  function pmCalc(){
    var inv=num(pm.inv),b=num(pm.buy)/100,s=num(pm.sell)/100,fx=num(pm.fx);
    var shares0=b>0?inv/b:0;
    var feeBuy=shares0*PM_FEE*b*(1-b);               // USDC
    var shares1=b>0?shares0-feeBuy/b:0;
    var gross=shares1*s;
    var feeSell=shares1*PM_FEE*s*(1-s);              // USDC
    var fin=gross-feeSell;
    var profit=fin-inv;
    return {inv:inv,fx:fx,shares0:shares0,shares1:shares1,feeBuy:feeBuy,feeSell:feeSell,
            fees:feeBuy+feeSell,gross:gross,fin:fin,profit:profit,roi:inv>0?profit/inv*100:0};
  }

  function pmRender(){
    var r=pmCalc();
    $('pm-o-feebuy').textContent=usdc(r.feeBuy);
    $('pm-o-feesell').textContent=usdc(r.feeSell);
    $('pm-o-fees').textContent=usdc(r.fees);
    var pe=r.profit*r.fx;
    $('pm-o-profit-eur').textContent=(pe>0?'+':'')+eur(pe);
    $('pm-o-roi').textContent=(r.roi>0?'+':'')+f2.format(r.roi)+'% randament net';
    var c=r.profit>=0?'pos':'neg';
    $('pm-o-profit-eur').className='ps-big '+c;
    $('pm-o-roi').className='ps-roi '+c;
    $('pm-d-shares0').textContent=f4.format(r.shares0);
    $('pm-d-shares1').textContent=f4.format(r.shares1);
    $('pm-d-gross').textContent=usdc(r.gross);
    $('pm-d-final').textContent=usdc(r.fin);
    $('pm-d-final-eur').textContent=eur(r.fin*r.fx);
    $('pm-d-profit').textContent=usdc(r.profit);
    $('pm-d-fees-eur').textContent=eur(r.fees*r.fx);
    try{localStorage.setItem(PM_KEY,JSON.stringify(pm));}catch(e){}
  }

  function pmFill(){PM_IDS.forEach(function(id){$('pm-'+id).value=pm[id];});}

  function setMode(m){
    var poly=m==='poly';
    $('ps-view-perp').style.display=poly?'none':'';
    $('ps-view-poly').style.display=poly?'':'none';
    $('ps-mode-perp').className=poly?'':'on';
    $('ps-mode-poly').className=poly?'on':'';
    try{localStorage.setItem('ps_mode',m);}catch(e){}
  }

  function pmInit(){
    try{var s=JSON.parse(localStorage.getItem(PM_KEY)||'null');if(s)pm=Object.assign(pm,s);}catch(e){}
    PM_IDS.forEach(function(id){
      $('pm-'+id).addEventListener('input',function(){pm[id]=$('pm-'+id).value;pmRender();});
    });
    $('pm-reset').addEventListener('click',function(){pm=Object.assign({},PM_DEF);pmFill();pmRender();});
    $('ps-mode-perp').addEventListener('click',function(){setMode('perp');});
    $('ps-mode-poly').addEventListener('click',function(){setMode('poly');});
    pmFill();pmRender();
    var m='perp';try{m=localStorage.getItem('ps_mode')||'perp';}catch(e){}
    setMode(m==='poly'?'poly':'perp');
  }

  // Apelat din setTab('sim'); leagă evenimentele o singură dată.
  window.psInit=function(){
    if(inited){render();return;}
    inited=true;
    try{var s=JSON.parse(localStorage.getItem(KEY)||'null');if(s)st=Object.assign(st,s);}catch(e){}
    IDS.forEach(function(id){
      $('ps-'+id).addEventListener('input',function(){st[id]=$('ps-'+id).value;render();});
    });
    $('ps-range').addEventListener('input',function(){st.lev=$('ps-range').value;$('ps-lev').value=st.lev;render();});
    $('ps-long').addEventListener('click',function(){st.side='long';render();});
    $('ps-short').addEventListener('click',function(){st.side='short';render();});
    $('ps-reset').addEventListener('click',function(){st=Object.assign({},DEF);fill();render();});
    $('ps-copy').addEventListener('click',copy);
    fill();render();
    pmInit();
  };
})();
