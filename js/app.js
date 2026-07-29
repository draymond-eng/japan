/* =============================================================================
   Japan 2027 — app logic. Vanilla JS, no build step. State saved on-device
   via localStorage (per phone). Renders every screen from window.TRIP.
   ========================================================================== */
(function () {
  "use strict";
  const T = window.TRIP;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const byId = (id) => T.travelers.find((t) => t.id === id);
  const initials = (name) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  // Avatar: use a photo if the traveler has one, else a colored initials tile.
  const avatarBg = (t) => t.photo ? `background-image:url('${t.photo}')` : `background:${t.color}`;
  const avatarTxt = (t) => t.photo ? "" : initials(t.name);

  /* ---- Local persistence ------------------------------------------------- */
  const LS = {
    get(k, d) { try { return JSON.parse(localStorage.getItem("jp27_" + k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("jp27_" + k, JSON.stringify(v)); } catch {} },
  };
  // Backend sync status. Flips to true once a shared backend is wired in;
  // until then everything persists per-device via localStorage.
  const SYNC = { on: false, configured: false };
  const state = {
    me: LS.get("me", null),
    packing: LS.get("packing", {}),
    decisions: LS.get("decisions", {}), // {decisionId: optionId}
    stayVotes: LS.get("stayVotes", {}), // {city: optionId}
    ideas: LS.get("ideas", {}),         // {ideaId: true}
    bookingLocal: LS.get("bookingLocal", {}), // {bookingId: true} (local fallback)
    expenses: LS.get("expenses", []),
    cityFilter: "all",
    // Shared (populated from the backend when SYNC.on):
    allVotes: [],       // [{kind, topic, choice, voter}]
    postedIdeas: LS.get("postedIdeas", []), // group-submitted ideas (local until synced)
    postedDecisions: LS.get("postedDecisions", []), // group-submitted decisions
    proposedStays: LS.get("proposedStays", []), // group-proposed hotels {id,city,name,tag,note,author}
    flights: LS.get("flightsLocal", []), // {traveler, dir, airline, flight_no, airport, date, time, note}
    photos: [],         // uploaded trip photos
  };
  const save = () => {
    LS.set("me", state.me); LS.set("packing", state.packing);
    LS.set("decisions", state.decisions); LS.set("stayVotes", state.stayVotes);
    LS.set("ideas", state.ideas); LS.set("expenses", state.expenses);
  };

  /* =======================================================================
     SYNC — shared data via the backend (Supabase). Degrades to local mode.
     ==================================================================== */
  const Sync = {
    async init() {
      const cfg = window.SUPABASE_CONFIG || {};
      SYNC.configured = !!(cfg.url && cfg.anonKey);
      if (!SYNC.configured) { renderAll(); return; } // genuinely local (no keys)
      renderAll(); // reflect "syncing…" copy immediately
      // The Supabase SDK loads from a CDN — wait for it instead of giving up.
      for (let i = 0; i < 30 && !(window.supabase && window.supabase.createClient); i++) {
        await new Promise((r) => setTimeout(r, 150));
      }
      if (!window.Backend || !Backend.init()) { renderAll(); return; } // configured but SDK failed
      SYNC.on = true;
      await Sync.hydrate("all");
      Backend.subscribe(async (table) => { await Sync.hydrate(table); renderCurrent(); });
      renderAll();
    },
    async hydrate(table) {
      if (!SYNC.on) return;
      const jobs = [];
      if (table === "all" || table === "votes")    jobs.push(Backend.fetchVotes().then((v) => state.allVotes = v));
      if (table === "all" || table === "expenses") jobs.push(Backend.fetchExpenses().then((rows) => {
        state.expenses = rows.map((r) => ({ id: r.id, label: r.label, amount: Number(r.amount), currency: r.currency, paidBy: r.paid_by, splitAmong: r.split_among || [] }));
      }));
      if (table === "all" || table === "ideas")    jobs.push(Backend.fetchIdeas().then((i) => state.postedIdeas = i));
      if (table === "all" || table === "decisions")jobs.push(Backend.fetchDecisions().then((d) => state.postedDecisions = d));
      if (table === "all" || table === "stay_options") jobs.push(Backend.fetchStayOptions().then((s) => state.proposedStays = s));
      if (table === "all" || table === "flights")  jobs.push(Backend.fetchFlights().then((f) => state.flights = f));
      if (table === "all" || table === "photos")   jobs.push(Backend.fetchPhotos().then((p) => state.photos = p));
      await Promise.all(jobs);
    },
  };

  // ---- Unified vote model (works in both shared and local mode) -----------
  // kind: 'decision' | 'stay' | 'idea'   choice: option id (or 'up' for ideas)
  function myVote(kind, topic) {
    if (SYNC.on) {
      const r = state.allVotes.find((v) => v.kind === kind && v.topic === topic && v.voter === state.me);
      return r ? r.choice : null;
    }
    if (kind === "decision") return state.decisions[topic] || null;
    if (kind === "stay") return state.stayVotes[topic] || null;
    if (kind === "idea") return state.ideas[topic] ? "up" : null;
    if (kind === "booking") return state.bookingLocal[topic] ? "done" : null;
    return null;
  }
  function tally(kind, topic) {
    const m = {};
    if (SYNC.on) {
      state.allVotes.filter((v) => v.kind === kind && v.topic === topic)
        .forEach((v) => { (m[v.choice] = m[v.choice] || []).push(v.voter); });
    } else {
      const c = myVote(kind, topic);
      if (c && state.me) m[c] = [state.me];
    }
    return m;
  }
  async function setVote(kind, topic, choice) {
    if (!state.me) { openWho(); return; }
    const cur = myVote(kind, topic);
    const next = cur === choice ? null : choice;
    if (SYNC.on) {
      state.allVotes = state.allVotes.filter((v) => !(v.kind === kind && v.topic === topic && v.voter === state.me));
      if (next != null) state.allVotes.push({ kind, topic, choice: next, voter: state.me });
      renderCurrent();
      await Backend.castVote(kind, topic, next, state.me);
    } else {
      if (kind === "decision") state.decisions[topic] = next || undefined;
      else if (kind === "stay") state.stayVotes[topic] = next || undefined;
      else if (kind === "idea") { if (next) state.ideas[topic] = true; else delete state.ideas[topic]; }
      else if (kind === "booking") { if (next) state.bookingLocal[topic] = true; else delete state.bookingLocal[topic]; LS.set("bookingLocal", state.bookingLocal); }
      save(); renderCurrent();
      if (map && markerLayer && kind === "stay") drawPins();
    }
  }
  // Small avatar chips for a list of voter ids.
  function voterChips(voterIds) {
    return (voterIds || []).map((id) => {
      const t = byId(id); if (!t) return "";
      return `<span class="avatar vchip" style="${avatarBg(t)}" title="${esc(t.name)}">${avatarTxt(t)}</span>`;
    }).join("");
  }

  /* ---- Type metadata ----------------------------------------------------- */
  const TYPE = {
    travel:   { emoji: "🚆", color: "#c99a2e", label: "Travel" },
    sight:    { emoji: "⛩️", color: "#2f5680", label: "Sight" },
    food:     { emoji: "🍜", color: "#e4573d", label: "Food" },
    activity: { emoji: "🎏", color: "#7a8c5a", label: "Activity" },
    rest:     { emoji: "♨️", color: "#e79fb0", label: "Rest" },
    meet:     { emoji: "📍", color: "#e4573d", label: "Meetup" },
  };
  const cityName = (id) => (T.cities.find((c) => c.id === id) || { name: id }).name;
  const fmtDate = (iso) => {
    const d = new Date(iso + "T12:00:00");
    return { day: d.getDate(), mon: d.toLocaleString("en-US", { month: "short" }),
             wd: d.toLocaleString("en-US", { weekday: "short" }) };
  };

  /* =======================================================================
     NAVIGATION
     ==================================================================== */
  function show(screen) {
    $$(".screen").forEach((s) => s.classList.remove("active"));
    const el = $("#screen-" + screen);
    if (el) el.classList.add("active");
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.screen === screen));
    // Keep "More" tab highlighted when a sheet screen is active
    const primary = ["home", "itinerary", "map", "crew"];
    if (!primary.includes(screen)) $("#moreTab").classList.add("active");
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
    closeSheet();
    if (screen === "map") initMap();
  }
  $$(".tab[data-screen]").forEach((t) => t.addEventListener("click", () => show(t.dataset.screen)));
  $$(".sheet-item").forEach((t) => t.addEventListener("click", () => show(t.dataset.screen)));

  const openSheet = () => { $("#moreSheet").classList.add("open"); $("#sheetBackdrop").classList.add("open"); };
  const closeSheet = () => { $("#moreSheet").classList.remove("open"); $("#sheetBackdrop").classList.remove("open"); };
  $("#moreTab").addEventListener("click", openSheet);
  $("#sheetBackdrop").addEventListener("click", closeSheet);

  /* =======================================================================
     HOME
     ==================================================================== */
  function renderHome() {
    const s = $("#screen-home");
    const openDecisions = T.decisions.filter((d) => d.status !== "decided").length;
    s.innerHTML = `
      <div class="hero">
        <div class="sun"></div>
        <div class="kicker">April 2027 · 六人の旅</div>
        <h1>${esc(T.meta.title)}</h1>
        <div class="dates">Thu Apr 15 – Sun Apr 25 · ${T.meta.nights} nights on the ground</div>
        <div class="cities-row">
          ${T.cities.map((c) => `<span class="city-chip">${c.emoji} ${esc(c.name)}</span>`).join("")}
        </div>
      </div>

      ${T.meta.draft ? `<div class="card" style="border-color:var(--sakura-deep);background:#fdf3f5">
        <span class="pill draft">Proposed baseline</span>
        <p style="margin:10px 0 0;font-size:13.5px;color:var(--ink-soft)">
          Nothing's locked — this is a starting point for the group to react to.
          Weigh in on the <b>${openDecisions} open decision${openDecisions === 1 ? "" : "s"}</b> before we meet about the itinerary.
        </p>
        <button class="btn primary" style="margin-top:12px;width:100%" data-go="decisions">🗳️ Cast your votes</button>
      </div>` : ""}

      ${(() => {
        const nowItems = T.bookingOrder.filter((b) => (b.timing || "later") === "now");
        const unbooked = nowItems.filter((b) => !(tally("booking", b.id)["done"] || []).length);
        if (!unbooked.length) return "";
        return `<div class="card" style="border-color:#e2ad55;background:#fdf6ea">
          <div style="display:flex;align-items:center;gap:9px"><span style="font-size:20px">⚠️</span>
            <b style="font-size:15px">${unbooked.length} thing${unbooked.length === 1 ? "" : "s"} to book now</b></div>
          <p style="margin:8px 0 0;font-size:13px;color:var(--ink-2)">${unbooked.map((b) => esc(b.label.replace(/\s*\(.*\)/, ""))).join(" · ")}</p>
          <button class="btn primary" style="margin-top:12px;width:100%" data-go="booking">📋 Open the booking timeline</button>
        </div>`;
      })()}

      <div class="countdown" id="countdown"></div>

      <div class="clocks" id="clocks"></div>

      <div class="section-title" style="margin-top:20px">The crew</div>
      <div class="card">
        <div class="crew-strip">
          ${T.travelers.map((t, i) => `<div class="avatar stack" style="${avatarBg(t)}" title="${esc(t.name)}">${avatarTxt(t)}</div>`).join("")}
        </div>
        <p style="margin:12px 0 0;font-size:13px;color:var(--ink-soft)">
          6 travelers · 3 couples${T.meta.showPrices ? " · ≈ $" + T.meta.estGroup.toLocaleString() + " group / $" + T.meta.estPerPerson.toLocaleString() + " per person" : ""}
        </p>
      </div>

      <div class="section-title">At a glance</div>
      <div class="quick-grid">
        <button class="quick-tile" data-go="itinerary"><div class="qi">🗓️</div><div class="qt">Itinerary</div><div class="qs">11 days, day-by-day</div></button>
        <button class="quick-tile" data-go="map"><div class="qi">🗺️</div><div class="qt">Map</div><div class="qs">Every stop pinned</div></button>
        <button class="quick-tile" data-go="stays"><div class="qi">🏨</div><div class="qt">Stays</div><div class="qs">Vote on hotels</div></button>
        <button class="quick-tile" data-go="budget"><div class="qi">💰</div><div class="qt">Budget</div><div class="qs">Split & settle up</div></button>
        <button class="quick-tile" data-go="packing"><div class="qi">🧳</div><div class="qt">Packing</div><div class="qs">April layers list</div></button>
        <button class="quick-tile" data-go="guide"><div class="qi">📖</div><div class="qt">Japan Guide</div><div class="qs">The FAQ, answered</div></button>
      </div>

      <div class="card" style="margin-top:16px">
        <h3>⚠️ Golden Week wall</h3>
        <p style="margin:0;font-size:13px;color:var(--ink-soft)">${esc(T.meta.goldenWeekWarning)}</p>
      </div>

      <div class="foot-note">Built as a baseline for the group · edit anytime</div>
    `;
    s.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => show(b.dataset.go)));
    renderClocks();
    tickCountdown();
  }

  function tickCountdown() {
    const box = $("#countdown");
    if (!box) return;
    const target = new Date(T.meta.departUS + "T08:00:00");
    const now = new Date();
    let diff = Math.max(0, target - now);
    const day = Math.floor(diff / 86400000); diff -= day * 86400000;
    const hr = Math.floor(diff / 3600000); diff -= hr * 3600000;
    const mn = Math.floor(diff / 60000); diff -= mn * 60000;
    const sc = Math.floor(diff / 1000);
    const cells = [[day, "Days"], [hr, "Hours"], [mn, "Min"], [sc, "Sec"]];
    box.innerHTML = (now >= target)
      ? `<div class="count-box" style="grid-column:1/-1"><div class="num">🎌 We're in Japan!</div></div>`
      : cells.map(([n, l]) => `<div class="count-box"><div class="num">${n}</div><div class="lbl">${l}</div></div>`).join("");
  }
  setInterval(() => { if ($("#screen-home").classList.contains("active")) tickCountdown(); }, 1000);

  function renderClocks() {
    const box = $("#clocks");
    if (!box) return;
    const fmt = (tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date());
    box.innerHTML = `
      <div class="clock"><div class="place">Home (Chicago)</div><div class="time">${fmt(T.meta.homeTimezone)}</div></div>
      <div class="clock"><div class="place">🗾 Tokyo</div><div class="time">${fmt(T.meta.tripTimezone)}</div></div>`;
  }
  setInterval(() => { if ($("#screen-home").classList.contains("active")) renderClocks(); }, 15000);

  /* =======================================================================
     ITINERARY
     ==================================================================== */
  function renderItinerary() {
    const s = $("#screen-itinerary");
    const filters = ["all", ...T.cities.map((c) => c.id)];
    s.innerHTML = `
      <div class="section-title">Itinerary</div>
      <div class="section-sub">Proposed day-by-day — tap a day to expand. Everything's open for discussion.</div>
      <div class="filters" id="itinFilters">
        ${filters.map((f) => `<button class="chip ${f === state.cityFilter ? "active" : ""}" data-city="${f}">${f === "all" ? "All" : cityName(f)}</button>`).join("")}
      </div>
      <div id="dayList"></div>`;
    s.querySelectorAll("#itinFilters .chip").forEach((c) => c.addEventListener("click", () => {
      state.cityFilter = c.dataset.city; renderDayList();
      s.querySelectorAll("#itinFilters .chip").forEach((x) => x.classList.toggle("active", x === c));
    }));
    renderDayList();
  }
  function renderDayList() {
    const list = $("#dayList");
    const days = T.days.filter((d) => state.cityFilter === "all" || d.city === state.cityFilter);
    list.innerHTML = days.map((d, idx) => {
      const f = fmtDate(d.date);
      const items = d.items.map((it) => {
        const tm = TYPE[it.type] || TYPE.sight;
        const map = it.lat ? `<a class="tl-map" href="https://www.google.com/maps/search/?api=1&query=${it.lat},${it.lng}" target="_blank" rel="noopener">📍 Map</a>` : "";
        return `<div class="tl-item ${it.type}">
          ${it.time ? `<div class="tl-time">${esc(it.time)}</div>` : ""}
          <div class="tl-title"><span class="type-emoji">${tm.emoji}</span>${esc(it.title)}</div>
          ${it.note ? `<div class="tl-note">${esc(it.note)}</div>` : ""}
          ${map}
        </div>`;
      }).join("");
      return `<div class="day" data-day="${idx}">
        <div class="day-head">
          <div class="day-date"><div class="d">${f.day}</div><div class="m">${f.wd} ${f.mon}</div></div>
          <div class="info"><div class="t">${esc(d.title)} <span class="pill ${d.city}">${cityName(d.city)}</span></div>
            <div class="s">${esc(d.summary)}</div></div>
          <div class="caret">▶</div>
        </div>
        <div class="day-body">
          ${d.meetup ? `<div class="meetup">📍 <span>Meetup: ${esc(d.meetup)}</span></div>` : ""}
          <div class="timeline">${items}</div>
        </div>
      </div>`;
    }).join("");
    list.querySelectorAll(".day-head").forEach((h) => h.addEventListener("click", () => h.parentElement.classList.toggle("open")));
    // open the first day by default
    const first = list.querySelector(".day"); if (first) first.classList.add("open");
  }

  /* =======================================================================
     MAP (Leaflet)
     ==================================================================== */
  let map = null, markerLayer = null, mapFilter = "all";
  function collectPins() {
    const pins = [];
    T.stays.forEach((st) => {
      // Pin the group's chosen option for this city, else the suggested/first one.
      const chosenId = myVote("stay", st.city);
      const merged = [...st.options, ...state.proposedStays.filter((p) => p.city === st.city)];
      const opt = merged.find((o) => o.id === chosenId) || st.options.find((o) => o.recommended) || st.options[0];
      if (opt && opt.lat) pins.push({ lat: opt.lat, lng: opt.lng, city: st.city, type: "stay", title: opt.name, note: st.label + " · " + (opt.tag || "") });
    });
    T.days.forEach((d) => d.items.forEach((it) => {
      if (it.lat) pins.push({ lat: it.lat, lng: it.lng, city: d.city, type: it.type, title: it.title, note: it.note });
    }));
    return pins;
  }
  function renderMapFallback() {
    const s = $("#screen-map");
    s.innerHTML = `
      <div class="section-title">Places</div>
      <div class="section-sub">The live map needs a connection — here's every pinned stop, by city. Tap any to open in Maps.</div>
      ${T.cities.map((c) => {
        const pins = collectPins().filter((p) => p.city === c.id);
        return `<div class="card"><h3>${c.emoji} ${esc(c.name)}</h3>
          ${pins.map((p) => {
            const emoji = p.type === "stay" ? "🏨" : (TYPE[p.type] || TYPE.sight).emoji;
            return `<a class="row" style="text-decoration:none;color:inherit" href="https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}" target="_blank" rel="noopener">
              <span style="font-size:18px">${emoji}</span>
              <div class="r-main"><div class="r-title">${esc(p.title)}</div><div class="r-sub">${esc(p.note || "")}</div></div>
              <span class="tl-map">📍</span></a>`;
          }).join("")}
        </div>`;
      }).join("")}`;
  }
  function initMap() {
    if (typeof L === "undefined") { renderMapFallback(); return; }
    if (map) { setTimeout(() => map.invalidateSize(), 60); return; }
    const s = $("#screen-map");
    s.innerHTML = `
      <div class="section-title">Map</div>
      <div class="filters" id="mapFilters">
        <button class="chip active" data-city="all">All Japan</button>
        ${T.cities.map((c) => `<button class="chip" data-city="${c.id}">${esc(c.name)}</button>`).join("")}
      </div>
      <div id="map"></div>
      <div class="map-legend">
        <span><i class="dot" style="background:#1c1c1e"></i> Stay</span>
        ${Object.entries(TYPE).map(([k, v]) => `<span><i class="dot" style="background:${v.color}"></i> ${v.label}</span>`).join("")}
      </div>`;
    map = L.map("map", { scrollWheelZoom: false }).setView([35.4, 137.5], 6);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "© OpenStreetMap",
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    s.querySelectorAll("#mapFilters .chip").forEach((c) => c.addEventListener("click", () => {
      mapFilter = c.dataset.city;
      s.querySelectorAll("#mapFilters .chip").forEach((x) => x.classList.toggle("active", x === c));
      drawPins();
    }));
    drawPins();
    setTimeout(() => map.invalidateSize(), 80);
  }
  function drawPins() {
    if (!markerLayer) return;
    markerLayer.clearLayers();
    const pins = collectPins().filter((p) => mapFilter === "all" || p.city === mapFilter);
    const bounds = [];
    pins.forEach((p) => {
      const color = p.type === "stay" ? "#1c1c1e" : (TYPE[p.type] || TYPE.sight).color;
      const emoji = p.type === "stay" ? "🏨" : (TYPE[p.type] || TYPE.sight).emoji;
      const icon = L.divIcon({ className: "", html: `<div style="width:26px;height:26px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${color};border:2px solid #fff;box-shadow:0 2px 5px rgba(0,0,0,.35);display:grid;place-items:center"><span style="transform:rotate(45deg);font-size:12px">${emoji}</span></div>`, iconSize: [26, 26], iconAnchor: [13, 24], popupAnchor: [0, -22] });
      const m = L.marker([p.lat, p.lng], { icon }).addTo(markerLayer);
      m.bindPopup(`<div class="pin-pop"><b>${esc(p.title)}</b><br><span class="pp-note">${esc(p.note || "")}</span></div>`);
      bounds.push([p.lat, p.lng]);
    });
    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: mapFilter === "all" ? 7 : 14 });
  }

  /* =======================================================================
     CREW
     ==================================================================== */
  function renderCrew() {
    const s = $("#screen-crew");
    const pairs = [...new Set(T.travelers.map((t) => t.pair))];
    s.innerHTML = `
      <div class="section-title">The crew</div>
      <div class="section-sub">6 travelers · 3 couples. Tap "Who are you?" up top to tag yourself.</div>
      ${pairs.map((p) => {
        const people = T.travelers.filter((t) => t.pair === p);
        return `<div class="pair-card">
          <div class="pair-name">${esc(p)}</div>
          ${people.map((t) => `<div class="person">
            <div class="avatar lg" style="${avatarBg(t)}">${avatarTxt(t)}</div>
            <div class="p-info"><div class="p-name">${esc(t.name)}${state.me === t.id ? '<span class="badge-you">YOU</span>' : ""}</div>
              ${t.dietary ? `<div class="p-sub">🥗 ${esc(t.dietary)}</div>` : ""}</div>
            <div class="p-meta">${t.from ? esc(t.from) : ""}</div>
          </div>`).join("")}
        </div>`;
      }).join("")}
      <div class="card">
        <h3>📋 Booking timeline</h3>
        <p class="section-sub" style="margin:2px 0 12px">What to book and when — now lives in its own tab.</p>
        <button class="btn primary" style="width:100%" data-go="booking">Open the Booking timeline</button>
      </div>`;
    s.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => show(b.dataset.go)));
  }

  /* =======================================================================
     BOOKING timeline (what to book, when — shared "booked" status)
     ==================================================================== */
  function renderBooking() {
    const s = $("#screen-booking");
    const buckets = [
      { key: "now",   title: "Book now", sub: "Limited inventory — these reward moving early.", pill: "osaka" },
      { key: "soon",  title: "Coming up", sub: "Opens in the next few months — get it on the radar.", pill: "kyoto" },
      { key: "later", title: "Closer in", sub: "Can't be booked yet — opens ~30 days to a month before.", pill: "tokyo" },
    ];
    const doneCount = T.bookingOrder.filter((b) => (tally("booking", b.id)["done"] || []).length).length;
    s.innerHTML = `
      <div class="section-title">Booking timeline</div>
      <div class="section-sub">Japan books in waves. Tap ✓ when something's done — ${SYNC.on ? "everyone sees it." : SYNC.configured ? "syncing…" : "saved on this phone."} ${doneCount}/${T.bookingOrder.length} booked.</div>
      ${buckets.map((bk) => {
        const items = T.bookingOrder.filter((b) => (b.timing || "later") === bk.key);
        if (!items.length) return "";
        return `<div style="margin-bottom:22px">
          <div style="display:flex;align-items:center;gap:9px;margin:0 2px 3px">
            <span class="pill ${bk.pill}">${bk.title}</span>
          </div>
          <div class="section-sub" style="margin:4px 2px 12px">${bk.sub}</div>
          ${items.map((b) => {
            const bookers = tally("booking", b.id)["done"] || [];
            const done = bookers.length > 0;
            return `<div class="card" style="${done ? "opacity:.72" : ""}">
              <div style="display:flex;align-items:flex-start;gap:12px">
                <button class="book-check ${done ? "on" : ""}" data-book="${b.id}" aria-label="Mark booked">${done ? "✓" : ""}</button>
                <div style="flex:1;min-width:0">
                  <div class="r-title" style="font-size:15px;${done ? "text-decoration:line-through" : ""}">${esc(b.label)}</div>
                  <div class="r-sub" style="margin-top:3px">${esc(b.note)}</div>
                  <div style="display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap">
                    <span class="when-chip">${esc(b.when || "")}</span>
                    ${bookers.length ? `<span class="tally">${voterChips(bookers)}<span class="tally-n">booked</span></span>` : ""}
                  </div>
                </div>
              </div>
            </div>`;
          }).join("")}
        </div>`;
      }).join("")}
      <div class="foot-note">Ask the app "what should we book now?" — the answer's up top. 🗾</div>`;
    s.querySelectorAll("[data-book]").forEach((b) => b.addEventListener("click", () => setVote("booking", b.dataset.book, "done")));
  }

  /* =======================================================================
     STAYS
     ==================================================================== */
  function renderStays() {
    const s = $("#screen-stays");
    s.innerHTML = `
      <div class="section-title">Where we sleep</div>
      <div class="section-sub">Nothing's booked — vote on a place for each stop, or propose your own. ${SYNC.on ? "Votes tally live." : SYNC.configured ? "Syncing…" : "<b>Local until the backend is connected.</b>"}</div>
      ${T.stays.map((st) => {
        const mine = myVote("stay", st.city);
        const counts = tally("stay", st.city);
        const options = [
          ...st.options.map((o) => ({ ...o, posted: false })),
          ...state.proposedStays.filter((p) => p.city === st.city).map((p) => ({ id: p.id, name: p.name, tag: p.tag || "Proposed", note: p.note || "", lat: p.lat, lng: p.lng, link: p.link, author: p.author, posted: true })),
        ];
        return `<div style="margin-bottom:26px">
          <div style="display:flex;align-items:center;gap:9px;margin:0 2px 3px">
            <span class="pill ${st.city}">${esc(st.label)}</span>
            <span style="font-size:11.5px;color:var(--ink-3);font-weight:800;letter-spacing:.3px">${esc(st.nights)}</span>
          </div>
          <div class="section-sub" style="margin:4px 2px 12px">${esc(st.note)}</div>
          ${options.map((o) => {
            const voters = counts[o.id] || [];
            const sel = mine === o.id;
            return `<button class="stay-opt ${sel ? "sel" : ""}" data-stay="${st.city}" data-opt="${o.id}">
              <div class="stay-opt-main">
                <div class="stay-opt-name">${esc(o.name)}${o.recommended ? '<span class="rec">Suggested</span>' : ""}${o.posted ? '<span class="rec" style="color:var(--ai-2);border-color:var(--ai-2)">Proposed</span>' : ""}</div>
                <div class="stay-opt-tag">${esc(o.tag)}</div>
                ${o.note ? `<div class="stay-opt-note">${esc(o.note)}</div>` : ""}
                <div style="display:flex;align-items:center;gap:14px;margin-top:8px;flex-wrap:wrap">
                  ${o.lat ? `<a class="tl-map" href="https://www.google.com/maps/search/?api=1&query=${o.lat},${o.lng}" target="_blank" rel="noopener" onclick="event.stopPropagation()">📍 Map</a>` : ""}
                  ${o.link ? `<a class="tl-map" href="${esc(o.link)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">🔗 Link</a>` : ""}
                  ${o.posted && o.author === state.me ? `<span class="tl-map" style="color:var(--vermilion)" data-staydel="${o.id}">Remove</span>` : ""}
                </div>
                ${voters.length ? `<div class="tally" style="margin-top:8px">${voterChips(voters)}<span class="tally-n">${voters.length} vote${voters.length === 1 ? "" : "s"}</span></div>` : ""}
              </div>
              <div class="stay-check">${sel ? "◉" : "◯"}</div>
            </button>`;
          }).join("")}
          <button class="btn ghost" data-proposecity="${st.city}" style="width:100%;margin-top:2px">+ Propose a place in ${esc(st.label)}</button>
        </div>`;
      }).join("")}
      <div id="proposeForm"></div>`;
    s.querySelectorAll("[data-opt]").forEach((b) => b.addEventListener("click", () => setVote("stay", b.dataset.stay, b.dataset.opt)));
    s.querySelectorAll("[data-staydel]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); removeProposedStay(b.dataset.staydel); }));
    s.querySelectorAll("[data-proposecity]").forEach((b) => b.addEventListener("click", () => openProposeStay(b.dataset.proposecity)));
  }
  function openProposeStay(city) {
    const st = T.stays.find((x) => x.city === city);
    $("#proposeForm").innerHTML = `<div class="card" style="border-color:var(--ai)">
      <h3>Propose a place in ${esc(st.label)}</h3>
      <div class="expense-add">
        <input id="psName" placeholder="Hotel / place name" />
        <input id="psTag" placeholder="Vibe (e.g. Boutique hotel)" />
        <input id="psNote" placeholder="Why it's good (optional)" />
        <input id="psLink" placeholder="Link (optional)" />
        <button class="btn primary" id="psAdd">Add to ${esc(st.label)}</button>
      </div>
    </div>`;
    $("#psAdd").addEventListener("click", () => addProposedStay(city));
    $("#proposeForm").scrollIntoView({ behavior: "smooth", block: "center" });
  }
  async function addProposedStay(city) {
    const name = $("#psName").value.trim(); if (!name) { alert("Add a place name."); return; }
    const tag = $("#psTag").value.trim() || "Proposed", note = $("#psNote").value.trim(), link = $("#psLink").value.trim(), author = state.me || "";
    if (SYNC.on) {
      const row = await Backend.addStayOption({ city, name, tag, note, link, author });
      if (row) state.proposedStays.push(row);
    } else {
      state.proposedStays.push({ id: "ls" + Date.now(), city, name, tag, note, link, author });
      LS.set("proposedStays", state.proposedStays);
    }
    renderStays();
  }
  async function removeProposedStay(id) {
    state.proposedStays = state.proposedStays.filter((x) => String(x.id) !== String(id));
    if (SYNC.on) await Backend.removeStayOption(id); else LS.set("proposedStays", state.proposedStays);
    renderStays();
  }

  /* =======================================================================
     FLIGHTS
     ==================================================================== */
  function renderFlights() {
    const s = $("#screen-flights");
    const mine = (dir) => state.flights.find((f) => f.traveler === state.me && f.dir === dir) || {};
    const flightRow = (f) => {
      const t = byId(f.traveler) || {};
      const line = [f.airline, f.flight_no].filter(Boolean).join(" ");
      const when = [f.date ? `${fmtDate(f.date).wd} ${fmtDate(f.date).mon} ${fmtDate(f.date).day}` : "", f.time].filter(Boolean).join(" · ");
      const detail = [line, when].filter(Boolean).join(" · ") || "—";
      return `<div class="row">
        <span class="avatar" style="width:34px;height:34px;font-size:11px;${avatarBg(t)}">${avatarTxt(t)}</span>
        <div class="r-main"><div class="r-title">${esc((t.name || "").split(" ")[0])}${f.airport ? ` · ${esc(f.airport)}` : ""}</div>
          <div class="r-sub">${esc(detail)}${f.note ? ` · ${esc(f.note)}` : ""}</div></div>
      </div>`;
    };
    const sortKey = (f) => (f.date || "") + (f.time || "");
    const arrivals = state.flights.filter((f) => f.dir === "arrive").slice().sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    const departures = state.flights.filter((f) => f.dir === "depart").slice().sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    const fields = (p, dir) => `<div class="expense-add">
        <input id="${p}_airline" placeholder="Airline" value="${esc(mine(dir).airline || "")}" />
        <div style="display:flex;gap:8px">
          <input id="${p}_flight" placeholder="Flight #" value="${esc(mine(dir).flight_no || "")}" style="flex:2" />
          <input id="${p}_airport" placeholder="Airport" value="${esc(mine(dir).airport || (dir === "arrive" ? "HND" : "HND"))}" style="flex:1" />
        </div>
        <div style="display:flex;gap:8px">
          <input id="${p}_date" type="date" value="${esc(mine(dir).date || (dir === "arrive" ? "2027-04-15" : "2027-04-25"))}" style="flex:2" />
          <input id="${p}_time" type="time" value="${esc(mine(dir).time || "")}" style="flex:1" />
        </div>
        <input id="${p}_note" placeholder="Note (e.g. via SFO, layover…)" value="${esc(mine(dir).note || "")}" />
        <button class="btn primary" id="${p}Save">Save ${dir === "arrive" ? "arrival" : "departure"}</button>
      </div>`;
    s.innerHTML = `
      <div class="section-title">Flights & arrivals</div>
      <div class="section-sub">${esc(T.flightsNote || "")} Everyone adds their own — ${SYNC.on ? "shared with the group." : SYNC.configured ? "syncing…" : "saved on this phone."}</div>
      ${!state.me ? `<div class="card" style="border-color:var(--sakura-deep);background:#fdf3f5"><b>Tag yourself first</b> — tap "Who are you?" so your flights save to you. <button class="btn primary" id="flWho" style="margin-top:10px;width:100%">Set who I am</button></div>` : `
      <div class="card">
        <h3>✈️ Your flights</h3>
        <p class="section-sub" style="margin:2px 0 12px">${esc((byId(state.me) || {}).name || "")} — fill in what you know; leave the rest blank.</p>
        <div class="check-cat" style="margin:0 0 8px">🛬 Arrival</div>
        ${fields("fa", "arrive")}
        <div class="check-cat" style="margin:18px 0 8px">🛫 Departure</div>
        ${fields("fd", "depart")}
      </div>`}
      <div class="section-title" style="font-size:16px">🛬 Arrivals board</div>
      <div class="card">${arrivals.length ? arrivals.map(flightRow).join("") : `<div class="empty">No arrivals entered yet.</div>`}</div>
      <div class="section-title" style="font-size:16px">🛫 Departures</div>
      <div class="card">${departures.length ? departures.map(flightRow).join("") : `<div class="empty">No departures entered yet.</div>`}</div>`;
    const w = $("#flWho"); if (w) w.addEventListener("click", openWho);
    const fas = $("#faSave"); if (fas) fas.addEventListener("click", () => saveFlight("arrive"));
    const fds = $("#fdSave"); if (fds) fds.addEventListener("click", () => saveFlight("depart"));
  }
  async function saveFlight(dir) {
    if (!state.me) { openWho(); return; }
    const p = dir === "arrive" ? "fa" : "fd";
    const row = {
      traveler: state.me, dir,
      airline: $("#" + p + "_airline").value.trim(),
      flight_no: $("#" + p + "_flight").value.trim(),
      airport: $("#" + p + "_airport").value.trim(),
      date: $("#" + p + "_date").value,
      time: $("#" + p + "_time").value,
      note: $("#" + p + "_note").value.trim(),
    };
    state.flights = state.flights.filter((f) => !(f.traveler === state.me && f.dir === dir));
    state.flights.push(row);
    if (SYNC.on) await Backend.upsertFlight(row); else LS.set("flightsLocal", state.flights);
    renderFlights();
  }

  /* =======================================================================
     BUDGET (shared expenses + settle up)
     ==================================================================== */
  function toUSD(amount, cur) {
    const per = T.meta.currency.perUSD || 1;
    return cur === "JPY" ? amount / per : Number(amount);
  }
  function renderBudget() {
    const s = $("#screen-budget");
    const nets = {}; T.travelers.forEach((t) => nets[t.id] = 0);
    state.expenses.forEach((e) => {
      const usd = toUSD(e.amount, e.currency);
      const share = usd / (e.splitAmong.length || 1);
      if (nets[e.paidBy] != null) nets[e.paidBy] += usd;
      e.splitAmong.forEach((id) => { if (nets[id] != null) nets[id] -= share; });
    });
    const total = state.expenses.reduce((a, e) => a + toUSD(e.amount, e.currency), 0);

    s.innerHTML = `
      <div class="section-title">Budget & settle-up</div>
      <div class="section-sub">Splitwise-style: log who paid for what, and balances + settle-up update live. ${SYNC.on ? "Shared across everyone." : SYNC.configured ? "Syncing…" : "<b>Local until the backend is connected.</b>"}</div>

      ${T.meta.showPrices ? `<div class="card">
        <h3>Trip estimate</h3>
        <div class="r-sub" style="font-size:13px">≈ <b>$${T.meta.estPerPerson.toLocaleString()}</b>/person · <b>$${T.meta.estGroup.toLocaleString()}</b> group. ${esc(T.meta.estNote)}</div>
      </div>` : `<div class="card">
        <h3>Trip cost — TBD</h3>
        <div class="r-sub" style="font-size:13px">We'll fill in real numbers once flights and stays are booked. Use this tab to split and settle shared expenses as they come up.</div>
      </div>`}

      <div class="section-title" style="font-size:16px">Balances</div>
      <div class="balance-grid">
        ${T.travelers.map((t) => {
          const v = nets[t.id]; const cls = v > 0.5 ? "owed" : (v < -0.5 ? "owes" : "");
          const txt = Math.abs(v) < 0.5 ? "even" : (v > 0 ? "+$" + v.toFixed(0) + " owed" : "-$" + Math.abs(v).toFixed(0));
          return `<div class="balance"><div class="bn"><span class="avatar" style="width:20px;height:20px;font-size:9px;border-width:1.5px;${avatarBg(t)}">${avatarTxt(t)}</span> ${esc(t.name.split(" ")[0])}</div><div class="bv ${cls}">${txt}</div></div>`;
        }).join("")}
      </div>
      ${settleText(nets)}

      <div class="section-title" style="font-size:16px">Add an expense</div>
      <div class="card expense-add">
        <input id="exLabel" placeholder="What was it? (e.g. Group dinner)" />
        <div style="display:flex;gap:8px">
          <input id="exAmount" type="number" inputmode="decimal" placeholder="Amount" style="flex:2" />
          <select id="exCur" style="flex:1"><option value="JPY">¥ JPY</option><option value="USD">$ USD</option></select>
        </div>
        <label class="r-sub" style="font-weight:700">Paid by</label>
        <select id="exPaid">${T.travelers.map((t) => `<option value="${t.id}" ${state.me === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select>
        <label class="r-sub" style="font-weight:700">Split among</label>
        <div id="exSplit">
          ${T.travelers.map((t) => `<label class="split-chip"><input type="checkbox" value="${t.id}" checked><span class="avatar" style="${avatarBg(t)}">${avatarTxt(t)}</span>${esc(t.name.split(" ")[0])}</label>`).join("")}
        </div>
        <button class="btn primary" id="exAdd">Add expense</button>
      </div>

      <div class="section-title" style="font-size:16px">Log</div>
      <div id="exLog">${expenseLog()}</div>`;

    $("#exAdd").addEventListener("click", addExpense);
    bindExpenseDelete();
  }
  function settleText(nets) {
    const cred = Object.entries(nets).filter(([, v]) => v > 0.5).map(([id, v]) => ({ id, v }));
    const debt = Object.entries(nets).filter(([, v]) => v < -0.5).map(([id, v]) => ({ id, v: -v }));
    if (!cred.length || !debt.length) return `<p class="section-sub" style="margin-top:-6px">No one owes anything yet — add some expenses.</p>`;
    cred.sort((a, b) => b.v - a.v); debt.sort((a, b) => b.v - a.v);
    const lines = []; let i = 0, j = 0;
    const c = cred.map((x) => ({ ...x })), d = debt.map((x) => ({ ...x }));
    while (i < d.length && j < c.length) {
      const pay = Math.min(d[i].v, c[j].v);
      lines.push(`${esc((byId(d[i].id) || {}).name?.split(" ")[0] || d[i].id)} → ${esc((byId(c[j].id) || {}).name?.split(" ")[0] || c[j].id)}: <b>$${pay.toFixed(0)}</b>`);
      d[i].v -= pay; c[j].v -= pay;
      if (d[i].v < 0.5) i++; if (c[j].v < 0.5) j++;
    }
    return `<div class="card"><h3>Suggested settle-up</h3>${lines.map((l) => `<div class="r-sub" style="font-size:13.5px;padding:3px 0">${l}</div>`).join("")}</div>`;
  }
  function expenseLog() {
    if (!state.expenses.length) return `<div class="empty">No expenses logged yet.</div>`;
    return state.expenses.slice().reverse().map((e) => `<div class="row" data-ex="${e.id}">
      <div class="r-main"><div class="r-title">${esc(e.label)}</div>
        <div class="r-sub">${e.currency === "JPY" ? "¥" : "$"}${Number(e.amount).toLocaleString()} · paid by ${esc((byId(e.paidBy) || {}).name?.split(" ")[0] || e.paidBy)} · split ${e.splitAmong.length}</div></div>
      <button class="btn danger" data-del="${e.id}">Delete</button>
    </div>`).join("");
  }
  async function addExpense() {
    const label = $("#exLabel").value.trim();
    const amount = parseFloat($("#exAmount").value);
    if (!label || !(amount > 0)) { alert("Add a description and an amount."); return; }
    const splitAmong = $$("#exSplit input:checked").map((c) => c.value);
    if (!splitAmong.length) { alert("Pick at least one person to split among."); return; }
    const currency = $("#exCur").value, paidBy = $("#exPaid").value;
    if (SYNC.on) {
      const row = await Backend.addExpense({ label, amount, currency, paid_by: paidBy, split_among: splitAmong });
      if (row) state.expenses.push({ id: row.id, label, amount, currency, paidBy, splitAmong });
      renderBudget();
    } else {
      state.expenses.push({ id: "e" + Date.now(), label, amount, currency, paidBy, splitAmong });
      save(); renderBudget();
    }
  }
  function bindExpenseDelete() {
    $$("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      const id = b.dataset.del;
      state.expenses = state.expenses.filter((e) => String(e.id) !== String(id));
      if (SYNC.on) { await Backend.removeExpense(id); renderBudget(); }
      else { save(); renderBudget(); }
    }));
  }

  /* =======================================================================
     PACKING
     ==================================================================== */
  function renderPacking() {
    const s = $("#screen-packing");
    const all = T.packing.flatMap((c) => c.items);
    const done = all.filter((i) => state.packing[i]).length;
    const pct = all.length ? Math.round((done / all.length) * 100) : 0;
    s.innerHTML = `
      <div class="section-title">Packing</div>
      <div class="section-sub">Late April = layers + dry. Checked items save on this phone. ${done}/${all.length} packed.</div>
      <div class="progress"><i style="width:${pct}%"></i></div>
      ${T.packing.map((cat) => `
        <div class="check-cat">${esc(cat.cat)}</div>
        ${cat.items.map((it) => {
          const on = !!state.packing[it];
          return `<div class="check ${on ? "done" : ""}"><input type="checkbox" ${on ? "checked" : ""} data-pack="${esc(it)}" id="pk-${btoa(unescape(encodeURIComponent(it))).replace(/=/g, "")}"><label for="pk-${btoa(unescape(encodeURIComponent(it))).replace(/=/g, "")}">${esc(it)}</label></div>`;
        }).join("")}`).join("")}`;
    s.querySelectorAll("[data-pack]").forEach((c) => c.addEventListener("change", () => {
      state.packing[c.dataset.pack] = c.checked; save(); renderPacking();
    }));
  }

  /* =======================================================================
     DECISIONS (group votes)
     ==================================================================== */
  function renderDecisions() {
    const s = $("#screen-decisions");
    const decisions = [
      ...T.decisions.map((d) => ({ ...d, posted: false })),
      ...state.postedDecisions.map((d) => ({ id: d.id, title: d.title, note: d.note || "", options: d.options || [], status: d.status || "open", author: d.author, posted: true })),
    ];
    s.innerHTML = `
      <div class="section-title">Decisions</div>
      <div class="section-sub">Open questions for the group. Tap your pick${SYNC.on ? " — everyone's votes tally live." : SYNC.configured ? " — syncing…" : ". <b>Local until the backend is connected.</b>"} Anyone can add one below.</div>
      ${!state.me ? `<div class="card" style="border-color:var(--sakura-deep);background:#fdf3f5"><b>Tag yourself first</b> — tap "Who are you?" at the top so your votes are yours. <button class="btn primary" id="decWho" style="margin-top:10px;width:100%">Set who I am</button></div>` : ""}
      ${decisions.map((d) => {
        const mine = myVote("decision", d.id);
        const counts = tally("decision", d.id);
        const author = d.author ? esc((byId(d.author) || {}).name?.split(" ")[0] || "") : "";
        return `<div class="card">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <h3 style="margin:0">${esc(d.title)}</h3>
            <span class="pill ${d.status === "decided" ? "tokyo" : d.status === "leaning" ? "osaka" : "any"}">${esc(d.status)}</span>
          </div>
          ${d.note ? `<p class="section-sub" style="margin:8px 0 12px">${esc(d.note)}</p>` : `<div style="height:8px"></div>`}
          <div style="display:grid;gap:8px">
            ${d.options.map((o) => {
              const voters = counts[o.id] || [];
              const sel = mine === o.id;
              return `<button class="who-opt ${sel ? "sel" : ""}" data-dec="${d.id}" data-opt="${o.id}" style="text-align:left;width:100%;align-items:flex-start">
                <span style="font-size:18px;margin-top:1px">${sel ? "🔘" : "⚪"}</span>
                <div style="flex:1;min-width:0"><div style="font-weight:700">${esc(o.label)}</div>
                  <div class="r-sub" style="font-weight:500">${esc(o.note || "")}</div>
                  ${voters.length ? `<div class="tally">${voterChips(voters)}<span class="tally-n">${voters.length} vote${voters.length === 1 ? "" : "s"}</span></div>` : ""}
                </div>
              </button>`;
            }).join("")}
          </div>
          ${d.posted ? `<div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px">
            ${author ? `<span class="r-sub" style="font-size:11px">added by ${author}</span>` : "<span></span>"}
            ${d.author === state.me ? `<button class="btn danger" data-decdel="${d.id}">Remove</button>` : ""}
          </div>` : ""}
        </div>`;
      }).join("")}

      <div class="card" style="margin-top:16px">
        <h3>Add a decision</h3>
        <p class="section-sub" style="margin:4px 0 12px">Pose a question for the group with 2–4 options.</p>
        <div class="expense-add">
          <input id="decTitle" placeholder="The question (e.g. Which day for Disney?)" />
          <input id="decNote" placeholder="Context (optional)" />
          <input id="decO0" placeholder="Option 1" />
          <input id="decO1" placeholder="Option 2" />
          <input id="decO2" placeholder="Option 3 (optional)" />
          <input id="decO3" placeholder="Option 4 (optional)" />
          <button class="btn primary" id="decAdd">Post decision</button>
        </div>
      </div>`;
    s.querySelectorAll("[data-dec]").forEach((b) => b.addEventListener("click", () => setVote("decision", b.dataset.dec, b.dataset.opt)));
    s.querySelectorAll("[data-decdel]").forEach((b) => b.addEventListener("click", () => removePostedDecision(b.dataset.decdel)));
    $("#decAdd").addEventListener("click", addDecision);
    const dw = $("#decWho"); if (dw) dw.addEventListener("click", openWho);
  }
  async function addDecision() {
    const title = $("#decTitle").value.trim();
    const opts = [0, 1, 2, 3].map((i) => $("#decO" + i).value.trim()).filter(Boolean);
    if (!title) { alert("Add the question."); return; }
    if (opts.length < 2) { alert("Add at least two options."); return; }
    const note = $("#decNote").value.trim(), author = state.me || "";
    const options = opts.map((label, i) => ({ id: "opt" + i, label, note: "" }));
    if (SYNC.on) {
      const row = await Backend.addDecision({ title, note, options, status: "open", author });
      if (row) state.postedDecisions.push(row);
    } else {
      state.postedDecisions.push({ id: "ld" + Date.now(), title, note, options, status: "open", author });
      LS.set("postedDecisions", state.postedDecisions);
    }
    renderDecisions();
  }
  async function removePostedDecision(id) {
    state.postedDecisions = state.postedDecisions.filter((x) => String(x.id) !== String(id));
    if (SYNC.on) await Backend.removeDecision(id); else LS.set("postedDecisions", state.postedDecisions);
    renderDecisions();
  }

  /* =======================================================================
     IDEAS (thumbs-up + post your own)
     ==================================================================== */
  function renderIdeas() {
    const s = $("#screen-ideas");
    const list = [
      ...T.ideas.map((i) => ({ ...i, posted: false })),
      ...state.postedIdeas.map((i) => ({ id: i.id, title: i.title, note: i.note, city: i.city || "any", author: i.author, posted: true })),
    ];
    s.innerHTML = `
      <div class="section-title">Ideas board</div>
      <div class="section-sub">Things nobody's committed to yet. 👍 what you'd want to do, and post your own. ${SYNC.on ? "Everyone sees the group's picks." : SYNC.configured ? "Syncing…" : "<b>Local until the backend is connected.</b>"}</div>
      ${list.map((i) => {
        const voters = tally("idea", i.id)["up"] || [];
        const on = myVote("idea", i.id) === "up";
        const author = i.author ? esc((byId(i.author) || {}).name?.split(" ")[0] || "") : "";
        return `<div class="idea">
          <div class="i-main">
            <div class="i-title">${esc(i.title)} <span class="pill ${i.city}">${i.city === "any" ? "Anytime" : cityName(i.city)}</span></div>
            <div class="i-note">${esc(i.note || "")}${author ? ` · <i>added by ${author}</i>` : ""}</div>
            ${voters.length ? `<div class="tally" style="margin-top:8px">${voterChips(voters)}</div>` : ""}
            ${i.posted && i.author === state.me ? `<button class="btn danger" data-iddel="${i.id}" style="margin-top:8px">Remove</button>` : ""}
          </div>
          <div class="vote"><button class="${on ? "voted" : ""}" data-idea="${i.id}">👍</button><span class="vcount">${voters.length || ""}</span></div>
        </div>`;
      }).join("")}
      <div class="card" style="margin-top:16px">
        <h3>Add an idea</h3>
        <div class="expense-add">
          <input id="ideaTitle" placeholder="Your idea (e.g. Sunrise at a temple)" />
          <select id="ideaCity"><option value="any">Anytime / anywhere</option>${T.cities.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
          <input id="ideaNote" placeholder="One line about it (optional)" />
          <button class="btn primary" id="ideaAdd">Post idea</button>
        </div>
      </div>`;
    s.querySelectorAll("[data-idea]").forEach((b) => b.addEventListener("click", () => setVote("idea", b.dataset.idea, "up")));
    s.querySelectorAll("[data-iddel]").forEach((b) => b.addEventListener("click", () => removePostedIdea(b.dataset.iddel)));
    $("#ideaAdd").addEventListener("click", addIdea);
  }
  async function addIdea() {
    const title = $("#ideaTitle").value.trim();
    if (!title) { alert("Give your idea a title."); return; }
    const city = $("#ideaCity").value, note = $("#ideaNote").value.trim(), author = state.me || "";
    if (SYNC.on) {
      const row = await Backend.addIdea({ title, note, city, author });
      if (row) state.postedIdeas.unshift(row);
    } else {
      state.postedIdeas.unshift({ id: "li" + Date.now(), title, note, city, author });
      LS.set("postedIdeas", state.postedIdeas);
    }
    renderIdeas();
  }
  async function removePostedIdea(id) {
    state.postedIdeas = state.postedIdeas.filter((x) => String(x.id) !== String(id));
    if (SYNC.on) await Backend.removeIdea(id); else LS.set("postedIdeas", state.postedIdeas);
    renderIdeas();
  }

  /* =======================================================================
     PHOTOS (shared album — backend required)
     ==================================================================== */
  function renderPhotos() {
    const s = $("#screen-photos");
    if (!SYNC.on) {
      s.innerHTML = `
        <div class="section-title">Photos</div>
        <div class="section-sub">A shared album for during the trip.</div>
        <div class="card"><h3>📸 Connect the backend to turn this on</h3>
          <p class="r-sub" style="margin:6px 0 0">Once Supabase is wired up, everyone can upload photos here and see the whole group's shots in one live feed.</p></div>`;
      return;
    }
    s.innerHTML = `
      <div class="section-title">Photos</div>
      <div class="section-sub">The group's shared album. Add your shots — everyone sees them live.</div>
      <div class="card">
        <label class="btn primary" for="photoInput" style="display:block;text-align:center">📷 Add a photo</label>
        <input id="photoInput" type="file" accept="image/*" style="display:none" />
        <input id="photoCaption" placeholder="Caption (optional)" style="width:100%;margin-top:10px;padding:11px 12px;border:1px solid var(--line);border-radius:var(--r-sm);font-size:14px" />
        <div id="photoStatus" class="r-sub" style="margin-top:8px"></div>
      </div>
      <div class="photo-grid">
        ${state.photos.length ? state.photos.map((p) => `<div class="photo-cell">
          <img src="${esc(p.url)}" alt="${esc(p.caption || "trip photo")}" loading="lazy" />
          ${p.caption ? `<div class="photo-cap">${esc(p.caption)}</div>` : ""}
          ${p.author === state.me ? `<button class="photo-del" data-photodel="${p.id}">✕</button>` : ""}
        </div>`).join("") : `<div class="empty" style="grid-column:1/-1">No photos yet — be the first.</div>`}
      </div>`;
    const input = $("#photoInput");
    input.addEventListener("change", async () => {
      const file = input.files[0]; if (!file) return;
      if (!state.me) { openWho(); return; }
      $("#photoStatus").textContent = "Uploading…";
      const row = await Backend.uploadPhoto(file, $("#photoCaption").value.trim(), state.me);
      if (row) { state.photos.unshift(row); renderPhotos(); }
      else $("#photoStatus").textContent = "Upload failed — try again.";
    });
    s.querySelectorAll("[data-photodel]").forEach((b) => b.addEventListener("click", async () => {
      const p = state.photos.find((x) => String(x.id) === String(b.dataset.photodel));
      state.photos = state.photos.filter((x) => x !== p);
      renderPhotos();
      if (p) await Backend.removePhoto(p);
    }));
  }

  /* =======================================================================
     GUIDE + phrases
     ==================================================================== */
  function renderGuide() {
    const s = $("#screen-guide");
    s.innerHTML = `
      <div class="section-title">Japan Guide</div>
      <div class="section-sub">The stuff everyone would otherwise ask — answered once.</div>
      ${T.guide.map((g) => `<div class="guide-card">
        <div class="g-head"><span>${g.icon}</span> ${esc(g.title)}</div>
        <div class="g-body">${esc(g.body)}</div>
      </div>`).join("")}
      <div class="section-title" style="margin-top:20px">Phrasebook</div>
      <div class="card">
        ${T.phrases.map((p) => `<div class="phrase"><div class="p-en">${esc(p.en)}</div><div class="p-jp">${esc(p.jp)}</div><div class="p-ro">${esc(p.romaji)}</div></div>`).join("")}
      </div>`;
  }

  /* =======================================================================
     WHO ARE YOU
     ==================================================================== */
  function renderWhoami() {
    const btn = $("#whoamiName"), av = $("#whoamiAvatar");
    if (state.me) {
      const t = byId(state.me);
      btn.textContent = t.name.split(" ")[0];
      av.innerHTML = `<span class="avatar" style="width:26px;height:26px;font-size:10px;border-width:1.5px;${avatarBg(t)}">${avatarTxt(t)}</span>`;
    } else { btn.textContent = "Who are you?"; av.innerHTML = "👤"; }
  }
  function openWho() {
    const box = $("#whoOptions");
    box.innerHTML = T.travelers.map((t) => `<div class="who-opt ${state.me === t.id ? "sel" : ""}" data-me="${t.id}">
      <span class="avatar" style="width:34px;height:34px;font-size:12px;${avatarBg(t)}">${avatarTxt(t)}</span>${esc(t.name)}</div>`).join("");
    box.querySelectorAll("[data-me]").forEach((o) => o.addEventListener("click", () => {
      state.me = o.dataset.me; save(); renderWhoami();
      box.querySelectorAll(".who-opt").forEach((x) => x.classList.toggle("sel", x === o));
      renderCurrent();
    }));
    $("#whoModal").classList.add("open");
  }
  $("#whoamiBtn").addEventListener("click", openWho);
  $("#whoClose").addEventListener("click", () => $("#whoModal").classList.remove("open"));
  $("#whoModal").addEventListener("click", (e) => { if (e.target.id === "whoModal") $("#whoModal").classList.remove("open"); });

  /* =======================================================================
     BOOT
     ==================================================================== */
  const RENDERERS = {
    home: renderHome, itinerary: renderItinerary, crew: renderCrew, stays: renderStays,
    flights: renderFlights, budget: renderBudget, packing: renderPacking,
    decisions: renderDecisions, booking: renderBooking, ideas: renderIdeas, photos: renderPhotos, guide: renderGuide,
  };
  function renderCurrent() {
    const active = $(".screen.active");
    const id = active ? active.id.replace("screen-", "") : "home";
    if (RENDERERS[id]) RENDERERS[id]();
    if (id === "map") drawPins && map && drawPins();
  }
  function renderAll() { Object.values(RENDERERS).forEach((fn) => fn()); }

  renderAll();
  renderWhoami();
  if (!state.me) setTimeout(openWho, 600);
  Sync.init(); // connects to the backend if configured; otherwise stays local

  // PWA service worker
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})();
