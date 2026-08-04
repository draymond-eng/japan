/* =============================================================================
   Supabase config - fill these with YOUR project's values.
   Get them in Supabase → Project Settings → API:
     • url      = "Project URL"        (e.g. https://xxxxxxxx.supabase.co)
     • anonKey  = "anon / public key"  (the long eyJ... token)

   The anon key is DESIGNED to live in client code - it's safe to commit.
   Row-level security policies (see the setup SQL) control what it can do.

   Leave these empty to keep the app in local/per-device mode.
   ========================================================================== */
window.SUPABASE_CONFIG = {
  url: "https://tgcrjsapqfogdagqoccq.supabase.co",
  anonKey: "sb_publishable_H65vKGnPAyJo2ojZ_yksFQ_UNPpmihe",

  /* Public half of the web-push keypair. Safe to commit: it only lets a phone
     say "this is the server I expect". The private half lives ONLY in Supabase
     Edge Function Secrets and must never end up in this file. Leave empty to
     turn notifications off. */
  vapidPublic: "BHDUSHMMDdpXWLZsg2PYbXxEkNJaCNfL2v_TM7qI9Q77Q9MF2dAdey6_HqEyyN5Z-F0wqYioN2PekTrhtCTzIAM",
};
