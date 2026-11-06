// sam-relay: forwards Pulse's SAM.gov opportunity searches.
// Why: api.sam.gov does not accept connections from the database's own network (the TLS handshake
// never completes), so the database's timer asks this function instead, and it asks SAM.gov.
// It only ever calls the SAM.gov "Get Opportunities" search, and only with the caller's own API key,
// so it is safe to deploy with "Verify JWT" turned off (the database timer has no user token).
const SAM = "https://api.sam.gov/opportunities/v2/search";
const ALLOWED = new Set(["api_key", "postedFrom", "postedTo", "limit", "offset", "ptype", "ncode", "typeOfSetAside", "solnum", "noticeid", "title", "state", "zip", "organizationName", "rdlfrom", "rdlto"]);

Deno.serve(async (req) => {
  const inUrl = new URL(req.url);
  if (!inUrl.searchParams.get("api_key")) {
    return Response.json({ error: "api_key is required" }, { status: 400 });
  }
  const out = new URLSearchParams();
  for (const [k, v] of inUrl.searchParams) if (ALLOWED.has(k)) out.set(k, v);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 140_000);
  try {
    const r = await fetch(`${SAM}?${out}`, { signal: ctl.signal, headers: { accept: "application/json" } });
    return new Response(await r.text(), {
      status: r.status,
      headers: { "content-type": r.headers.get("content-type") ?? "application/json" },
    });
  } catch (e) {
    return Response.json({ error: `SAM.gov did not answer the relay: ${e instanceof Error ? e.message : e}` }, { status: 504 });
  } finally {
    clearTimeout(timer);
  }
});
