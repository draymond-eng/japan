// =============================================================================
// Japan 2027 — "trip-assistant" Edge Function.
// Chat-only: answers the crew's questions grounded in the trip context the
// app sends along (itinerary, votes, stays, ideas). Never edits anything.
//
// Deploy (Supabase Dashboard → Edge Functions → Deploy new function):
//   name: trip-assistant  ·  paste this file  ·  turn OFF "Verify JWT"
// Secrets (Edge Functions → Secrets):
//   ANTHROPIC_API_KEY = your key from console.anthropic.com
//
// Guard: total message cap (assistant_usage table) so a leaked URL can't
// run up the bill. Run the setup SQL once (see README / chat).
// =============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const MAX_MESSAGES = 600; // lifetime cap for the whole group

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    if (!Deno.env.get("ANTHROPIC_API_KEY")) return json({ error: "ANTHROPIC_API_KEY secret is not set" }, 500);

    const { messages = [], context = {} } = await req.json();
    const history = (Array.isArray(messages) ? messages : [])
      .filter((m: Record<string, unknown>) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content)
      .slice(-12)
      .map((m: Record<string, unknown>) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
    if (!history.length || history[history.length - 1].role !== "user") return json({ error: "No message to answer." }, 400);

    // Usage guard
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: usage } = await supabase.from("assistant_usage").select("count").eq("id", 1).maybeSingle();
    if ((usage?.count ?? 0) >= MAX_MESSAGES) return json({ error: "The assistant has hit its message limit for this trip." }, 429);

    const system = `You are the Japan 2027 trip assistant for a group of six friends (three couples) traveling Tokyo → Hakone → Kyoto, April 15–25 2027. You are a sharp, warm, well-traveled friend who knows Japan deeply. Be concise and concrete; give real opinions, not hedges. Ground answers in the trip context below — their actual itinerary, open votes, proposed stays, and ideas. When they ask about changes, describe the suggestion clearly so they can update the plan themselves (you cannot edit the app). Plain text only, no markdown headers.

TRIP CONTEXT:
${JSON.stringify(context).slice(0, 24000)}`;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        thinking: { type: "disabled" },
        max_tokens: 2000,
        system,
        messages: history,
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      console.error("Anthropic", resp.status, detail);
      let msg = detail;
      try { msg = JSON.parse(detail)?.error?.message ?? detail; } catch { /* raw */ }
      return json({ error: `Anthropic ${resp.status}: ${String(msg).slice(0, 220)}` }, 502);
    }
    const ai = await resp.json();
    if (ai?.stop_reason === "max_tokens") return json({ error: "Answer was cut off — ask again." }, 502);
    const reply = ai?.content?.find((c: { type?: string }) => c?.type === "text")?.text ?? "";
    if (!reply) return json({ error: "Empty answer — try again." }, 502);

    await supabase.from("assistant_usage").upsert({ id: 1, count: (usage?.count ?? 0) + 1 });
    return json({ ok: true, reply });
  } catch (e) {
    console.error(e);
    return json({ error: "Unexpected error." }, 500);
  }
});
