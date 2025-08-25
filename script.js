// QPWONCall — Sales Copilot (PERFECT)
document.addEventListener('DOMContentLoaded', () => {
  // ---------- Helpers
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => (n || 0).toLocaleString('it-IT');
  const enc = (s) => encodeURIComponent(String(s || ''));
  const nowISO = () => new Date().toISOString();
  const num = (v, def=0)=> isNaN(parseFloat(v))?def:parseFloat(v);
  const printTime = () => new Date().toLocaleString('it-IT',{dateStyle:'short',timeStyle:'short'});
  const escapeHTML = (s)=> String(s||'').replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[m]));

  // ---------- Data & Settings
  const DEFAULTS = {
    targetMensile: 30000,
    valAppt: 120,
    workDays: 22,
    convPct: 50,
    defaultVal: { 'GipoNext': 600, 'CRM MioDottore': 300, 'Visibilità MioDottore': 250 },
    scoringWeights: { problema_chiamate:1, problema_overbooking:1, priorita_riduzione:1, interesse_visibilita:1, prontezza:1, costo_mensile:1 },
    costoSoglia: 500,
    firma: "Cordiali saluti\nAlfonso",
    templates: {
      freddo: {
        subject: "Materiale introduttivo — {struttura}",
        body: "Gentile {referente},\nle condivido una panoramica su prenotazioni/visibilità senza caricare la segreteria. Se d’accordo, ci sentiamo tra 7–10 giorni per un confronto veloce.\n\n{firma}",
        wa: "Ciao {referente}, ti invio una panoramica rapida. Ti va se ci sentiamo tra 7–10 giorni?"
      },
      tiepido: {
        subject: "Caso pratico per {struttura}",
        body: "Gentile {referente},\nle inoltro un caso pratico di un poliambulatorio simile al vostro. Se le fa comodo, ci sentiamo tra 48h per un confronto di 10 minuti.\n\n{firma}",
        wa: "Ciao {referente}, ti mando un caso simile al vostro. Ti risento tra 48h per un confronto veloce."
      },
      caldo: {
        subject: "Prossimo passo: demo — {struttura}",
        body: "Gentile {referente},\nle propongo 15’ per mostrare un caso identico al vostro e la stima dell’impatto economico (circa € {impatto}/mese recuperabili). Va bene domani alle {slot1} o alle {slot2}?\n\n{firma}",
        wa: "Ciao {referente}, propongo 15’ domani alle {slot1} o {slot2}. Impatto stimato: € {impatto}/mese."
      }
    }
  };
  let settings = JSON.parse(localStorage.getItem('qpc_settings') || 'null') || DEFAULTS;
  let leads = JSON.parse(localStorage.getItem('qpc_leads') || '[]');
  let currentLeadId = leads[0]?.id || null;
  let activeList = [];
  let slotBuffer = [];

  // ---------- Clock & Nav
  setInterval(() => $('clock').textContent = new Date().toLocaleTimeString('it-IT'), 1000);
  document.querySelectorAll('.tab').forEach(b => b.onclick = () => switchView(b.dataset.view));
  function switchView(key) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === key));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const sec = $('view-' + key);
    if (sec) sec.classList.add('active');
    if (key === 'today') renderToday();
    if (key === 'one') renderOne();
    if (key === 'library') renderLibrary();
    if (key === 'pipeline') renderPipeline();
    if (key === 'settings') renderSettings();
    updateKPI();
  }
  switchView('today');

  // ---------- Toolbar actions
  $('btnNewLead').onclick = () => openModal('modalLead');
  $('btnImport').onclick = () => $('fileImport').click();
  $('fileImport').addEventListener('change', onImportCSV);
  $('btnExport').onclick = exportCSV;
  $('btnClear').onclick = () => {
    if (confirm('Sicuro di svuotare tutti i dati?')) {
      leads = [];
      persist(); renderAll(); toast('Dati svuotati');
    }
  };

  // ---------- Modals
  document.querySelectorAll('.close').forEach(btn => btn.onclick = () => closeModal(btn.getAttribute('data-close')));
  function openModal(id) { $(id).classList.remove('hidden'); }
  function closeModal(id) { $(id).classList.add('hidden'); }

  // ---------- New Lead modal
  $('mProdotto').onchange = () => { const p = $('mProdotto').value; $('mValore').value = settings.defaultVal[p] || 0; };
  $('mProdotto').dispatchEvent(new Event('change'));
  $('saveLead').onclick = () => {
    const struttura = $('mStruttura').value.trim();
    const citta = $('mCitta').value.trim();
    if (!struttura || !citta) return toast('Struttura e città sono obbligatorie', true);
    const newLead = {
      id: Date.now() + Math.floor(Math.random()*1000),
      struttura, citta,
      referente: $('mReferente').value.trim(),
      telefono: $('mTelefono').value.trim(),
      email: $('mEmail').value.trim(),
      prodotto: $('mProdotto').value,
      valore: parseFloat($('mValore').value) || 0,
      tags: parseTags($('mTags').value),
      fonte: $('mFonte').value.trim(),
      prequalifica: {
        tipologia: $('pTipologia').value,
        n_medici: num($('pMedici').value, 0),
        software: $('pSW').value.trim(),
        dimensione: $('pDim').value,
        canale: $('pCanale').value,
        vincoli: $('pVincoli').value.trim()
      },
      stato: 'da_lavorare', archiviato:false,
      spin: {},
      calore:'freddo',
      appuntamento:null, recall:null, mail:{},
      diagnosi: {},
      ultimo_esito:'', note:'',
      createdISO: nowISO(), updatedISO: nowISO(),
      log: []
    };
    if (isDuplicate(newLead, leads)) return toast('Lead duplicato rilevato', true);
    evaluateHeat(newLead); updateDiagnosis(newLead);
    log(newLead, 'Lead creato');
    leads.push(newLead);
    currentLeadId = newLead.id;
    persist(); closeModal('modalLead');
    clearNewLeadForm(); renderAll(); toast('Lead aggiunto');
  };
  function clearNewLeadForm(){
    ['mStruttura','mCitta','mReferente','mTelefono','mEmail','mValore','mTags','mFonte','pSW','pVincoli'].forEach(id=> $(id).value='');
    $('mProdotto').value = 'GipoNext';
    ['pTipologia','pDim','pCanale'].forEach(id=> $(id).value='');
    $('pMedici').value = '';
  }

  // ---------- TODAY
  function renderToday(){
    const q = todayQueue(leads, new Date());
    const ulNow = $('todoNow'); ulNow.innerHTML='';
    const ulPrio = $('prioList'); ulPrio.innerHTML='';
    if (q.length===0){
      ulNow.innerHTML = `<li class="lead-empty">Niente da fare ora. Inserisci un lead o imposta un recall.</li>`;
      ulPrio.innerHTML = `<li class="lead-empty">Nessuna priorità al momento.</li>`;
      return;
    }
    q.slice(0,6).forEach(l=> ulNow.appendChild(queueItem(l)));
    q.slice(6,14).forEach(l=> ulPrio.appendChild(queueItem(l)));
  }
  function queueItem(lead){
    const li = document.createElement('li');
    const dot = `<span class="dot ${lead.calore}"></span>`;
    const due = lead.recall ? (isToday(lead.recall.whenISO) ? '<span class="badge">Recall oggi</span>' : '') : '';
    li.innerHTML = `<div><b>${escapeHTML(lead.struttura)}</b> — ${escapeHTML(lead.citta)} ${dot}<br><small>${escapeHTML(lead.referente||'')}</small></div><div>${due} <button class="btn" style="padding:.3rem .6rem">Vai</button></div>`;
    li.querySelector('button').onclick = ()=> { currentLeadId = lead.id; switchView('one'); };
    return li;
  }

  // ---------- ONE-LEAD
  $('prevLead').onclick = ()=> shiftOne(-1);
  $('nextLead').onclick = ()=> shiftOne(1);
  function shiftOne(delta){
    buildActiveList(); if (activeList.length===0) return;
    const i = activeList.findIndex(l=>l.id===currentLeadId);
    const next = ( (i>=0?i:0) + delta + activeList.length ) % activeList.length;
    currentLeadId = activeList[next].id; renderOne();
  }
  function buildActiveList(){
    activeList = leads.filter(l=> !l.archiviato && l.stato!=='chiuso').sort(sortByStateDate);
    if (!currentLeadId && activeList[0]) currentLeadId = activeList[0].id;
  }
  function renderOne(){
    buildActiveList();
    const l = leads.find(x=> x.id===currentLeadId) || activeList[0];
    if (!l){ $('onePanel').innerHTML = `<div class="lead-empty">Nessun lead. Crea un lead dalla barra in alto.</div>`; return; }
    const imp = monthlyImpact(l, settings);
    const nba = nextBestAction(l);
    const reason = nba.reason ? `<div class="one-sub"><b>Perché:</b> ${escapeHTML(nba.reason)}</div>` : '';
    const tagHtml = (l.tags||[]).map(t=> `<span class="pill">${escapeHTML(t)}</span>`).join('');
    const pre = l.prequalifica||{};
    const spin = l.spin||{};

    $('onePanel').innerHTML = `
      <div class="one-header">
        <div>
          <div class="one-name"><span class="dot ${l.calore}"></span> ${escapeHTML(l.struttura)}</div>
          <div class="one-sub">
            <span>👤 ${escapeHTML(l.referente||'-')}</span>
            <span>📍 ${escapeHTML(l.citta||'-')}</span>
            <span>📞 ${escapeHTML(l.telefono||'-')}</span>
            <span>🏷️ ${escapeHTML(l.prodotto||'-')}</span>
          </div>
          <div class="pills">${tagHtml}</div>
        </div>
        <div class="box" style="min-width:260px">
          <b>Impatto stimato:</b> <span style="color:#0a7b34;font-weight:900">€ ${fmt(Math.round(imp))}/mese</span>
          <div class="one-sub">Calore: <b>${l.calore.toUpperCase()}</b></div>
        </div>
      </div>

      <div class="nba">🎯 ${escapeHTML(nba.text)} ${reason}</div>

      <div class="flex">
        <div class="col">
          <div class="box">
            <b>Prequalifica</b>
            <div class="grid3 mt">
              <label>Tipologia
                <select data-pre="tipologia">
                  ${optSel(['','Studio','Poliambulatorio','Diagnostica'], pre.tipologia)}
                </select>
              </label>
              <label>N. Medici <input type="number" data-pre="n_medici" value="${pre.n_medici||''}"/></label>
              <label>Software attuale <input data-pre="software" value="${escapeHTML(pre.software||'')}"/></label>
            </div>
            <div class="grid3">
              <label>Dimensione
                <select data-pre="dimensione">
                  ${optSel(['','S','M','L'], pre.dimensione)}
                </select>
              </label>
              <label>Canale richieste
                <select data-pre="canale">
                  ${optSel(['','Telefono','Web','Misto'], pre.canale)}
                </select>
              </label>
              <label>Vincoli <input data-pre="vincoli" value="${escapeHTML(pre.vincoli||'')}"/></label>
            </div>
          </div>

          <div class="box mt">
            <b>SPIN dinamico</b>
            <div class="spin mt" id="spinBox">
              ${qNum('# Medici','num_medici', spin.num_medici)}
              ${qText('SW attuale','sw_attuale', spin.sw_attuale)}
              ${qNum('Chiamate perse/giorno','chiamate_pers', spin.chiamate_pers)}
              ${qYesNo('Chiamate perse = problema?','problema_chiamate', spin.problema_chiamate)}
              ${followIf(spin.problema_chiamate==='si', qYesNo('Overbooking?','problema_overbooking', spin.problema_overbooking))}
              ${qNum('Costo perso/mese (€)','costo_mensile', spin.costo_mensile)}
              ${qYesNo('Priorità riduzione?','priorita_riduzione', spin.priorita_riduzione)}
              ${qYesNo('Interesse visibilità?','interesse_visibilita', spin.interesse_visibilita)}
              ${qYesNo('Prontezza se conviene?','prontezza', spin.prontezza)}
            </div>
            <div class="script mt" id="scriptBox">💬 ${buildScript(l)}</div>
            <div class="next mt">💡 Impatto stimato: <b>€ ${fmt(Math.round(imp))}/mese</b></div>
          </div>
        </div>

        <div class="col">
          <div class="box">
            <b>Azioni rapide</b>
            <div class="acts">
              <button class="btn big green" data-a="propose"><svg class="ico"><use href="#i-calendar"/></svg> Proponi/Appunta</button>
              <button class="btn big yellow" data-a="recall"><svg class="ico"><use href="#i-bell"/></svg> Recall</button>
              <button class="btn big blue" data-a="email"><svg class="ico"><use href="#i-mail"/></svg> Email</button>
              <button class="btn big wa" data-a="wa"><svg class="ico"><use href="#i-wa"/></svg> WhatsApp</button>
            </div>
          </div>

          <div class="box mt">
            <b>Obiezioni probabili</b>
            <ul id="objList" class="list mt"></ul>
          </div>

          <div class="logbox"><b>Timeline</b><ul id="logList">${(l.log||[]).slice(-8).map(x=>`<li>${x}</li>`).join('')}</ul></div>
        </div>
      </div>
    `;

    // Bind prequalifica changes
    $('onePanel').querySelectorAll('[data-pre]').forEach(inp => {
      inp.onchange = () => {
        l.prequalifica = l.prequalifica||{};
        const key = inp.getAttribute('data-pre');
        const val = (inp.type==='number') ? (inp.value? Number(inp.value):'') : inp.value;
        l.prequalifica[key] = val;
        l.updatedISO = nowISO();
        persist(); // no re-render needed
      };
    });

    // Bind SPIN inputs
    $('onePanel').querySelectorAll('[data-spin]').forEach(inp => {
      inp.onchange = () => {
        l.spin = l.spin || {};
        const key = inp.getAttribute('data-spin');
        const val = inp.type==='number' ? (inp.value? Number(inp.value):'') : inp.value;
        l.spin[key] = val;
        evaluateHeat(l);
        updateDiagnosis(l);
        l.updatedISO = nowISO();
        persist();
        renderOne();
      };
    });

    // Actions
    $('onePanel').querySelectorAll('[data-a]').forEach(btn => {
      btn.onclick = () => handleAction(btn.getAttribute('data-a'), l);
    });

    // Objections
    renderObjections(l);
  }

  // Render helpers for SPIN
  const qNum  = (label,key,val='') => `<div class="q"><label>${label}</label><input type="number" data-spin="${key}" value="${val??''}"></div>`;
  const qText = (label,key,val='') => `<div class="q"><label>${label}</label><input data-spin="${key}" value="${escapeHTML(val??'')}"></div>`;
  const qYesNo= (label,key,val='') => `<div class="q"><label>${label}</label><select data-spin="${key}"><option value="">-</option><option value="si" ${val==='si'?'selected':''}>Sì</option><option value="no" ${val==='no'?'selected':''}>No</option></select></div>`;
  const followIf = (cond, html) => cond ? html : '';
  const optSel = (opts, cur) => opts.map(o=> `<option ${o===cur?'selected':''}>${o}</option>`).join('');

  // Library
  function renderLibrary(){
    const cases = [
      { id:'case_50plus', title:'Poliambulatorio 60 medici', desc:'-37% chiamate perse, +22% prenotazioni online in 90 giorni.' },
      { id:'case_derm', title:'Centro Dermatologico', desc:'Agenda piena 3 settimane, -18% no-show.' },
      { id:'case_radiol', title:'Radiologia', desc:'Smistamento chiamate + integrazione web booking.' }
    ];
    const tpls = ['freddo','tiepido','caldo'];
    const caseList = $('caseList'); caseList.innerHTML='';
    cases.forEach(c=>{
      const li = document.createElement('li');
      li.innerHTML = `<b>${c.title}</b> — <span>${c.desc}</span> <span class="badge">📎 caso</span>`;
      caseList.appendChild(li);
    });
    const tplList = $('tplList'); tplList.innerHTML='';
    tpls.forEach(key=>{
      const li = document.createElement('li');
      const name = key==='freddo'?'Freddo': key==='tiepido'?'Tiepido':'Caldo';
      li.innerHTML = `<b>Template ${name}</b> <button class="btn" style="padding:.3rem .6rem">Anteprima</button>`;
      tplList.appendChild(li);
      li.querySelector('button').onclick = ()=>{
        const lead = leads.find(x=>x.id===currentLeadId) || leads[0];
        if(!lead) return toast('Seleziona prima un lead nella vista One-Lead', true);
        const {subject,body} = buildMailTemplate(lead,key, proposeSlots(new Date(), 'Europe/Rome').map(s=> timeHHMM(s)));
        openMailModal(subject, body);
      };
    });
  }

  // Pipeline (Kanban + filtri)
  ['search','fState','fHeat','fRecall','fTags'].forEach(id => {
    const el = $(id); if (el) el.oninput = el.onchange = () => renderPipeline();
  });
  function renderPipeline(){
    const lists = { listTodo:[], listDoing:[], listBooked:[], listClosed:[] };
    const arr = applyFilters(leads);
    arr.forEach(l => {
      if (l.archiviato || l.stato==='chiuso') lists.listClosed.push(l);
      else if (l.stato==='app_fissato') lists.listBooked.push(l);
      else if (l.stato==='in_lavorazione') lists.listDoing.push(l);
      else lists.listTodo.push(l);
    });
    mount('listTodo', lists.listTodo);
    mount('listDoing', lists.listDoing);
    mount('listBooked', lists.listBooked);
    mount('listClosed', lists.listClosed);
    $('cntTodo').textContent = lists.listTodo.length;
    $('cntDoing').textContent = lists.listDoing.length;
    $('cntBooked').textContent = lists.listBooked.length;
    $('cntClosed').textContent = lists.listClosed.length;
    updateKPI();
    enableDnD();
  }
  function mount(id, arr){
    const ul = $(id); ul.innerHTML='';
    if (arr.length===0){
      const dv = document.createElement('div'); dv.className='lead-empty'; dv.textContent='Nessun elemento';
      ul.appendChild(dv); return;
    }
    arr.forEach(l => ul.appendChild(cardEl(l)));
  }
  function cardEl(l){
    const tpl = $('tpl-card');
    const el = tpl.content.firstElementChild.cloneNode(true);
    el.dataset.id = l.id;
    el.querySelector('.title').textContent = l.struttura;
    el.querySelector('.heat').classList.add(l.calore);
    el.querySelector('.meta').textContent = `${l.citta||''} — ${l.referente||''} ${l.telefono?'• '+l.telefono:''}`;
    el.querySelector('.tags').innerHTML = (l.tags||[]).map(t=> `<span class="tag">${escapeHTML(t)}</span>`).join('');
    el.querySelector('.actions').innerHTML = [
      `<button class="a" data-a="open">👁️</button>`,
      `<button class="a" data-a="propose">📅</button>`,
      `<button class="a" data-a="recall">🔔</button>`,
      `<button class="a" data-a="email">📧</button>`,
      `<button class="a" data-a="wa">💬</button>`,
      l.stato!=='chiuso' ? `<button class="a" data-a="archive">🗃️</button>` : `<button class="a" data-a="reopen">↩️</button>`,
      `<button class="a" data-a="delete">🗑️</button>`
    ].join('');
    el.querySelectorAll('[data-a]').forEach(b=> b.onclick = (e)=>{ e.stopPropagation(); handleAction(b.dataset.a, l); });
    el.onclick = ()=> { currentLeadId = l.id; switchView('one'); };
    el.setAttribute('draggable','true');
    return el;
  }
  function applyFilters(list){
    let arr = list.slice();
    const q = $('search').value.trim().toLowerCase();
    const st = $('fState').value;
    const ht = $('fHeat').value;
    const rc = $('fRecall').value;
    const tstr = $('fTags').value.trim().toLowerCase();
    const tags = tstr ? tstr.split(',').map(s=>s.trim()).filter(Boolean) : [];
    if(q) arr = arr.filter(l => (l.struttura||'').toLowerCase().includes(q) || (l.citta||'').toLowerCase().includes(q) || (l.telefono||'').includes(q));
    if(st) arr = arr.filter(l => l.stato===st);
    if(ht) arr = arr.filter(l => l.calore===ht);
    if(tags.length) arr = arr.filter(l => (l.tags||[]).map(x=>x.toLowerCase()).some(t=> tags.some(f => t.includes(f))));
    if(rc==='oggi') arr = arr.filter(l => l.recall && isToday(l.recall.whenISO));
    if(rc==='settimana') arr = arr.filter(l => l.recall && isThisWeek(l.recall.whenISO));
    if(rc==='no') arr = arr.filter(l => !l.recall);
    return arr.sort(sortByStateDate);
  }

  // ---------- Actions
  function handleAction(action, lead){
    switch(action){
      case 'open':
        currentLeadId = lead.id; switchView('one'); return;

      case 'propose':
        if(!validateLeadForAction(lead, 'phone')) return;
        slotBuffer = proposeSlots(new Date(), 'Europe/Rome');
        renderSlots(slotBuffer, lead);
        openModal('modalSlots'); return;

      case 'recall':{
        const raw = prompt('Data/ora recall (YYYY-MM-DD HH:MM)');
        if(!raw) return;
        const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
        const d = new Date(iso);
        if(isNaN(d)) return toast('Data non valida', true);
        lead.recall = { whenISO: d.toISOString() };
        lead.stato = 'in_lavorazione';
        log(lead,'Recall impostato: '+ raw);
        persist(); renderAll(); return;}

      case 'wa':{
        openWAModal(lead);
        return;}

      case 'email':{
        if(!validateLeadForAction(lead, 'email')) return;
        const tplKey = lead.calore || 'tiepido';
        const slots = proposeSlots(new Date(), 'Europe/Rome').map(s=> timeHHMM(s));
        const m = buildMailTemplate(lead, tplKey, slots);
        openMailModal(m.subject, m.body);
        log(lead,'Email preparata: '+tplKey);
        persist(); return;}

      case 'archive':
        lead.archiviato = true; lead.stato='chiuso';
        log(lead,'Archiviato'); persist(); renderAll(); return;

      case 'reopen':
        lead.archiviato = false; lead.stato='da_lavorare';
        log(lead,'Riaperto'); persist(); renderAll(); return;

      case 'delete':
        if(confirm('Eliminare definitivamente?')){
          leads = leads.filter(l=> l.id!==lead.id);
          persist(); renderAll();
        } return;
    }
  }

  function validateLeadForAction(lead, kind){
    if(kind==='phone' && !ensureIntlPhone(lead.telefono).phone){
      toast('Aggiungi un telefono valido (+39...)', true); return false;
    }
    if(kind==='email' && !String(lead.email||'').includes('@')){
      toast('Aggiungi un’email valida', true); return false;
    }
    return true;
  }

  // Slots modal
  $('sendSlotsEmail').onclick = () => {
    const lead = leads.find(l=> l.id===currentLeadId);
    if(!lead) return;
    const pretty = slotBuffer.map(s=> humanDateTime(s)).join(' oppure ');
    const body = `Gentile ${lead.referente||'Dott.'},\n\nle propongo questi due slot per un confronto (15'): ${pretty}.\nMi dica se le torna uno dei due oppure suggerisca un orario alternativo.\n\n${settings.firma}`;
    openMailModal(`Proposta slot — ${lead.struttura}`, body);
  };
  $('sendSlotsWA').onclick = () => {
    const lead = leads.find(l=> l.id===currentLeadId);
    if(!lead) return;
    const pretty = slotBuffer.map(s=> humanDateTime(s)).join(' o ');
    const text = `Ciao ${lead.referente||''}, propongo 15': ${pretty}.`;
    openWhatsApp(lead, text);
  };
  function renderSlots(slots, lead){
    const wrap = $('slotButtons'); wrap.innerHTML='';
    slots.forEach(iso => {
      const b = document.createElement('button'); b.className='slot'; b.textContent = humanDateTime(iso);
      b.onclick = () => {
        lead.appuntamento = { whenISO: new Date(iso).toISOString() };
        lead.stato = 'app_fissato';
        log(lead, 'Appuntamento fissato: '+ humanDateTime(iso));
        persist();
        closeModal('modalSlots');
        openCalendar(lead, iso);
        renderAll();
        toast('Appuntamento fissato');
      };
      wrap.appendChild(b);
    });
  }

  // ---------- Settings
  function renderSettings(){
    $('btnWAConnect').onclick = ()=> openModal('modalWAConnect');
    $('waOpenWeb').onclick = ()=> openWindowSafely('https://web.whatsapp.com');
    $('waSendTest').onclick = ()=> {
      const p = $('waTestPhone').value; const m = $('waTestMsg').value||'Test';
      const clean = sanitizeMessage(m);
      const std = ensureIntlPhone(p);
      if(std.changed){ if(confirm('Manca il prefisso +39. Lo aggiungo?')) $('waTestPhone').value = std.phone; }
      if(!std.phone) return toast('Numero non valido', true);
      openWindowSafely(`https://wa.me/${std.phone}?text=${enc(clean)}`);
    };

    $('sTarget').value = settings.targetMensile;
    $('sValAppt').value = settings.valAppt;
    $('sWorkDays').value = settings.workDays;
    $('sConv').value = settings.convPct;
    $('sValGipo').value = settings.defaultVal['GipoNext'];
    $('sValCRM').value = settings.defaultVal['CRM MioDottore'];
    $('sValVis').value = settings.defaultVal['Visibilità MioDottore'];
    $('wProbCall').value = settings.scoringWeights.problema_chiamate;
    $('wOver').value = settings.scoringWeights.problema_overbooking;
    $('wPrior').value = settings.scoringWeights.priorita_riduzione;
    $('wVis').value = settings.scoringWeights.interesse_visibilita;
    $('wReady').value = settings.scoringWeights.prontezza;
    $('wCosto').value = settings.scoringWeights.costo_mensile;
    $('wSoglia').value = settings.costoSoglia;
    $('sFirma').value = settings.firma || '';
    // templates
    $('tFreSub').value = settings.templates.freddo.subject;
    $('tFreBody').value = settings.templates.freddo.body;
    $('tFreWA').value = settings.templates.freddo.wa;
    $('tTieSub').value = settings.templates.tiepido.subject;
    $('tTieBody').value = settings.templates.tiepido.body;
    $('tTieWA').value = settings.templates.tiepido.wa;
    $('tCalSub').value = settings.templates.caldo.subject;
    $('tCalBody').value = settings.templates.caldo.body;
    $('tCalWA').value = settings.templates.caldo.wa;

    $('saveSettings').onclick = () => {
      settings.targetMensile = num($('sTarget').value, settings.targetMensile);
      settings.valAppt = num($('sValAppt').value, settings.valAppt);
      settings.workDays = num($('sWorkDays').value, settings.workDays);
      settings.convPct = num($('sConv').value, settings.convPct);
      settings.defaultVal['GipoNext'] = num($('sValGipo').value, settings.defaultVal['GipoNext']);
      settings.defaultVal['CRM MioDottore'] = num($('sValCRM').value, settings.defaultVal['CRM MioDottore']);
      settings.defaultVal['Visibilità MioDottore'] = num($('sValVis').value, settings.defaultVal['Visibilità MioDottore']);
      settings.scoringWeights.problema_chiamate = num($('wProbCall').value, 1);
      settings.scoringWeights.problema_overbooking = num($('wOver').value, 1);
      settings.scoringWeights.priorita_riduzione = num($('wPrior').value, 1);
      settings.scoringWeights.interesse_visibilita = num($('wVis').value, 1);
      settings.scoringWeights.prontezza = num($('wReady').value, 1);
      settings.scoringWeights.costo_mensile = num($('wCosto').value, 1);
      settings.costoSoglia = num($('wSoglia').value, 500);
      settings.firma = $('sFirma').value || settings.firma;
      // templates
      settings.templates.freddo.subject = $('tFreSub').value;
      settings.templates.freddo.body    = $('tFreBody').value;
      settings.templates.freddo.wa      = $('tFreWA').value;
      settings.templates.tiepido.subject= $('tTieSub').value;
      settings.templates.tiepido.body   = $('tTieBody').value;
      settings.templates.tiepido.wa     = $('tTieWA').value;
      settings.templates.caldo.subject  = $('tCalSub').value;
      settings.templates.caldo.body     = $('tCalBody').value;
      settings.templates.caldo.wa       = $('tCalWA').value;

      localStorage.setItem('qpc_settings', JSON.stringify(settings));
      toast('Impostazioni salvate');
      renderAll();
    };
  }

  // ---------- KPI & Quota
  function updateKPI(){
    $('kTot').textContent = leads.length;
    $('kHot').textContent = leads.filter(l=> l.calore==='caldo' && !l.archiviato).length;
    $('kApp').textContent = leads.filter(l=> l.appuntamento && isToday(l.appuntamento.whenISO)).length;
    $('kRecall').textContent = leads.filter(l=> l.recall && isToday(l.recall.whenISO)).length;
    $('kPipe').textContent = fmt(leads.filter(l=> !l.archiviato && (l.stato==='da_lavorare'||l.stato==='in_lavorazione')).reduce((s,l)=>s+(l.valore||0),0));
    const quota = leads.filter(l=> l.appuntamento && isCurrentMonth(l.appuntamento.whenISO)).reduce((s,l)=>s+(l.valore||0),0);
    $('quotaVal').textContent = fmt(quota);
    $('quotaTar').textContent = fmt(settings.targetMensile);
    const perc = settings.targetMensile>0 ? Math.min(100, Math.round(quota / settings.targetMensile * 100)) : 0;
    $('quotaPerc').textContent = `(${perc}%)`;
    $('quotaFill').style.width = perc + '%';
  }

  // ---------- CSV Import/Export
  function onImportCSV(e){
    const file = e.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const rows = String(reader.result).split(/\r?\n/).filter(x=>x.trim().length);
      rows.forEach((line,i)=>{
        if(i===0 && /struttura/i.test(line)) return; // header
        const [struttura,citta,referente,telefono,valore,stato,calore,fonte,tags,prodotto] = parseCSVLine(line);
        if(!struttura || !citta) return;
        const obj = {
          id: Date.now() + Math.floor(Math.random()*1000),
          struttura, citta, referente, telefono, email:'', prodotto: prodotto || 'GipoNext',
          valore: parseFloat(valore)|| (settings.defaultVal[prodotto]||0),
          tags: parseTags(tags?.replaceAll('|',',')),
          fonte: fonte||'',
          prequalifica: {},
          stato: stato || 'da_lavorare',
          archiviato: stato==='chiuso',
          spin: {}, calore: calore||'freddo',
          appuntamento:null, recall:null, mail:{},
          diagnosi:{},
          ultimo_esito:'', note:'', createdISO: nowISO(), updatedISO: nowISO(), log:[]
        };
        if(isDuplicate(obj, leads)) return;
        evaluateHeat(obj); updateDiagnosis(obj);
        log(obj,'Importato');
        leads.push(obj);
      });
      persist(); renderAll(); toast('Import completato');
      e.target.value='';
    };
    reader.readAsText(file);
  }
  function exportCSV(){
    const header = 'struttura,citta,referente,telefono,valore,stato,calore,fonte,tags,prodotto\n';
    const q = (v)=> `"${String(v??'').replace(/"/g,'""')}"`;
    const lines = leads.map(l=>[
      q(l.struttura), q(l.citta), q(l.referente), q(l.telefono), String(l.valore||0),
      q(l.stato), q(l.calore), q(l.fonte||''), q((l.tags||[]).join('|')), q(l.prodotto||'')
    ].join(','));
    const csv = header + lines.join('\n');
    const blob = new Blob([csv], {type:'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'qpwoncall_export.csv'; a.click();
    URL.revokeObjectURL(url);
  }
  function parseCSVLine(line){
    const out=[]; let cur='', inQ=false;
    for(let i=0;i<line.length;i++){
      const c=line[i];
      if(c==='"' && line[i+1]==='"'){ cur+='"'; i++; continue; }
      if(c==='"'){ inQ=!inQ; continue; }
      if(c===',' && !inQ){ out.push(cur.trim()); cur=''; continue; }
      cur+=c;
    }
    out.push(cur.trim());
    return out;
  }

  // ---------- Drag & Drop
  let dragId = null;
  function enableDnD(){
    document.querySelectorAll('.lead-card').forEach(card=>{
      card.addEventListener('dragstart', ()=>{ dragId = card.dataset.id; });
      card.addEventListener('dragend',  ()=>{ dragId = null; document.querySelectorAll('.lead-list').forEach(l=>l.classList.remove('drag-over')); });
    });
    [['listTodo','da_lavorare'],['listDoing','in_lavorazione'],['listBooked','app_fissato'],['listClosed','chiuso']].forEach(([id,state])=>{
      const list = $(id);
      list.addEventListener('dragover', e=>{ e.preventDefault(); list.classList.add('drag-over'); });
      list.addEventListener('dragleave', ()=> list.classList.remove('drag-over'));
      list.addEventListener('drop', e=>{
        e.preventDefault(); list.classList.remove('drag-over');
        const lead = leads.find(l=> String(l.id)===String(dragId));
        if(!lead) return;
        lead.stato = state;
        lead.archiviato = (state==='chiuso');
        log(lead, 'Spostato in: '+ state.replace('_',' '));
        persist(); renderPipeline();
      });
    });
  }

  // ---------- Algorithms
  function priorityScore(lead, now){
    const hMap = { freddo:0, tiepido:1, caldo:2 };
    const h = hMap[lead.calore] ?? 0;
    const dueRecall = (lead.recall && new Date(lead.recall.whenISO) <= endOfToday(now)) ? 1 : 0;
    const isNew = daysSince(lead.createdISO, now) <= 2 ? 1 : 0;
    const overdue = lead.recall && new Date(lead.recall.whenISO) < startOfToday(now) ? daysBetween(lead.recall.whenISO, now) : 0;
    const valueNorm = Math.min(1, (lead.valore||0) / 1000);
    return 100*h + 60*dueRecall + 40*isNew + 2*overdue + 20*valueNorm;
  }
  function todayQueue(list, now){
    const attivi = list.filter(l=> !l.archiviato && l.stato!=='chiuso');
    return attivi.sort((a,b)=> priorityScore(b,now) - priorityScore(a,now));
  }
  function evaluateHeat(lead){
    const w = settings.scoringWeights;
    const s = lead.spin || {};
    let score = 0;
    if(s.problema_chiamate==='si') score += w.problema_chiamate;
    if(s.problema_overbooking==='si') score += w.problema_overbooking;
    if(s.priorita_riduzione==='si') score += w.priorita_riduzione;
    if(s.interesse_visibilita==='si') score += w.interesse_visibilita;
    if(s.prontezza==='si') score += w.prontezza;
    if((s.costo_mensile||0) >= settings.costoSoglia) score += w.costo_mensile;
    lead.calore = (score>=4) ? 'caldo' : (score>=2? 'tiepido' : 'freddo');
    if(lead.stato==='da_lavorare') lead.stato = 'in_lavorazione';
    return score;
  }
  function monthlyImpact(lead, settings){
    const s = lead.spin || {};
    if(s.costo_mensile>0) return s.costo_mensile;
    const callsDay = Number(s.chiamate_pers||0);
    const apptLost = callsDay * settings.workDays * (settings.convPct/100);
    return apptLost * settings.valAppt;
  }
  function dominantDolore(lead){
    const s = lead.spin||{};
    if(s.problema_chiamate==='si') return 'chiamate';
    if(s.problema_overbooking==='si') return 'overbooking';
    if(s.interesse_visibilita==='si') return 'visibilita';
    if((s.costo_mensile||0) >= settings.costoSoglia) return 'costo';
    return 'generico';
  }
  function updateDiagnosis(lead){
    const s = lead.spin||{};
    const d = lead.diagnosi = lead.diagnosi || {};
    d.dolore = dominantDolore(lead);
    d.urgenza = (s.priorita_riduzione==='si' || (s.costo_mensile||0)>=settings.costoSoglia) ? 'alta' : (s.interesse_visibilita==='si'?'media':'bassa');
    d.prontezza = s.prontezza==='si' ? 'subito' : (s.prontezza==='no' ? 'no' : 'valutano');
    d.valore_stimato = Math.round(monthlyImpact(lead, settings));
  }
  function nextBestAction(lead){
    const s = lead.spin||{};
    if(!lead.telefono && !lead.email) return { key:'collect', text:'Completa i contatti prima di procedere.' , reason: 'Mancano telefono/email' };
    updateDiagnosis(lead);
    const d = lead.diagnosi || {};
    if(lead.calore==='caldo'){
      return { key:'propose', text:'Fissa subito un appuntamento: proponi 2 slot (domani).', reason: reasonText(d) };
    }
    if(lead.calore==='tiepido'){
      if(d.dolore==='visibilita') return { key:'case', text:'Invia caso studio mirato e programma recall a 48h.', reason:'Interesse su visibilità ma bassa urgenza' };
      return { key:'case', text:'Invia caso studio e programma recall a 48h.', reason: reasonText(d) };
    }
    return { key:'intro', text:'Invia materiale introduttivo e recall tra 7–10 giorni.', reason:'Urgenza bassa o nessun problema emerso' };
  }
  function reasonText(d){
    const parts=[];
    if(d.dolore==='chiamate') parts.push('chiamate perse');
    if(d.dolore==='overbooking') parts.push('overbooking');
    if(d.dolore==='visibilita') parts.push('visibilità web');
    if(d.valore_stimato>0) parts.push(`impatto ≈ € ${fmt(d.valore_stimato)}/mese`);
    if(d.prontezza==='subito') parts.push('prontezza a muoversi');
    if(d.urgenza==='alta') parts.push('urgenza alta');
    return parts.join(' + ');
  }

  function buildScript(lead){
    const d = lead.diagnosi||{}; const s = lead.spin||{};
    const imp = fmt(Math.round(monthlyImpact(lead, settings)));
    const hook = d.dolore==='chiamate' ? 'recupero chiamate perse' :
                 d.dolore==='overbooking' ? 'gestione overbooking e no-show' :
                 d.dolore==='visibilita' ? 'visibilità web in target' :
                 'riduzione carico segreteria + prenotazioni online';
    return `«Mi diceva ${lead.referente||'—'}: ${hook}. Se in ${lead.citta||'—'} recuperiamo anche solo una parte, l’impatto che vedo è circa € ${imp}/mese. Le propongo 15’ domani per vedere un caso uguale al vostro: va bene ${lead.referente||''}?»`;
  }

  // ---------- Window + Validation helpers
  function openWindowSafely(url){
    let w = window.open(url, '_blank');
    if(!w || w.closed || typeof w.closed === 'undefined'){
      // Popup blocked
      toast('Attiva i pop-up per Gmail/WhatsApp', true);
      openModal('modalPopup');
      return null;
    }
    return w;
  }
  function sanitizeMessage(text, maxLen=900){
    if(!text) return '';
    let t = String(text)
      .replace(/[\u200B-\u200D\uFEFF]/g,'')       // zero-width
      .replace(/[“”]/g,'"').replace(/[‘’]/g,"'")     // smart quotes
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'') // control chars
      .replace(/[ \t]+/g,' ')                        // collapse spaces
      .replace(/\s+\n/g,'\n')                      // trim line spaces
      .trim();
    if(t.length>maxLen) t = t.slice(0, maxLen-3)+'...';
    return t;
  }
  function ensureIntlPhone(tel){
    const digits = String(tel||'').replace(/\D+/g,'');
    if(!digits) return { phone:'', changed:false };
    if(digits.startswith && digits.startswith('39')) return { phone:digits, changed:false };
    if(String(digits).slice(0,2)==='39') return { phone:digits, changed:false };
    return { phone:'39'+digits, changed:true };
  }
  function humanDateTime(iso){ const d=new Date(iso); return d.toLocaleString('it-IT',{weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}); }
  function timeHHMM(iso){ const d=new Date(iso); return d.toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'}); }
  function openCalendar(lead, iso){
    const start = new Date(iso);
    const end = new Date(start.getTime()+30*60000);
    const fmtCal = (d)=> d.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
    openWindowSafely(`https://calendar.google.com/calendar/render?action=TEMPLATE&text=${enc('Appuntamento '+(lead.struttura||''))}&details=${enc('QPWONCall – '+(lead.referente||'')+' – Tel: '+(lead.telefono||''))}&dates=${fmtCal(start)}/${fmtCal(end)}`);
  }

  // ---------- Mail & WhatsApp
  function buildMailTemplate(lead, tpl, slots=[]){
    const tplObj = settings.templates[tpl] || settings.templates.tiepido;
    const slot1 = slots[0] ? slots[0] : '10:30';
    const slot2 = slots[1] ? slots[1] : '16:30';
    const imp = fmt(Math.round(monthlyImpact(lead, settings)));
    const map = {
      '{struttura}': lead.struttura || '',
      '{referente}': lead.referente || 'Dott.',
      '{impatto}': imp,
      '{slot1}': slot1,
      '{slot2}': slot2,
      '{firma}': settings.firma || ''
    };
    let subject = tplObj.subject, body = tplObj.body, wa = tplObj.wa;
    Object.keys(map).forEach(k => { subject = subject.replaceAll(k, map[k]); body = body.replaceAll(k, map[k]); wa = wa.replaceAll(k, map[k]); });
    return { subject, body, wa };
  }
  function openMailModal(subject, body){
    $('mailSubject').value = subject;
    $('mailBody').value = body;
    openModal('modalMail');
  }
  $('openGmail').onclick = () => {
    const subject = $('mailSubject').value || '';
    const body = $('mailBody').value || '';
    openWindowSafely(`https://mail.google.com/mail/?view=cm&fs=1&to=&su=${enc(subject)}&body=${enc(body)}`);
    closeModal('modalMail'); toast('Email aperta in Gmail');
  };

  function openWhatsApp(lead, text){
    const clean = sanitizeMessage(text||'');
    const std = ensureIntlPhone(lead.telefono||'');
    if(std.changed){
      if(confirm('Manca il prefisso +39. Lo aggiungo e salvo per il lead?')){
        lead.telefono = '+'+std.phone; persist(); renderOne();
      }
    }
    const phone = ensureIntlPhone(lead.telefono||'').phone;
    if(!phone) { toast('Telefono non valido per WhatsApp', true); return; }
    openWindowSafely(`https://wa.me/${phone}?text=${enc(clean)}`);
    toast('WhatsApp aperto');
  }

  // WhatsApp composer modal
  function openWAModal(lead){
    $('waPhone').value = lead.telefono || '';
    const tplKey = lead.calore || 'tiepido';
    const m = buildMailTemplate(lead, tplKey);
    $('waBody').value = m.wa || '';
    updateWACount();
    hintPhone();
    openModal('modalWA');

    $('waTplFreddo').onclick = ()=>{ const t = buildMailTemplate(lead,'freddo'); $('waBody').value = t.wa; updateWACount(); };
    $('waTplTiepido').onclick = ()=>{ const t = buildMailTemplate(lead,'tiepido'); $('waBody').value = t.wa; updateWACount(); };
    $('waTplCaldo').onclick   = ()=>{ const t = buildMailTemplate(lead,'caldo'); $('waBody').value = t.wa; updateWACount(); };

    $('waBody').oninput = updateWACount;
    $('waPhone').oninput = hintPhone;

    $('waSanitize').onclick = ()=>{ $('waBody').value = sanitizeMessage($('waBody').value); updateWACount(); };

    $('waOpen').onclick = ()=>{
      const clean = sanitizeMessage($('waBody').value);
      const std = ensureIntlPhone($('waPhone').value);
      if(std.changed){
        if(confirm('Manca il prefisso +39. Lo aggiungo e salvo per il lead?')){
          $('waPhone').value = std.phone;
          lead.telefono = '+'+std.phone; // salva formattato
          persist(); renderOne();
        }
      }
      const final = ensureIntlPhone($('waPhone').value).phone;
      if(!final) return toast('Numero non valido', true);
      openWindowSafely(`https://wa.me/${final}?text=${enc(clean)}`);
      closeModal('modalWA');
    };
  }
  function updateWACount(){ const n = ($('waBody').value||'').length; $('waCount').textContent = n + ' caratteri'; }
  function hintPhone(){
    const v = $('waPhone').value||''; const std = ensureIntlPhone(v);
    $('waPhoneHint').textContent = std.changed ? 'Suggerimento: aggiungi prefisso +39' : (std.phone?'Ok, formato internazionale':'Numero mancante');
  }

  // ---------- Obiezioni suggerite
  function renderObjections(lead){
    const d = lead.diagnosi || {}; const ul = $('objList'); ul.innerHTML='';
    const items = objectionsFor(d.dolore || 'generico');
    items.forEach(t => {
      const li = document.createElement('li');
      li.innerHTML = `<div><b>${escapeHTML(t.title)}</b><div style="font-size:.9em;color:#4b5f8f">${escapeHTML(t.reply)}</div></div>`;
      ul.appendChild(li);
    });
  }
  function objectionsFor(dolore){
    const map = {
      chiamate: [
        {title:'Abbiamo già personale', reply:'I picchi simultanei creano comunque chiamate perse. Automatizzando i picchi recuperiamo € reali senza caricare il team.'},
        {title:'Non sappiamo quante ne perdiamo', reply:'In 7 giorni misuriamo il dato e le mostro l’impatto concreto.'}
      ],
      overbooking: [
        {title:'Capita raramente', reply:'Anche “raramente” genera no-show e slot sprecati: es. 2/sett. = ~€300/mese.'},
        {title:'Lo gestiamo a mano', reply:'Automatizzando evitiamo errori umani nei picchi e liberi la segreteria.'}
      ],
      visibilita: [
        {title:'Non ci serve visibilità', reply:'Portiamo visibilità controllata: pazienti in target, non “click”. Le mostro un caso simile.'},
        {title:'Già investiamo', reply:'Ottimo: integriamo prenotazione online per convertire meglio quel traffico.'}
      ],
      generico: [
        {title:'Non è il momento', reply:'Proprio per questo fissiamo 15’ brevi domani: capiamo impatto e decidiamo con dati.'}
      ]
    };
    return map[dolore] || map.generico;
  }

  // ---------- Utils & Dates
  function log(lead, msg){
    lead.log = lead.log||[]; lead.log.push(`[${printTime()}] ${msg}`);
    lead.ultimo_esito = msg; lead.updatedISO = nowISO();
  }
  function persist(){
    localStorage.setItem('qpc_leads', JSON.stringify(leads));
    localStorage.setItem('qpc_settings', JSON.stringify(settings));
    updateKPI();
  }
  function renderAll(){ renderToday(); renderOne(); renderPipeline(); updateKPI(); }
  function sortByStateDate(a,b){
    const ord = { da_lavorare:0, in_lavorazione:1, app_fissato:2, chiuso:3 };
    return (ord[a.stato]??4)-(ord[b.stato]??4) || new Date(a.createdISO)-new Date(b.createdISO);
  }
  function parseTags(str){ return String(str||'').split(',').map(s=>s.trim()).filter(Boolean); }
  function isToday(dt){ const d=new Date(dt), n=new Date(); return d.getFullYear()===n.getFullYear()&&d.getMonth()===n.getMonth()&&d.getDate()===n.getDate(); }
  function isThisWeek(dt){ const d=new Date(dt), n=new Date(); const day = (n.getDay()+6)%7; const start = new Date(n); start.setDate(n.getDate()-day); start.setHours(0,0,0,0); const end = new Date(start); end.setDate(start.getDate()+7); return d>=start && d<end; }
  function isCurrentMonth(dt){ const d=new Date(dt), n=new Date(); return d.getFullYear()===n.getFullYear()&&d.getMonth()===n.getMonth(); }
  function startOfToday(now){ const n=new Date(now); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
  function endOfToday(now){ const n=new Date(now); return new Date(n.getFullYear(), n.getMonth(), n.getDate(), 23,59,59); }
  function daysSince(iso, now=new Date()){ return Math.floor((now - new Date(iso))/86400000); }
  function daysBetween(a,b){ return Math.ceil((new Date(b)-new Date(a))/86400000); }
  function isWeekend(d){ const w=d.getDay(); return w===0||w===6; }
  function isLunch(d){ const h=d.getHours(); return h>=12 && h<14; }
  function proposeSlots(now, tz){
    const baseDays = [1,2];
    const hours = [{h:10,m:30},{h:16,m:30}];
    const out = [];
    baseDays.forEach(delta => {
      const d = new Date(now.getTime() + delta*86400000);
      const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      hours.forEach(t => {
        const local = new Date(day); local.setHours(t.h, t.m, 0, 0);
        if(!isWeekend(local) && !isLunch(local)) out.push(local.toISOString());
      });
    });
    return out.slice(0,2);
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', (e)=>{
    if(e.target && ['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
    if(e.key==='n' || e.key==='N') openModal('modalLead');
    if(e.key==='a' || e.key==='A'){ const l = leads.find(x=>x.id===currentLeadId); if(l) handleAction('propose', l); }
    if(e.key==='r' || e.key==='R'){ const l = leads.find(x=>x.id===currentLeadId); if(l) handleAction('recall', l); }
    if(e.key==='e' || e.key==='E'){ const l = leads.find(x=>x.id===currentLeadId); if(l) handleAction('email', l); }
    if(e.key==='w' || e.key==='W'){ const l = leads.find(x=>x.id===currentLeadId); if(l) handleAction('wa', l); }
    if(e.key==='ArrowRight'){ shiftOne(1); }
    if(e.key==='ArrowLeft'){ shiftOne(-1); }
  });

  // ---------- First render
  renderAll();
});
