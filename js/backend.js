/* =============================================================================
   Backend — Supabase data layer for shared trip data.
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

  /* ---- Votes: one row per (kind, topic, voter) ---------------------------- */
  async function fetchVotes() {
    try { const { data, error } = await client.from("votes").select("*"); if (error) throw error; return data || []; }
    catch (e) { console.warn("fetchVotes", e); return []; }
  }
  async function castVote(kind, topic, choice, voter) {
    try {
      if (choice == null) {
        await client.from("votes").delete().match({ kind, topic, voter });
      } else {
        await client.from("votes").upsert({ kind, topic, choice, voter }, { onConflict: "kind,topic,voter" });
      }
      return true;
    } catch (e) { console.warn("castVote", e); return false; }
  }

  /* ---- Expenses ----------------------------------------------------------- */
  async function fetchExpenses() {
    try { const { data, error } = await client.from("expenses").select("*").order("created_at", { ascending: true }); if (error) throw error; return data || []; }
    catch (e) { console.warn("fetchExpenses", e); return []; }
  }
  async function addExpense(row) {
    try { const { data, error } = await client.from("expenses").insert(row).select().single(); if (error) throw error; return data; }
    catch (e) { console.warn("addExpense", e); return null; }
  }
  async function removeExpense(id) {
    try { await client.from("expenses").delete().eq("id", id); return true; }
    catch (e) { console.warn("removeExpense", e); return false; }
  }

  /* ---- Posted ideas ------------------------------------------------------- */
  async function fetchIdeas() {
    try { const { data, error } = await client.from("ideas").select("*").order("created_at", { ascending: false }); if (error) throw error; return data || []; }
    catch (e) { console.warn("fetchIdeas", e); return []; }
  }
  async function addIdea(row) {
    try { const { data, error } = await client.from("ideas").insert(row).select().single(); if (error) throw error; return data; }
    catch (e) { console.warn("addIdea", e); return null; }
  }
  async function removeIdea(id) {
    try { await client.from("ideas").delete().eq("id", id); return true; }
    catch (e) { console.warn("removeIdea", e); return false; }
  }

  /* ---- Decisions (group-submitted polls) ---------------------------------- */
  async function fetchDecisions() {
    try { const { data, error } = await client.from("decisions").select("*").order("created_at", { ascending: true }); if (error) throw error; return data || []; }
    catch (e) { console.warn("fetchDecisions", e); return []; }
  }
  async function addDecision(row) {
    try { const { data, error } = await client.from("decisions").insert(row).select().single(); if (error) throw error; return data; }
    catch (e) { console.warn("addDecision", e); return null; }
  }
  async function removeDecision(id) {
    try { await client.from("decisions").delete().eq("id", id); return true; }
    catch (e) { console.warn("removeDecision", e); return false; }
  }

  /* ---- Proposed stay options (group-submitted hotels) --------------------- */
  async function fetchStayOptions() {
    try { const { data, error } = await client.from("stay_options").select("*").order("created_at", { ascending: true }); if (error) throw error; return data || []; }
    catch (e) { console.warn("fetchStayOptions", e); return []; }
  }
  async function addStayOption(row) {
    try { const { data, error } = await client.from("stay_options").insert(row).select().single(); if (error) throw error; return data; }
    catch (e) { console.warn("addStayOption", e); return null; }
  }
  async function removeStayOption(id) {
    try { await client.from("stay_options").delete().eq("id", id); return true; }
    catch (e) { console.warn("removeStayOption", e); return false; }
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
    } catch (e) { console.warn("uploadPhoto", e); return null; }
  }
  async function removePhoto(row) {
    try {
      if (row.path) await client.storage.from(BUCKET).remove([row.path]);
      await client.from("photos").delete().eq("id", row.id);
      return true;
    } catch (e) { console.warn("removePhoto", e); return false; }
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
        .on("postgres_changes", { event: "*", schema: "public", table: "photos" }, () => onChange("photos"))
        .subscribe();
    } catch (e) { console.warn("subscribe", e); return null; }
  }

  window.Backend = {
    init, isReady: () => ready,
    fetchVotes, castVote,
    fetchExpenses, addExpense, removeExpense,
    fetchIdeas, addIdea, removeIdea,
    fetchDecisions, addDecision, removeDecision,
    fetchStayOptions, addStayOption, removeStayOption,
    fetchPhotos, uploadPhoto, removePhoto,
    subscribe,
  };
})();
