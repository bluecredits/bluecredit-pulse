// Test helpers: a tiny in-memory stand-in for Supabase's REST API (PostgREST) covering what the functions use.
export function assert(cond: unknown, msg = "assertion failed"): asserts cond { if (!cond) throw new Error(msg); }
export function eq(a: unknown, b: unknown, msg = "") {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg} expected ${y} got ${x}`);
}
export function fakeDb(tables: Record<string, any[]>) {
  let seq = 1;
  const t = tables;
  const match = (row: any, q: URLSearchParams) => {
    for (const [k, v] of q) {
      if (["select", "on_conflict", "order", "limit"].includes(k)) continue;
      const [op, ...rest] = v.split("."); const val = rest.join(".");
      const cell = row[k];
      if (op === "eq" && String(cell) !== val) return false;
      if (op === "in" && !val.replace(/^\(|\)$/g, "").split(",").includes(String(cell))) return false;
      if (op === "gte" && !(String(cell) >= val)) return false;
      if (op === "lte" && !(String(cell) <= val)) return false;
    }
    return true;
  };
  return {
    t,
    async handle(url: string, init: RequestInit = {}) {
      const u = new URL(url), name = u.pathname.split("/rest/v1/")[1], method = init.method || "GET";
      const prefer = String((init.headers as any)?.prefer || "");
      if (name.startsWith("rpc/")) {
        const fn = (t as any)["__rpc_" + name.slice(4)] ?? (name === "rpc/ws_has_app_for" ? () => true : undefined);   // plans: allowed unless a test says otherwise
        return Response.json(fn?.(JSON.parse(String(init.body || "{}")), init) ?? null);
      }
      const rows = (t[name] ||= []);
      if (method === "GET") return Response.json(rows.filter((r) => match(r, u.searchParams)));
      if (method === "DELETE") { t[name] = rows.filter((r) => !match(r, u.searchParams)); return new Response(""); }
      if (method === "PATCH") {
        const patch = JSON.parse(String(init.body)); const out = rows.filter((r) => match(r, u.searchParams));
        out.forEach((r) => Object.assign(r, patch)); return Response.json(prefer.includes("representation") ? out : []);
      }
      if (method === "POST") {
        const body = JSON.parse(String(init.body)); const list = Array.isArray(body) ? body : [body]; const out: any[] = [];
        const keys = (u.searchParams.get("on_conflict") || "").split(",").filter(Boolean);
        for (const b of list) {
          const hit = keys.length && rows.find((r) => keys.every((k) => r[k] === b[k]));
          if (hit && prefer.includes("merge-duplicates")) { Object.assign(hit, b); out.push(hit); }
          else { const r = { id: seq++, ...b }; rows.push(r); out.push(r); }
        }
        return Response.json(prefer.includes("representation") ? out : []);
      }
      return new Response("bad", { status: 400 });
    },
  };
}
