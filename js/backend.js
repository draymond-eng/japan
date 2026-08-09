/* =============================================================================
   Backend - Supabase data layer for shared trip data.
   Falls back silently to local mode if config is empty or the SDK/offline.
   Exposes window.Backend. All methods are async and never throw to callers
   (they log + return safe empties) so the UI stays resilient.
   ========================================================================== */
(function () {
  "use strict";
  let client = null;
  let ready = false;

  const BUCKET = "trip-photos";

  function init() {
    try {
      const cfg = window.SUPABASE_CONFIG || {};
      if (!cfg.url || !cfg.anonKey || !window.supabase || !window.supabase.createClient) return false;
      client = window.supabase.createClient(cfg.url, cfg.anonKey, {
        auth: { persistSession: false },
      });
      ready = true;
      return true;
    } catch (e) { console.warn("Backend init failed:", e); return false; }
  }

  /* The Supabase client does NOT throw when a write is rejected. It resolves
     with { error }. Awaiting one and moving on therefore reports success for a
     write that never happened, which silently loses the change and skips the
     retry queue. Every mutation goes through here so that can only be got
     wrong in one place. */
  async function did(q) {
    const r = await q;
    if (r && r.error) throw r.error;
    return r;
  }

  /* ---- Votes: one row per (kind, topic, voter) ---------------------------- */
  async function fetchVotes() {
    try { const { data, error } = await client.from("votes").select("*"); if (error) throw error; return data || []; }
    catch (e) { console.warn("fetchVotes", e); return []; }
  }
  async function castVote(kind, topic, choice, voter) {
    try {
      if (choice == null) {
        await did(client.from("votes").delete().match({ kind, topic, voter }));
      } else {
        await did(client.from("votes").upsert({ kind, topic, choice, voter }, { onConflict: "kind,topic,voter" }));
      }
      return true;
    } catch (e) {
      writeFailed("castVote", e, choice == null
        ? { kind: "removeBy", table: "votes", match: { kind, topic, voter } }
        : { kind: "upsert", table: "votes", row: { kind, topic, choice, voter }, opts: { onConflict: "kind,topic,voter" } });
      return false;
    }
  }

  /* ---- Failed writes -----------------------------------------------------
     A trip happens on planes and foreign SIMs. A write that fails is parked
     here, kept across app restarts, and replayed in order when the connection
     comes back. Reads are never queued; stale is fine, lost is not.
     ------------------------------------------------------------------------ */
  const Q_KEY = "jp_write_queue";
  let queue = [];
  let flushing = false;
  let onWriteFail = null, onQueueChange = null;
  const uid = () => (crypto.randomUUID ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16); }));
  try { queue = JSON.parse(localStorage.getItem(Q_KEY) || "[]") || []; } catch { queue = []; }
  function saveQueue() {
    try { localStorage.setItem(Q_KEY, JSON.stringify(queue.slice(-200))); } catch { /* full */ }
    try { if (onQueueChange) onQueueChange(queue.length); } catch { /* never break a write */ }
  }
  function writeFailed(what, e, op) {
    console.warn(what, e);
    if (op) {
      // repeated edits to the same row collapse, so a slow link does not
      // replay every save
      if (op.kind === "update") {
        const prev = queue.find((o) => o.kind === "update" && o.table === op.table && String(o.id) === String(op.id));
        if (prev) { prev.patch = { ...prev.patch, ...op.patch }; saveQueue(); }
        else { queue.push(op); saveQueue(); }
      } else { queue.push(op); saveQueue(); }
    }
    try { if (onWriteFail) onWriteFail(what, e); } catch { /* noop */ }
  }
  const must = async (q) => { const r = await q; if (r && r.error) throw r.error; return r; };
  async function runOp(op) {
    switch (op.kind) {
      case "insert": await must(client.from(op.table).insert(op.row)); return;
      case "update": await must(client.from(op.table).update(op.patch).eq("id", op.id)); return;
      case "remove": await must(client.from(op.table).delete().eq("id", op.id)); return;
      case "removeBy": await must(client.from(op.table).delete().match(op.match)); return;
      case "upsert": await must(client.from(op.table).upsert(op.row, op.opts || {})); return;
      default: return;
    }
  }
  /* Replay in order and stop at the first failure, so a later write can never
     land before the earlier one it depends on. */
  async function flushQueue() {
    if (flushing || !client || !queue.length) return { sent: 0, left: queue.length };
    flushing = true;
    let sent = 0;
    try {
      while (queue.length) {
        try { await runOp(queue[0]); } catch (e) { break; }
        queue.shift(); sent++; saveQueue();
      }
    } finally { flushing = false; }
    return { sent, left: queue.length };
  }
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => { flushQueue(); });
    setInterval(() => { if (queue.length && navigator.onLine !== false) flushQueue(); }, 20000);
  }

  /* ---- Expenses ----------------------------------------------------------- */
  async function fetchExpenses() {
    try { const { data, error } = await client.from("expenses").select("*").order("created_at", { ascending: true }); if (error) throw error; return data || []; }
    catch (e) { console.warn("fetchExpenses", e); return []; }
  }
  async function addExpense(row) {
    // give the row its id up front so the screen, the queue and the
    // database agree on it even when the write only lands later
    const withId = row && row.id ? row : { ...row, id: uid() };
    try { const { data, error } = await client.from("expenses").insert(withId).select().single(); if (error) throw error; return data; }
    catch (e) { writeFailed("addExpense", e, { kind: "insert", table: "expenses", row: withId }); return { ...withId, _pending: true }; }
  }
  async function removeExpense(id) {
    try { await did(client.from("expenses").delete().eq("id", id)); return true; }
    catch (e) { writeFailed("removeExpense", e, { kind: "remove", table: "expenses", id }); return false; }
  }

  /* ---- Posted ideas ------------------------------------------------------- */
  async function fetchIdeas() {
    try { const { data, error } = await client.from("ideas").select("*").order("created_at", { ascending: false }); if (error) throw error; return data || []; }
    catch (e) { console.warn("fetchIdeas", e); return []; }
  }
  async function addIdea(row) {
    // give the row its id up front so the screen, the queue and the
    // database agree on it even when the write only lands later
    const withId = row && row.id ? row : { ...row, id: uid() };
    try { const { data, error } = await client.from("ideas").insert(withId).select().single(); if (error) throw error; return data; }
    catch (e) { writeFailed("addIdea", e, { kind: "insert", table: "ideas", row: withId }); return { ...withId, _pending: true }; }
  }
  async function removeIdea(id) {
    try { await did(client.from("ideas").delete().eq("id", id)); return true; }
    catch (e) { writeFailed("removeIdea", e, { kind: "remove", table: "ideas", id }); return false; }
  }

  /* ---- Decisions (group-submitted polls) ---------------------------------- */
  async function fetchDecisions() {
    try { const { data, error } = await client.from("decisions").select("*").order("created_at", { ascending: true }); if (error) throw error; return data || []; }
    catch (e) { console.warn("fetchDecisions", e); return []; }
  }
  async function addDecision(row) {
    // give the row its id up front so the screen, the queue and the
    // database agree on it even when the write only lands later
    const withId = row && row.id ? row : { ...row, id: uid() };
    try { const { data, error } = await client.from("decisions").insert(withId).select().single(); if (error) throw error; return data; }
    catch (e) { writeFailed("addDecision", e, { kind: "insert", table: "decisions", row: withId }); return { ...withId, _pending: true }; }
  }
  async function removeDecision(id) {
    try { await did(client.from("decisions").delete().eq("id", id)); return true; }
    catch (e) { writeFailed("removeDecision", e, { kind: "remove", table: "decisions", id }); return false; }
  }

  /* ---- Fares (logged flight prices over time) ----------------------------- */
  async function fetchFares() {
    try { const { data, error } = await client.from("fares").select("*").order("created_at", { ascending: true }); if (error) throw error; return data || []; }
    catch (e) { console.warn("fetchFares", e); return []; }
  }
  async function addFare(row) {
    // give the row its id up front so the screen, the queue and the
    // database agree on it even when the write only lands later
    const withId = row && row.id ? row : { ...row, id: uid() };
    try { const { data, error } = await client.from("fares").insert(withId).select().single(); if (error) throw error; return data; }
    catch (e) { writeFailed("addFare", e, { kind: "insert", table: "fares", row: withId }); return { ...withId, _pending: true }; }
  }
  async function removeFare(id) {
    try { await did(client.from("fares").delete().eq("id", id)); return true; }
    catch (e) { writeFailed("removeFare", e, { kind: "remove", table: "fares", id }); return false; }
  }

  /* ---- Notes / omiyage (shared running lists) ----------------------------- */
  async function fetchNotes() {
    try { const { data, error } = await client.from("notes").select("*").order("created_at", { ascending: true }); if (error) throw error; return data || []; }
    catch (e) { console.warn("fetchNotes", e); return []; }
  }
  async function addNote(row) {
    // give the row its id up front so the screen, the queue and the
    // database agree on it even when the write only lands later
    const withId = row && row.id ? row : { ...row, id: uid() };
    try { const { data, error } = await client.from("notes").insert(withId).select().single(); if (error) throw error; return data; }
    catch (e) { writeFailed("addNote", e, { kind: "insert", table: "notes", row: withId }); return { ...withId, _pending: true }; }
  }
  async function updateNote(id, patch) {
    try { await did(client.from("notes").update(patch).eq("id", id)); return true; }
    catch (e) { writeFailed("updateNote", e, { kind: "update", table: "notes", id, patch }); return false; }
  }
  async function removeNote(id) {
    try { await did(client.from("notes").delete().eq("id", id)); return true; }
    catch (e) { writeFailed("removeNote", e, { kind: "remove", table: "notes", id }); return false; }
  }

  /* ---- Confirmations vault (files + numbers) ------------------------------ */
  async function fetchConfirmations() {
    try { const { data, error } = await client.from("confirmations").select("*").order("created_at", { ascending: false }); if (error) throw error; return data || []; }
    catch (e) { console.warn("fetchConfirmations", e); return []; }
  }
  async function addConfirmation(row, file) {
    try {
      let path = "", url = "";
      if (file) {
        const ext = (file.name.split(".").pop() || "pdf").toLowerCase();
        path = `docs/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const up = await client.storage.from(BUCKET).upload(path, file, { cacheControl: "3600", upsert: false });
        if (up.error) throw up.error;
        url = client.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
      }
      const { data, error } = await client.from("confirmations").insert({ ...row, path, url }).select().single();
      if (error) throw error;
      return data;
    } catch (e) { writeFailed("addConfirmation", e, { kind: "insert", table: "confirmations", row: withId }); return { ...withId, _pending: true }; }
  }
  async function removeConfirmation(row) {
    try { if (row.path) await client.storage.from(BUCKET).remove([row.path]); await did(client.from("confirmations").delete().eq("id", row.id)); return true; }
    catch (e) { writeFailed("removeConfirmation", e, { kind: "remove", table: "confirmations", id }); return false; }
  }

  /* ---- Flights (one row per traveler + direction) ------------------------- */
  async function fetchFlights() {
    try { const { data, error } = await client.from("flights").select("*"); if (error) throw error; return data || []; }
    catch (e) { console.warn("fetchFlights", e); return []; }
  }
  async function upsertFlight(row) {
    try { const { data, error } = await client.from("flights").upsert(row, { onConflict: "traveler,dir" }).select().single(); if (error) throw error; return data; }
    catch (e) {
      writeFailed("upsertFlight", e, { kind: "upsert", table: "flights", row, opts: { onConflict: "traveler,dir" } });
      return { ...row, _pending: true };
    }
  }
  async function removeFlight(traveler, dir) {
    try { await did(client.from("flights").delete().match({ traveler, dir })); return true; }
    catch (e) { writeFailed("removeFlight", e, { kind: "removeBy", table: "flights", match: { traveler, dir } }); return false; }
  }

  /* ---- Proposed stay options (group-submitted hotels) --------------------- */
  async function fetchStayOptions() {
    try { const { data, error } = await client.from("stay_options").select("*").order("created_at", { ascending: true }); if (error) throw error; return data || []; }
    catch (e) { console.warn("fetchStayOptions", e); return []; }
  }
  async function addStayOption(row) {
    // give the row its id up front so the screen, the queue and the
    // database agree on it even when the write only lands later
    const withId = row && row.id ? row : { ...row, id: uid() };
    try { const { data, error } = await client.from("stay_options").insert(withId).select().single(); if (error) throw error; return data; }
    catch (e) { writeFailed("addStayOption", e, { kind: "insert", table: "stay_options", row: withId }); return { ...withId, _pending: true }; }
  }
  async function removeStayOption(id) {
    try { await did(client.from("stay_options").delete().eq("id", id)); return true; }
    catch (e) { writeFailed("removeStayOption", e, { kind: "remove", table: "stay_options", id }); return false; }
  }

  /* ---- Updates + push subscriptions --------------------------------------- */
  async function fetchAnnouncements() {
    try { const { data, error } = await client.from("announcements").select("*").order("created_at", { ascending: false }); if (error) throw error; return data || []; }
    catch (e) { console.warn("fetchAnnouncements", e); return []; }
  }
  async function removeAnnouncement(id) {
    try { await did(client.from("announcements").delete().eq("id", id)); return true; }
    catch (e) { writeFailed("removeAnnouncement", e, { kind: "remove", table: "announcements", id }); return false; }
  }
  async function savePushSub(row) {
    try { const { error } = await client.from("push_subs").upsert(row, { onConflict: "endpoint" }); if (error) throw error; return true; }
    catch (e) { console.warn("savePushSub", e); return false; }
  }
  async function removePushSub(endpoint) {
    try { await did(client.from("push_subs").delete().eq("endpoint", endpoint)); return true; }
    catch (e) { console.warn("removePushSub", e); return false; }
  }

  /* ---- Photos (Storage + table) ------------------------------------------ */
  async function fetchPhotos() {
    try { const { data, error } = await client.from("photos").select("*").order("created_at", { ascending: false }); if (error) throw error; return data || []; }
    catch (e) { console.warn("fetchPhotos", e); return []; }
  }
  async function uploadPhoto(file, caption, author) {
    try {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const up = await client.storage.from(BUCKET).upload(path, file, { cacheControl: "3600", upsert: false });
      if (up.error) throw up.error;
      const { data: pub } = client.storage.from(BUCKET).getPublicUrl(path);
      const { data, error } = await client.from("photos")
        .insert({ path, url: pub.publicUrl, caption: caption || "", author: author || "" })
        .select().single();
      if (error) throw error;
      return data;
    } catch (e) { writeFailed("uploadPhoto", e); return null; }
  }
  async function removePhoto(row) {
    try {
      if (row.path) await client.storage.from(BUCKET).remove([row.path]);
      await did(client.from("photos").delete().eq("id", row.id));
      return true;
    } catch (e) { writeFailed("removePhoto", e, { kind: "remove", table: "photos", id }); return false; }
  }

  /* ---- Realtime: one channel, fire callback on any change ----------------- */
  function subscribe(onChange) {
    try {
      return client.channel("trip-realtime")
        .on("postgres_changes", { event: "*", schema: "public", table: "votes" }, () => onChange("votes"))
        .on("postgres_changes", { event: "*", schema: "public", table: "expenses" }, () => onChange("expenses"))
        .on("postgres_changes", { event: "*", schema: "public", table: "ideas" }, () => onChange("ideas"))
        .on("postgres_changes", { event: "*", schema: "public", table: "decisions" }, () => onChange("decisions"))
        .on("postgres_changes", { event: "*", schema: "public", table: "stay_options" }, () => onChange("stay_options"))
        .on("postgres_changes", { event: "*", schema: "public", table: "flights" }, () => onChange("flights"))
        .on("postgres_changes", { event: "*", schema: "public", table: "fares" }, () => onChange("fares"))
        .on("postgres_changes", { event: "*", schema: "public", table: "notes" }, () => onChange("notes"))
        .on("postgres_changes", { event: "*", schema: "public", table: "confirmations" }, () => onChange("confirmations"))
        .on("postgres_changes", { event: "*", schema: "public", table: "photos" }, () => onChange("photos"))
        .on("postgres_changes", { event: "*", schema: "public", table: "announcements" }, () => onChange("announcements"))
        .subscribe();
    } catch (e) { console.warn("subscribe", e); return null; }
  }

  window.Backend = {
    init, isReady: () => ready,
    pending: () => queue.length, flush: flushQueue,
    onQueueChange: (cb) => { onQueueChange = cb; },
    onWriteError: (cb) => { onWriteFail = cb; },
    fetchVotes, castVote,
    fetchExpenses, addExpense, removeExpense,
    fetchIdeas, addIdea, removeIdea,
    fetchDecisions, addDecision, removeDecision,
    fetchStayOptions, addStayOption, removeStayOption,
    fetchFlights, upsertFlight, removeFlight,
    fetchFares, addFare, removeFare,
    fetchNotes, addNote, updateNote, removeNote,
    fetchConfirmations, addConfirmation, removeConfirmation,
    fetchPhotos, uploadPhoto, removePhoto,
    fetchAnnouncements, removeAnnouncement, savePushSub, removePushSub,
    subscribe,
  };
})();
