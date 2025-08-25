/* QPWONCall v2 — script.js
 * Mini-CRM da trattativa per fissare appuntamenti in 1–2 click
 * Dipendenze: nessuna. Funziona con l'index.html fornito.
 */

(() => {
  "use strict";

  // ==============
  // CONFIG & KEYS
  // ==============
  const SCHEMA_VERSION = 2;
  const LS_KEY = "qpwonc_v2";
  const TZ = "Europe/Rome"; // informativo; usiamo l'ora locale del browser
  const DATE_FMT = { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" };

  // Heat thresholds default
  const DEFAULT_WEIGHTS = { dolore: 30, urgenza: 15, valore: 15, recency: 0 }; // slider default (somma soft)
  const HEAT_THRESHOLDS = { cold: 0, warm: 40, hot: 70 };

  const STATE = {
    schema: SCHEMA_VERSION,
    leads: [],         // array<Lead>
    settings: {
      target: 8000,
      conv: 30, // %
      meetValue: 400,
      weights: { ...DEFAULT_WEIGHTS },
      firma: "Alfonso Pesce — Docplanner / MioDottore\n+39 3xx xxx xxxx • alfonso@...\nSede: Bologna",
      waNumber: ""
    },
    templates: defaultTemplates(),
    cases: defaultCases(),
    ui: {
      selectedLeadId: null,
      tab: "oggi"
    }
  };

  // ===========
  // DOM HELPERS
  // ===========
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const openDialog = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (typeof el.showModal === "function") el.showModal();
    else el.setAttribute("open", "open");
  };
  const closeDialog = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (typeof el.close === "function") el.close();
    else el.removeAttribute("open");
  };

  const toast = (msg, type = "info") => {
    const box = $("#toasts");
    if (!box) return;
    const t = document.createElement("div");
    t.className = `toast ${type}`;
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => t.classList.add("show"), 10);
    setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => t.remove(), 300);
    }, 2500);
  };

  // ==================
  // STORAGE & MIGRATE
  // ==================
  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) {
        // Prima esecuzione: stato vergine
        persist();
        return;
      }
      const parsed = JSON.parse(raw);
      // Migrazioni semplici
      if (!parsed.schema || parsed.schema < SCHEMA_VERSION) {
        migrate(parsed);
      } else {
        Object.assign(STATE, parsed);
      }
    } catch (e) {
      console.warn("Errore loadState:", e);
    }
  }

  function migrate(oldState) {
    // Esempio migrazione minima
    const migrated = { ...STATE, ...oldState };
    if (!migrated.settings) migrated.settings = STATE.settings;
    if (!migrated.templates) migrated.templates = defaultTemplates();
    if (!migrated.cases) migrated.cases = defaultCases();
    migrated.schema = SCHEMA_VERSION;
    Object.assign(STATE, migrated);
    persist();
  }

  function persist() {
    localStorage.setItem(LS_KEY, JSON.stringify(STATE));
  }

  // ==========
  // DATA MODEL
  // ==========
  function newLead(payload) {
    const now = Date.now();
    const id = "L" + Math.random().toString(36).slice(2, 9);
    const lead = {
      id,
      struttura: payload.struttura || "",
      citta: payload.citta || "",
      referente: payload.referente || "",
      telefono: normalizePhone(payload.telefono || ""),
      email: (payload.email || "").trim(),
      prodotto: payload.prodotto || "",
      valore: Number(payload.valore || 0),
      tag: parseTags(payload.tag || payload.tags || ""),
      createdAt: now,
      updatedAt: now,
      status: "todo", // todo | doing | booked | closed
      // Qualifica
      nmedici: Number(payload.nmedici || 0),
      software: payload.software || "",
      overbooking: !!payload.overbooking,
      visibilita: !!payload.visibilita,
      urgenza: !!payload.urgenza,
      // Scoring & diagnosi
      heatScore: 0,
      heat: "Freddo",
      diagnosi: "",
      reason: "",
      // Timeline
      timeline: [],
      // Notes
      note: ""
    };
    evaluateLead(lead, true);
    return lead;
  }

  function parseTags(s) {
    if (Array.isArray(s)) return s;
    return (s || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }

  // ==================
  // SCORING & DIAGNOSIS
  // ==================
  function evaluateLead(lead, initial = false) {
    const w = STATE.settings.weights || DEFAULT_WEIGHTS;

    // Dolore 0-40
    let dolore = 0;
    if (lead.overbooking) dolore += Math.min(25, w.dolore * 0.8);
    if (lead.visibilita) dolore += Math.min(15, w.dolore * 0.5);

    // Urgenza 0-25
    let urgenza = lead.urgenza ? Math.min(20, w.urgenza) : 0;

    // Valore 0-25 (scala log)
    let valore = 0;
    const v = Number(lead.valore || 0);
    if (v > 0) valore = Math.min(25, Math.round(Math.log10(v + 10) * (w.valore / 2)));

    // Recency -10..+10
    let recency = 0;
    const ageDays = (Date.now() - lead.createdAt) / 86400000;
    if (ageDays <= 2) recency += 5;
    const lastRecall = (lead.timeline || []).slice().reverse().find((t) => t.type === "recall");
    if (lastRecall && lastRecall.when && lastRecall.when < Date.now()) {
      // Recall scaduto → spingiamo su
      recency += 5;
    }
    recency = clamp(recency, -10, 10);

    const score = clamp(Math.round(dolore + urgenza + valore + recency), 0, 100);
    lead.heatScore = score;
    lead.heat = score >= HEAT_THRESHOLDS.hot ? "Caldo" : score >= HEAT_THRESHOLDS.warm ? "Tiepido" : "Freddo";

    // Diagnosi + Reason + Script
    const pains = [];
    if (lead.overbooking) pains.push("chiamate perse / sovrapposizioni");
    if (lead.visibilita) pains.push("visibilità online bassa / pochi nuovi pazienti");
    if (lead.urgenza) pains.push("urgenza interna");

    lead.diagnosi = pains.length ? `Dolore: ${pains.join(" + ")}.` : "Quadro da chiarire: raccogliamo 3 info in 5’.";

    const impatto = estimateImpact(lead);
    lead.reason = `Obiettivo: +€${formatNum(impatto)}/mese e tempo segreteria risparmiato.`;

    if (initial) {
      lead.timeline.push({ type: "create", at: Date.now(), note: "Lead creato" });
    }
    return lead;
  }

  function estimateImpact(lead) {
    // Impatto € stimato: proporzionale al valore lead o fallback su valore medio appuntamento
    const base = lead.valore > 0 ? lead.valore : (STATE.settings.meetValue || 400);
    const factor = lead.heat === "Caldo" ? 1.0 : lead.heat === "Tiepido" ? 0.6 : 0.35;
    return Math.round(base * (STATE.settings.conv / 100 || 0.3) * (lead.nmedici > 0 ? 1 + lead.nmedici / 20 : 1) * factor);
  }

  function nextBestAction(lead) {
    if (!lead) return { label: "Seleziona un lead", action: null };
    if (!validPhone(lead.telefono) && !lead.email) {
      return { label: "Completa dati contatto", action: "fix-data" };
    }
    if (lead.heat === "Caldo") return { label: "Proponi 2 slot", action: "proponi" };
    if (lead.heat === "Tiepido") return { label: "Invia caso studio + recall 48h", action: "tiepidize" };
    return { label: "Intro breve + recall 7–10gg", action: "freddo" };
  }

  // ===========
  // UTILITIES
  // ===========
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function formatNum(n) { return (n || 0).toLocaleString("it-IT"); }
  function normalizePhone(p) {
    const digits = (p || "").replace(/[^\d+]/g, "");
    return digits;
  }
  function validPhone(p) {
    if (!p) return false;
    const d = p.replace(/\D/g, "");
    // Italia tipico: 9-12 cifre; accettiamo anche con +39
    return d.length >= 9 && d.length <= 13;
  }
  function ensurePrefixIT(p) {
    if (!p) return p;
    const trimmed = p.trim();
    if (trimmed.startsWith("+")) return trimmed;
    const d = trimmed.replace(/\D/g, "");
    if (d.length >= 9 && !trimmed.startsWith("+39")) return "+39" + d;
    return trimmed;
  }
  function sanitizeText(s, max = 800) {
    const clean = (s || "").replace(/\s+\n/g, "\n").replace(/[^\S\n]+/g, " ").replace(/[^\x09\x0A\x0D\x20-\x7EÀ-ÿ€£]/g, "");
    if (clean.length <= max) return clean;
    return clean.slice(0, max - 1) + "…";
  }
  function encodeGmailUrl({ to = "", subject = "", body = "" }) {
    const base = "https://mail.google.com/mail/?view=cm&fs=1";
    const params = [
      to ? "to=" + encodeURIComponent(to) : "",
      "su=" + encodeURIComponent(subject),
      "body=" + encodeURIComponent(body)
    ].filter(Boolean).join("&");
    return `${base}&${params}`;
  }
  function openWinOrPopupWarn(url) {
    const w = window.open(url, "_blank");
    if (!w || w.closed || typeof w.closed === "undefined") {
      openDialog("modal-popup");
      return null;
    }
    return w;
  }

  // ==================
  // SLOTS & CALENDAR
  // ==================
  function nextWorkingDaysSlots() {
    // Genera due slot (domani e dopodomani) a 10:30 e 16:30, evitando weekend e 12:30–14:30
    const slots = [];
    let date = new Date();
    for (let i = 1; slots.length < 2 && i <= 7; i++) {
      const d = new Date(date);
      d.setDate(d.getDate() + i);
      const dow = d.getDay(); // 0 dom, 6 sab
      if (dow === 0 || dow === 6) continue;
      const s1 = new Date(d); s1.setHours(10, 30, 0, 0);
      const s2 = new Date(d); s2.setHours(16, 30, 0, 0);
      slots.push(s1, s2);
    }
    // ritorna i primi 2
    return slots.slice(0, 2);
  }

  function fmtSlotHuman(d) {
    return d.toLocaleString("it-IT", DATE_FMT);
  }

  function googleCalendarUrl({ title, details, start, end }) {
    // start/end in formato YYYYMMDDTHHMMSSZ
    const s = toGCalISO(start);
    const e = toGCalISO(end);
    const params = new URLSearchParams({
      action: "TEMPLATE",
      text: title || "Appuntamento",
      details: details || "",
      dates: `${s}/${e}`
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }
  function toGCalISO(date) {
    // Usa UTC ISO string senza separatori
    const z = new Date(date);
    const iso = z.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    return iso;
  }

  // ======================
  // RENDER: KPI / QUOTA
  // ======================
  function updateKPI() {
    const total = STATE.leads.length;
    const hot = STATE.leads.filter((l) => l.heat === "Caldo").length;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const recallToday = STATE.leads.filter((l) => (l.timeline || []).some((t) => t.type === "recall" && t.when >= +today && t.when < +tomorrow)).length;
    const booked = STATE.leads.filter((l) => l.status === "booked").length;

    $("#kpi-total").textContent = total;
    $("#kpi-hot").textContent = hot;
    $("#kpi-recall").textContent = recallToday;
    $("#kpi-meetings").textContent = booked;

    // Quota
    const target = Number(STATE.settings.target || 0);
    const meetingValue = Number(STATE.settings.meetValue || 0);
    const meetingsThisMonth = STATE.leads.filter((l) =>
      (l.timeline || []).some((t) => t.type === "booked" && sameMonth(new Date(t.at), new Date()))
    ).length;
    const value = meetingsThisMonth * meetingValue;
    const pct = target > 0 ? clamp(Math.round((value / target) * 100), 0, 100) : 0;
    $("#quota-amount").textContent = `€ ${formatNum(value)} / € ${formatNum(target)}`;
    $("#quota-progress").style.width = pct + "%";
  }

  function sameMonth(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
  }

  // =======================
  // RENDER: OGGI (PRIORITY)
  // =======================
  function renderToday() {
    const root = $("#today-list");
    if (!root) return;
    root.innerHTML = "";

    // Search filter
    const q = ($("#search-today").value || "").toLowerCase();

    // Order: heat (Caldo > Tiepido > Freddo), recall due/overdue, new (≤2gg), valore desc
    const now = Date.now();
    const twoDays = 2 * 86400000;
    const scored = STATE.leads
      .filter((l) => l.status === "todo" || l.status === "doing")
      .filter((l) => {
        if (!q) return true;
        return (
          l.struttura.toLowerCase().includes(q) ||
          l.citta.toLowerCase().includes(q) ||
          (l.tag || []).some((t) => t.toLowerCase().includes(q))
        );
      })
      .map((l) => {
        const lastRecall = (l.timeline || []).slice().reverse().find((t) => t.type === "recall");
        const recallDue = lastRecall && lastRecall.when && lastRecall.when <= now ? 1 : 0;
        const isNew = now - l.createdAt <= twoDays ? 1 : 0;
        return { l, recallDue, isNew };
      })
      .sort((a, b) => {
        const heatRank = (h) => (h === "Caldo" ? 3 : h === "Tiepido" ? 2 : 1);
        if (heatRank(b.l.heat) !== heatRank(a.l.heat)) return heatRank(b.l.heat) - heatRank(a.l.heat);
        if (b.recallDue !== a.recallDue) return b.recallDue - a.recallDue;
        if (b.isNew !== a.isNew) return b.isNew - a.isNew;
        return (b.l.valore || 0) - (a.l.valore || 0);
      });

    for (const { l } of scored) {
      root.appendChild(rowLeadToday(l));
    }
  }

  function rowLeadToday(lead) {
    const art = document.createElement("article");
    art.className = "row";
    art.dataset.id = lead.id;

    const heat = document.createElement("span");
    heat.className = "heat " + heatClass(lead.heat);
    heat.innerHTML = `<span class="dot"></span> ${lead.heat}`;

    const main = document.createElement("div");
    main.className = "lead-main";
    const h3 = document.createElement("h3");
    h3.className = "lead-title";
    h3.textContent = `${lead.struttura} — ${lead.citta}`;
    const meta = document.createElement("div");
    meta.className = "meta";
    const badges = [];
    if ((lead.timeline || []).some((t) => t.type === "recall" && t.when <= Date.now())) badges.push("recall oggi");
    if (Date.now() - lead.createdAt <= 2 * 86400000) badges.push("nuovo");
    if (lead.tag && lead.tag.length) badges.push(lead.tag.join(" • "));
    badges.unshift(`€ ${formatNum(lead.valore)}/m`);
    meta.textContent = badges.join(" • ");
    main.appendChild(h3);
    main.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.innerHTML = `
      <button class="icon-btn" data-action="open" title="Apri lead"><svg class="icon"><use href="#qpwon-one-lead"></use></svg></button>
      <button class="icon-btn" data-action="quick-actions" title="Azioni (A)"><svg class="icon"><use href="#qpwon-template"></use></svg></button>
      <button class="icon-btn" data-action="recall" title="Recall"><svg class="icon"><use href="#qpwon-bell"></use></svg></button>
      <button class="icon-btn" data-action="email" title="Email"><svg class="icon"><use href="#qpwon-email"></use></svg></button>
      <button class="icon-btn" data-action="whatsapp" title="WhatsApp"><svg class="icon"><use href="#qpwon-chat"></use></svg></button>
    `;

    art.appendChild(heat);
    art.appendChild(main);
    art.appendChild(actions);

    actions.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button");
      if (!btn) return;
      const act = btn.dataset.action;
      if (act === "open") openLead(lead.id);
      if (act === "quick-actions") switchTab("one-lead") || openLead(lead.id);
      if (act === "recall") quickSetRecall(lead);
      if (act === "email") openEmailForLead(lead);
      if (act === "whatsapp") openWAForLead(lead);
    });

    return art;
  }

  function heatClass(h) {
    return h === "Caldo" ? "heat-hot" : h === "Tiepido" ? "heat-warm" : "heat-cold";
  }

  // =======================
  // RENDER: ONE-LEAD VIEW
  // =======================
  function renderOneLead() {
    const id = STATE.ui.selectedLeadId;
    const lead = STATE.leads.find((x) => x.id === id);
    $("#lead-name").textContent = lead ? lead.struttura : "Nessun lead";
    $("#lead-heat").className = "heat " + (lead ? heatClass(lead.heat) : "");
    $("#lead-heat").innerHTML = `<span class="dot"></span> ${lead ? lead.heat : "—"}`;
    $("#lead-city").textContent = lead ? lead.citta : "—";

    $("#lead-referente").textContent = lead?.referente || "—";
    $("#lead-phone").textContent = lead?.telefono || "—";
    $("#lead-email").textContent = lead?.email || "—";
    $("#lead-product").textContent = lead?.prodotto || "—";
    $("#lead-value").textContent = lead ? `€ ${formatNum(lead.valore)}/m` : "—";
    $("#lead-tags").textContent = lead?.tag?.join(", ") || "—";

    $("#lead-diagnosi").textContent = lead?.diagnosi || "—";
    $("#lead-reason").textContent = lead?.reason || "—";

    // call script
    const imp = lead ? estimateImpact(lead) : 0;
    $("#call-script").textContent = lead
      ? `Ciao ${lead.referente || ""}, seguo poliambulatori su agenda unica e chiamate tracciate. Su casi simili portiamo ~€${formatNum(imp)}/mese e riduciamo il caos. Ti propongo 15’: ${slotShort(0)} o ${slotShort(1)}?`
      : "—";

    // Focus strip: NBA + Slots
    const nba = nextBestAction(lead);
    $("#focus-nba-label").textContent = nba.label;
    $("#btn-nba").disabled = !nba.action;

    const slots = nextWorkingDaysSlots();
    $("#slot-1").textContent = slots[0] ? fmtSlotHuman(slots[0]) : "—";
    $("#slot-2").textContent = slots[1] ? fmtSlotHuman(slots[1]) : "—";
    $("#slot-1").disabled = !slots[0];
    $("#slot-2").disabled = !slots[1];

    // Timeline
    const wrap = $("#lead-timeline");
    wrap.innerHTML = "";
    if (lead && lead.timeline && lead.timeline.length) {
      for (const t of lead.timeline.slice().reverse()) {
        const row = document.createElement("div");
        row.className = "tl-row";
        const when = new Date(t.at || t.when || Date.now());
        const label =
          t.type === "create" ? "Creato" :
          t.type === "email" ? "Email" :
          t.type === "wa" ? "WhatsApp" :
          t.type === "recall" ? "Recall" :
          t.type === "booked" ? "Appuntamento fissato" :
          t.type === "note" ? "Nota" : t.type;
        row.textContent = `${label} — ${when.toLocaleString("it-IT", DATE_FMT)}${t.note ? " · " + t.note : ""}`;
        wrap.appendChild(row);
      }
    } else {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "Nessuna attività.";
      wrap.appendChild(empty);
    }

    // Notes
    $("#lead-notes").value = lead?.note || "";

    // Suggested cases
    renderSuggestedCases(lead);

    // Anteprima testi (puliti)
    $("#preview-email-subj").value = "";
    $("#preview-email-body").value = "";
    $("#preview-wa").value = "";
  }

  function slotShort(idx) {
    const s = nextWorkingDaysSlots()[idx];
    return s ? s.toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
    }

  function renderSuggestedCases(lead) {
    const ul = $("#suggested-cases");
    ul.innerHTML = "";
    if (!lead) return;

    const suggestions = [];
    const tags = (lead.tag || []).map((t) => t.toLowerCase());
    if (lead.overbooking || tags.includes("agenda") || tags.includes("integrazione")) suggestions.push("proxima");
    if (lead.visibilita || tags.includes("visibilità") || tags.includes("nuovi pazienti")) suggestions.push("rms");
    if (tags.includes("phone") || tags.includes("chiamate") || tags.includes("no-show")) suggestions.push("checkup");

    const uniq = [...new Set(suggestions)];
    if (uniq.length === 0) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "Nessun suggerimento al momento.";
      ul.appendChild(li);
      return;
    }

    for (const key of uniq) {
      const cs = STATE.cases[key];
      const li = document.createElement("li");
      li.innerHTML = `<strong>${cs.title}</strong> — <button class="link" data-case="${key}" data-insert="email">Inserisci in Email</button> · <button class="link" data-case="${key}" data-insert="wa">Inserisci in WA</button>`;
      ul.appendChild(li);
    }

    ul.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button.link");
      if (!btn) return;
      const key = btn.dataset.case;
      const where = btn.dataset.insert;
      const cs = STATE.cases[key];
      if (!cs) return;
      if (where === "email") {
        $("#preview-email-body").value += "\n\n" + cs.snippet_email;
      } else {
        $("#preview-wa").value += "\n\n" + cs.snippet_wa;
      }
    }, { once: true });
  }

  // ====================
  // PIPELINE (KANBAN)
  // ====================
  function renderPipeline() {
    const cols = {
      todo: $("#col-todo"),
      doing: $("#col-doing"),
      booked: $("#col-booked"),
      closed: $("#col-closed")
    };
    Object.values(cols).forEach((c) => (c.innerHTML = ""));

    for (const l of STATE.leads) {
      const card = document.createElement("div");
      card.className = "card lead-card " + heatClass(l.heat);
      card.draggable = true;
      card.dataset.id = l.id;
      card.innerHTML = `
        <header class="lc-head">
          <div class="lc-title">${l.struttura} — ${l.citta}</div>
          <div class="lc-meta">€ ${formatNum(l.valore)}/m · ${l.heat}</div>
        </header>
        <div class="lc-actions">
          <button class="icon-btn" data-act="open" title="Apri"><svg class="icon"><use href="#qpwon-one-lead"></use></svg></button>
          <button class="icon-btn" data-act="proponi" title="Proponi"><svg class="icon"><use href="#qpwon-calendar-plus"></use></svg></button>
          <button class="icon-btn" data-act="recall" title="Recall"><svg class="icon"><use href="#qpwon-bell"></use></svg></button>
          <button class="icon-btn" data-act="email" title="Email"><svg class="icon"><use href="#qpwon-email"></use></svg></button>
          <button class="icon-btn" data-act="wa" title="WhatsApp"><svg class="icon"><use href="#qpwon-chat"></use></svg></button>
          ${
            l.status !== "closed"
              ? `<button class="icon-btn" data-act="archive" title="Archivia"><svg class="icon"><use href="#qpwon-archive"></use></svg></button>`
              : `<button class="icon-btn" data-act="reopen" title="Riapri"><svg class="icon"><use href="#qpwon-reopen"></use></svg></button>`
          }
          <button class="icon-btn danger" data-act="delete" title="Elimina"><svg class="icon"><use href="#qpwon-trash"></use></svg></button>
        </div>
      `;

      card.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", l.id);
        setTimeout(() => card.classList.add("dragging"), 0);
      });
      card.addEventListener("dragend", () => card.classList.remove("dragging"));

      card.querySelector(".lc-actions").addEventListener("click", (ev) => {
        const b = ev.target.closest("button");
        if (!b) return;
        const act = b.dataset.act;
        if (act === "open") { openLead(l.id); switchTab("one-lead"); }
        if (act === "proponi") { openLead(l.id); proposeSlots(); }
        if (act === "recall") quickSetRecall(l);
        if (act === "email") openEmailForLead(l);
        if (act === "wa") openWAForLead(l);
        if (act === "archive") setStatus(l, "closed");
        if (act === "reopen") setStatus(l, "todo");
        if (act === "delete") deleteLead(l.id);
      });

      cols[l.status].appendChild(card);
    }

    // droppable columns
    $$(".col").forEach((col) => {
      col.addEventListener("dragover", (e) => e.preventDefault());
      col.addEventListener("drop", (e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData("text/plain");
        const l = STATE.leads.find((x) => x.id === id);
        if (!l) return;
        const target = col.dataset.col;
        setStatus(l, target);
      });
    });
  }

  function setStatus(lead, status) {
    if (!lead) return;
    lead.status = status;
    lead.updatedAt = Date.now();
    persist();
    renderAll();
  }

  function deleteLead(id) {
    const idx = STATE.leads.findIndex((x) => x.id === id);
    if (idx >= 0) {
      STATE.leads.splice(idx, 1);
      persist();
      renderAll();
      toast("Lead eliminato", "success");
    }
  }

  // =====================
  // LIBRERIA (TEMPLATE)
  // =====================
  function renderLibrary() {
    const holder = $("#template-list");
    holder.innerHTML = "";
    for (const key of ["freddo", "tiepido", "caldo"]) {
      const t = STATE.templates[key];
      const card = document.createElement("article");
      card.className = "template-card";
      card.innerHTML = `
        <header><strong>${cap(key)}</strong></header>
        <div class="temp-body">
          <div>
            <div class="label">Oggetto (Email)</div>
            <div class="mono small">${escapeHtml(t.subject)}</div>
          </div>
          <div>
            <div class="label">Corpo (Email)</div>
            <pre class="mono small">${escapeHtml(t.email)}</pre>
          </div>
          <div>
            <div class="label">WhatsApp</div>
            <pre class="mono small">${escapeHtml(t.wa)}</pre>
          </div>
        </div>
        <footer class="temp-actions">
          <button class="btn ghost" data-insert="email"><svg class="icon"><use href="#qpwon-email"></use></svg> Inserisci Email</button>
          <button class="btn ghost" data-insert="wa"><svg class="icon"><use href="#qpwon-chat"></use></svg> Inserisci WhatsApp</button>
        </footer>
      `;
      card.querySelector("[data-insert=email]").addEventListener("click", () => {
        $("#preview-email-subj").value = t.subject;
        $("#preview-email-body").value = fillTemplate(t.email, samplePlaceholders());
        toast("Template email inserito", "success");
      });
      card.querySelector("[data-insert=wa]").addEventListener("click", () => {
        $("#preview-wa").value = fillTemplate(t.wa, samplePlaceholders());
        toast("Template WhatsApp inserito", "success");
      });
      holder.appendChild(card);
    }

    // Cases in Libreria sono statici in index.html; i bottoni li gestiamo qui:
    $("#cases-list").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button");
      if (!btn) return;
      const art = ev.target.closest(".case-card");
      const key = art?.dataset.case;
      const cs = STATE.cases[key];
      if (!cs) return;
      if (btn.dataset.act === "copy-oneliner") {
        copyToClipboard(cs.one_liner);
        toast("Copiata 1-frase", "success");
      }
      if (btn.dataset.act === "use-email") {
        $("#preview-email-body").value += "\n\n" + cs.snippet_email;
        switchTab("one-lead");
        toast("Inserito case in email", "success");
      }
      if (btn.dataset.act === "use-wa") {
        $("#preview-wa").value += "\n\n" + cs.snippet_wa;
        switchTab("one-lead");
        toast("Inserito case in WhatsApp", "success");
      }
    }, { once: true });
  }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]));
  }

  function samplePlaceholders() {
    // Preleva dal lead selezionato se presente, altrimenti dummy
    const l = STATE.leads.find((x) => x.id === STATE.ui.selectedLeadId);
    const slots = nextWorkingDaysSlots();
    return {
      struttura: l?.struttura || "la tua struttura",
      referente: l?.referente || "Dott. Rossi",
      impatto: formatNum(l ? estimateImpact(l) : STATE.settings.meetValue || 400),
      slot1: slots[0] ? fmtSlotHuman(slots[0]) : "domani 10:30",
      slot2: slots[1] ? fmtSlotHuman(slots[1]) : "dopodomani 16:30",
      firma: STATE.settings.firma || ""
    };
  }

  function fillTemplate(tpl, data) {
    let out = tpl;
    Object.entries(data).forEach(([k, v]) => {
      out = out.replaceAll(`{${k}}`, v);
    });
    return out;
  }

  // ===================
  // TAB SWITCH & ROUTER
  // ===================
  function switchTab(tab) {
    STATE.ui.tab = tab;
    persist();
    $$(".tabs .tab").forEach((b) => {
      const active = b.dataset.tab === tab;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
    });
    $$(".view").forEach((v) => v.classList.toggle("is-active", v.id === `view-${tab}`));
    if (tab === "oggi") renderToday();
    if (tab === "one-lead") renderOneLead();
    if (tab === "pipeline") renderPipeline();
    if (tab === "libreria") renderLibrary();
    if (tab === "impostazioni") renderSettings();
    return true;
  }

  // ===================
  // OPEN LEAD / ACTIONS
  // ===================
  function openLead(id) {
    const l = STATE.leads.find((x) => x.id === id);
    if (!l) return;
    STATE.ui.selectedLeadId = id;
    persist();
    renderOneLead();
    switchTab("one-lead");
  }

  function quickSetRecall(lead) {
    const when = prompt("Imposta recall (es. 2025-08-30 10:00) oppure '48h' / '7gg':", "48h");
    let dt = null;
    if (!when) return;
    if (/^\d{4}-\d{2}-\d{2}/.test(when)) {
      dt = new Date(when);
    } else if (/^(\d+)\s*h$/.test(when)) {
      dt = new Date(Date.now() + parseInt(RegExp.$1, 10) * 3600000);
    } else if (/^(\d+)\s*gg$/.test(when)) {
      dt = new Date(Date.now() + parseInt(RegExp.$1, 10) * 86400000);
    } else {
      dt = new Date(Date.now() + 48 * 3600000);
    }
    lead.timeline.push({ type: "recall", at: Date.now(), when: +dt });
    lead.status = "doing";
    lead.updatedAt = Date.now();
    persist();
    renderAll();
    toast("Recall impostato", "success");
  }

  function proposeSlots() {
    const lead = STATE.leads.find((x) => x.id === STATE.ui.selectedLeadId);
    if (!lead) { toast("Seleziona prima un lead", "danger"); return; }
    openDialog("modal-slots");
    const slots = nextWorkingDaysSlots();
    $("#slotpick-1").textContent = fmtSlotHuman(slots[0]);
    $("#slotpick-2").textContent = fmtSlotHuman(slots[1]);

    $("#slotpick-1").onclick = () => finalizeBooking(lead, slots[0]);
    $("#slotpick-2").onclick = () => finalizeBooking(lead, slots[1]);

    $("#slot-email").onclick = () => {
      closeDialog("modal-slots");
      const t = STATE.templates[lead.heat.toLowerCase()] || STATE.templates.tiepido;
      const filled = fillTemplate(t.email, {
        ...samplePlaceholders(),
        slot1: fmtSlotHuman(slots[0]),
        slot2: fmtSlotHuman(slots[1])
      });
      $("#email-subject").value = t.subject;
      $("#email-body").value = filled;
      openDialog("modal-email");
    };
    $("#slot-wa").onclick = () => {
      closeDialog("modal-slots");
      const t = STATE.templates[lead.heat.toLowerCase()] || STATE.templates.tiepido;
      const filled = fillTemplate(t.wa, {
        ...samplePlaceholders(),
        slot1: fmtSlotHuman(slots[0]),
        slot2: fmtSlotHuman(slots[1])
      });
      $("#wa-text").value = filled;
      openDialog("modal-wa");
    };
    $("#slot-calendar").onclick = () => {
      const start = slots[0];
      const end = new Date(start.getTime() + 30 * 60000);
      const url = googleCalendarUrl({
        title: `Call con ${lead.struttura}`,
        details: `Appuntamento fissato con ${lead.referente || ""} (${lead.citta}).`,
        start, end
      });
      openWinOrPopupWarn(url);
    };
  }

  function finalizeBooking(lead, slot) {
    closeDialog("modal-slots");
    lead.status = "booked";
    lead.timeline.push({ type: "booked", at: Date.now(), note: fmtSlotHuman(slot) });
    lead.updatedAt = Date.now();
    persist();
    renderAll();
    toast("Appuntamento fissato", "success");
    // Apri Calendar su slot scelto
    const end = new Date(slot.getTime() + 30 * 60000);
    const url = googleCalendarUrl({
      title: `Call con ${lead.struttura}`,
      details: `Appuntamento fissato con ${lead.referente || ""} (${lead.citta}).`,
      start: slot,
      end
    });
    openWinOrPopupWarn(url);
  }

  function openEmailForLead(lead) {
    const t = STATE.templates[lead.heat.toLowerCase()] || STATE.templates.tiepido;
    $("#email-subject").value = t.subject;
    $("#email-body").value = fillTemplate(t.email, samplePlaceholders());
    openDialog("modal-email");
  }

  function openWAForLead(lead) {
    const t = STATE.templates[lead.heat.toLowerCase()] || STATE.templates.tiepido;
    $("#wa-text").value = fillTemplate(t.wa, samplePlaceholders());
    openDialog("modal-wa");
  }

  // ========================
  // SETTINGS (RENDER & SAVE)
  // ========================
  function renderSettings() {
    $("#set-target").value = STATE.settings.target || 0;
    $("#set-conv").value = STATE.settings.conv || 0;
    $("#set-meet-value").value = STATE.settings.meetValue || 0;
    $("#w-dolore").value = STATE.settings.weights.dolore;
    $("#w-urgenza").value = STATE.settings.weights.urgenza;
    $("#w-valore").value = STATE.settings.weights.valore;
    $("#w-recency").value = STATE.settings.weights.recency;
    $("#set-firma").value = STATE.settings.firma || "";
    $("#set-wa-number").value = STATE.settings.waNumber || "";
  }

  function saveSettings() {
    STATE.settings.target = Number($("#set-target").value || 0);
    STATE.settings.conv = Number($("#set-conv").value || 0);
    STATE.settings.meetValue = Number($("#set-meet-value").value || 0);
    STATE.settings.weights = {
      dolore: Number($("#w-dolore").value || 0),
      urgenza: Number($("#w-urgenza").value || 0),
      valore: Number($("#w-valore").value || 0),
      recency: Number($("#w-recency").value || 0)
    };
    STATE.settings.firma = $("#set-firma").value || "";
    STATE.settings.waNumber = $("#set-wa-number").value || "";
    // rivalutiamo tutti i lead
    STATE.leads.forEach((l) => evaluateLead(l));
    persist();
    renderAll();
    toast("Impostazioni salvate", "success");
  }

  // ==========
  // IMPORT/CSV
  // ==========
  function exportCSV() {
    const headers = ["id","struttura","citta","referente","telefono","email","prodotto","valore","tag","nmedici","software","overbooking","visibilita","urgenza","status","createdAt","updatedAt"];
    const lines = [headers.join(",")];
    for (const l of STATE.leads) {
      const row = [
        l.id, l.struttura, l.citta, l.referente, l.telefono, l.email, l.prodotto,
        l.valore, (l.tag || []).join("|"), l.nmedici, l.software,
        l.overbooking ? 1 : 0, l.visibilita ? 1 : 0, l.urgenza ? 1 : 0,
        l.status, l.createdAt, l.updatedAt
      ].map(csvEscape).join(",");
      lines.push(row);
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "qpwon-leads.csv";
    a.click();
    URL.revokeObjectURL(url);
  }
  function csvEscape(v) {
    const s = String(v ?? "");
    if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }
  function importCSV(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result;
      const rows = parseCSV(text);
      const header = rows.shift()?.map((h) => h.trim().toLowerCase()) || [];
      const idx = (name) => header.indexOf(name);
      let count = 0;
      for (const r of rows) {
        if (!r || !r.length) continue;
        const payload = {
          struttura: r[idx("struttura")] || r[idx("nome")] || "",
          citta: r[idx("citta")] || r[idx("città")] || "",
          referente: r[idx("referente")] || "",
          telefono: r[idx("telefono")] || "",
          email: r[idx("email")] || "",
          prodotto: r[idx("prodotto")] || "",
          valore: r[idx("valore")] || 0,
          tag: (r[idx("tag")] || "").replace(/\|/g, ","),
          nmedici: r[idx("nmedici")] || 0,
          software: r[idx("software")] || "",
          overbooking: (r[idx("overbooking")] || "0") === "1",
          visibilita: (r[idx("visibilita")] || r[idx("visibilità")] || "0") === "1",
          urgenza: (r[idx("urgenza")] || "0") === "1",
        };
        if (!payload.struttura || !payload.citta) continue;
        // anti-duplicato: stessa struttura+città
        const dup = STATE.leads.find((l) => l.struttura.toLowerCase() === payload.struttura.toLowerCase() && l.citta.toLowerCase() === payload.citta.toLowerCase());
        if (dup) continue;
        const lead = newLead(payload);
        STATE.leads.push(lead);
        count++;
      }
      persist();
      renderAll();
      toast(`Importati ${count} lead`, "success");
    };
    reader.readAsText(file, "utf-8");
  }
  function parseCSV(text) {
    const rows = [];
    let cur = [];
    let inQuotes = false; let field = "";
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ",") { cur.push(field); field = ""; }
        else if (c === "\n" || c === "\r") {
          if (field || cur.length) { cur.push(field); rows.push(cur); cur = []; field = ""; }
        } else field += c;
      }
    }
    if (field || cur.length) { cur.push(field); rows.push(cur); }
    return rows;
  }

  // =============
  // COPY CLIPBOARD
  // =============
  function copyToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
  }

  // ============
  // EVENT WIRING
  // ============
  function wireUI() {
    // Tabs
    $$(".tabs .tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

    // Search today
    $("#search-today").addEventListener("input", renderToday);

    // Toolbar
    $("#btn-new-lead").addEventListener("click", () => {
      $("#form-new-lead").reset();
      openDialog("modal-new-lead");
    });
    $("#btn-import").addEventListener("click", () => $("#file-import").click());
    $("#btn-export").addEventListener("click", exportCSV);
    $("#file-import").addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (f) importCSV(f);
      e.target.value = "";
    });
    $("#btn-clear-data").addEventListener("click", () => {
      if (confirm("Sicuro di voler svuotare tutti i lead?")) {
        STATE.leads = [];
        persist();
        renderAll();
      }
    });

    // New lead modal
    $("#btn-create-lead").addEventListener("click", (e) => {
      e.preventDefault();
      const form = $("#form-new-lead");
      const data = Object.fromEntries(new FormData(form).entries());
      if (!data.struttura || !data.citta) {
        toast("Struttura e Città sono obbligatorie", "danger");
        return;
      }
      data.overbooking = !!data.overbooking;
      data.visibilita = !!data.visibilita;
      data.urgenza = !!data.urgenza;
      // anti-duplicato
      const dup = STATE.leads.find((l) => l.struttura.toLowerCase() === data.struttura.toLowerCase() && l.citta.toLowerCase() === data.citta.toLowerCase());
      if (dup) {
        toast("Lead già presente (stessa struttura e città)", "danger");
        return;
      }
      const lead = newLead(data);
      STATE.leads.push(lead);
      persist();
      closeDialog("modal-new-lead");
      renderAll();
      openLead(lead.id);
      toast("Lead creato", "success");
    });

    // Focus strip & Action Dock
    $("#btn-nba").addEventListener("click", () => {
      const lead = STATE.leads.find((x) => x.id === STATE.ui.selectedLeadId);
      if (!lead) return;
      const nba = nextBestAction(lead);
      if (nba.action === "proponi") proposeSlots();
      if (nba.action === "tiepidize") {
        openEmailForLead(lead);
        quickSetRecall(lead);
      }
      if (nba.action === "freddo") {
        openWAForLead(lead);
        // recall 7gg
        lead.timeline.push({ type: "recall", at: Date.now(), when: Date.now() + 7 * 86400000 });
        persist();
        renderAll();
      }
      if (nba.action === "fix-data") {
        alert("Completa telefono o email del lead per procedere.");
      }
    });

    $("#slot-1").addEventListener("click", () => { const l = currentLead(); if (l) { openDialog("modal-slots"); } });
    $("#slot-2").addEventListener("click", () => { const l = currentLead(); if (l) { openDialog("modal-slots"); } });

    $("#btn-proponi").addEventListener("click", proposeSlots);
    $("#btn-email").addEventListener("click", () => { const l = currentLead(); if (l) openEmailForLead(l); });
    $("#btn-whatsapp").addEventListener("click", () => { const l = currentLead(); if (l) openWAForLead(l); });
    $("#btn-recall").addEventListener("click", () => { const l = currentLead(); if (l) quickSetRecall(l); });

    // Preview area
    $("#btn-wa-clean").addEventListener("click", () => {
      const txt = $("#preview-wa").value;
      $("#preview-wa").value = sanitizeText(txt, 700);
      toast("Messaggio pulito/accorciato", "success");
    });
    $("#btn-wa-insert-case").addEventListener("click", () => {
      const key = prompt("Inserisci case: proxima / rms / checkup", "proxima");
      const cs = STATE.cases[key?.toLowerCase()];
      if (!cs) return;
      $("#preview-wa").value += "\n\n" + cs.snippet_wa;
    });

    $("#btn-copy-email").addEventListener("click", () => {
      copyToClipboard($("#preview-email-body").value || "");
      toast("Email copiata", "success");
    });
    $("#btn-copy-wa").addEventListener("click", () => {
      copyToClipboard($("#preview-wa").value || "");
      toast("WhatsApp copiato", "success");
    });

    // Save notes
    $("#btn-save-notes").addEventListener("click", () => {
      const l = currentLead();
      if (!l) return;
      l.note = $("#lead-notes").value;
      l.updatedAt = Date.now();
      l.timeline.push({ type: "note", at: Date.now() });
      persist();
      toast("Note salvate", "success");
    });

    // Email modal
    $("#open-gmail").addEventListener("click", () => {
      const l = currentLead();
      const subj = $("#email-subject").value || "Proposta breve";
      const bodyRaw = $("#email-body").value || "";
      const firma = STATE.settings.firma ? `\n\n${STATE.settings.firma}` : "";
      const body = sanitizeText(bodyRaw + firma, 1800);
      const url = encodeGmailUrl({ to: l?.email || "", subject: subj, body });
      const w = openWinOrPopupWarn(url);
      if (w) {
        l.timeline.push({ type: "email", at: Date.now() });
        persist();
        closeDialog("modal-email");
      }
    });

    // WhatsApp modal
    $("#wa-clean").addEventListener("click", () => {
      const txt = $("#wa-text").value;
      $("#wa-text").value = sanitizeText(txt, 700);
      toast("Messaggio pulito/accorciato", "success");
    });
    $("#wa-insert-case").addEventListener("click", () => {
      const key = prompt("Inserisci case: proxima / rms / checkup", "checkup");
      const cs = STATE.cases[key?.toLowerCase()];
      if (!cs) return;
      $("#wa-text").value += "\n\n" + cs.snippet_wa;
    });
    $("#open-wa").addEventListener("click", () => {
      const l = currentLead();
      if (!l) return;
      let phone = l.telefono || STATE.settings.waNumber || "";
      if (!validPhone(phone)) {
        const suggested = ensurePrefixIT(phone);
        const ask = confirm(`Numero non completo. Aggiungere prefisso? \n\n${phone} → ${suggested}`);
        if (ask) {
          phone = suggested;
          l.telefono = phone;
        } else {
          toast("Numero non valido", "danger");
          return;
        }
      }
      const text = sanitizeText($("#wa-text").value + (STATE.settings.firma ? `\n\n${STATE.settings.firma}` : ""), 900);
      const waLink = "https://wa.me/" + phone.replace(/\D/g, "") + "?text=" + encodeURIComponent(text);
      const w = openWinOrPopupWarn(waLink);
      if (w) {
        l.timeline.push({ type: "wa", at: Date.now() });
        persist();
        closeDialog("modal-wa");
      }
    });

    // Modal close buttons (generic)
    $$("dialog [data-close], dialog button[aria-label='Chiudi']").forEach((b) => {
      b.addEventListener("click", () => closeDialog(b.closest("dialog").id));
    });

    // Settings
    $("#btn-wa-web").addEventListener("click", () => openWinOrPopupWarn("https://web.whatsapp.com"));
    $("#btn-wa-test").addEventListener("click", () => {
      const n = ensurePrefixIT($("#set-wa-number").value);
      if (!validPhone(n)) { toast("Inserisci un numero valido", "danger"); return; }
      const text = encodeURIComponent("Messaggio di test da QPWONCall.");
      openWinOrPopupWarn("https://wa.me/" + n.replace(/\D/g, "") + "?text=" + text);
    });
    $("#btn-save-settings").addEventListener("click", saveSettings);

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if (e.target.matches("input, textarea")) return;
      if (e.key.toLowerCase() === "n") { $("#btn-new-lead").click(); }
      if (e.key.toLowerCase() === "a") { $("#btn-proponi").click(); }
      if (e.key.toLowerCase() === "e") { $("#btn-email").click(); }
      if (e.key.toLowerCase() === "w") { $("#btn-whatsapp").click(); }
      if (e.key.toLowerCase() === "r") { $("#btn-recall").click(); }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        // scorri lead (semplice: tra quelli in Oggi)
        const ids = STATE.leads.filter((l) => l.status === "todo" || l.status === "doing").map((l) => l.id);
        if (!ids.length) return;
        const idx = Math.max(0, ids.indexOf(STATE.ui.selectedLeadId));
        const nextIdx = e.key === "ArrowRight" ? Math.min(idx + 1, ids.length - 1) : Math.max(idx - 1, 0);
        const nextId = ids[nextIdx];
        if (nextId && nextId !== STATE.ui.selectedLeadId) openLead(nextId);
      }
    });
  }

  function currentLead() {
    return STATE.leads.find((x) => x.id === STATE.ui.selectedLeadId) || null;
  }

  function renderAll() {
    updateKPI();
    renderToday();
    renderOneLead();
    renderPipeline();
  }

  // ====================
  // DEFAULT TEMPLATES
  // ====================
  function defaultTemplates() {
    return {
      freddo: {
        subject: "{struttura} — 15’ per agenda unica e chiamate tracciate",
        email:
`Ciao {referente},
lavoro con poliambulatori come {struttura} su tre fronti: prenotazioni online, agenda unica e riduzione di chiamate perse.
Se ti va, fissiamo 15 minuti per capire se ha senso: {slot1} o {slot2}.
{firma}`,
        wa:
`Ciao {referente}, sono Alfonso (Docplanner/MioDottore). Aiutiamo centri come {struttura} su prenotazioni e CRM. 15’ per capirlo: {slot1} o {slot2}?`
      },
      tiepido: {
        subject: "Proposta breve + 2 slot",
        email:
`Ciao {referente},
in centri simili a {struttura} abbiamo centralizzato le agende e recuperato prenotazioni perse. In media, +20–30 appuntamenti/mese.
Ti propongo 15’: {slot1} / {slot2}. In alternativa, dimmi tu.
{firma}`,
        wa:
`Ciao {referente}, su strutture come {struttura} riduciamo del 30–40% le chiamate perse e allineiamo le agende. 15’: {slot1} o {slot2}?`
      },
      caldo: {
        subject: "Allineamento rapido + attivazione",
        email:
`Ciao {referente},
obiettivo: prenotazioni tracciate in agenda unica e messaggistica ai pazienti da subito. Ti propongo {slot1} o {slot2} per allinearci e definire attivazione.
{firma}`,
        wa:
`Ciao {referente}, breve allineamento e fissiamo l’attivazione. Ti va {slot1} o {slot2}?`
      }
    };
  }

  // =================
  // DEFAULT CASES
  // =================
  function defaultCases() {
    return {
      proxima: {
        title: "Proxima — Integrazione & h24",
        one_liner: "Colleghi clinico-gestionale e apri prenotazioni anche quando siete chiusi.",
        snippet_email:
`Caso simile a Proxima: integrazione GipoNext + MioDottore (agenda condivisa, messaggistica, promemoria).
Risultati: ~4.500 prenotazioni/anno, ~35% fuori orario, >400 recensioni.`,
        snippet_wa:
`Esempio Proxima: GipoNext + MioDottore (agenda unica, messaggi, promemoria). ~4.500 pren/anno, ~35% fuori orario, >400 recensioni.`
      },
      rms: {
        title: "RMS Polimedical — Visibilità & nuovi pazienti",
        one_liner: "Catalogo prestazioni + reputazione = nuovi pazienti che prenotano da soli.",
        snippet_email:
`Caso RMS: profilo centro + prestazioni prenotabili. Risultati: 13% pazienti nuovi online, reputazione 5/5, oltre 60 prestazioni visibili.`,
        snippet_wa:
`RMS: prestazioni prenotabili + reputazione 5/5 → 13% pazienti nuovi dal canale online.`
      },
      checkup: {
        title: "Check Up Centre — Segreteria & chiamate",
        one_liner: "Centralino smart = pazienti seguiti meglio e segreteria più leggera.",
        snippet_email:
`Caso Check Up: MioDottore Phone per tracciare/recuperare chiamate, riascolto e statistiche. Risultati: ~1% no-show, >1.400 recensioni.`,
        snippet_wa:
`Check Up: con MioDottore Phone recuperano le chiamate e tengono bassa l’assenza (~1% no-show) con controllo qualità.`
      }
    };
  }

  // =================
  // BOOTSTRAP APP
  // =================
  function init() {
    loadState();

    // Se non ci sono lead, nessun seed forzato (ambiente reale).
    // Render iniziale
    wireUI();
    switchTab(STATE.ui.tab || "oggi");
    renderAll();
    renderLibrary(); // per assicurare i bottoni libreria
  }

  document.addEventListener("DOMContentLoaded", init);
})();
