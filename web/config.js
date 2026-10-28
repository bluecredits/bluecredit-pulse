/* Supabase connection for BlueCredit Pulse.
 *
 * Both values come from Supabase: Project Settings → API.
 *   supabaseUrl      "Project URL"
 *   supabaseAnonKey  the "anon" / "publishable" key
 *
 * These are safe to commit to a public repo: the anon key can only do what the
 * database's row-level security allows, and every table is locked to members
 * who joined with the company code. NEVER put the service_role / secret key here.
 */
window.PULSE_CONFIG = {
  appName: "BlueCredit Pulse",
  supabaseUrl: "https://dtnohwaxnnwqplmdtdeq.supabase.co",
  supabaseAnonKey: "sb_publishable_LSwFfqry2e6FfcEE_msnHw_dLzj910i",
};
