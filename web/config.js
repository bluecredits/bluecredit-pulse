/* Pulse — connection settings.
 *
 * supabaseUrl / supabaseAnonKey come from Supabase: Project Settings → API ("Project URL" and the
 * "anon" / "publishable" key). They're safe in a public repo: the key can only do what the database's
 * row-level security allows. NEVER put the service_role / secret key here.
 *
 * functionsUrl is where the calendar and Chief of Staff server functions run. Leave it commented to use
 * Supabase Edge Functions; deploy/install.sh sets it to https://pulse.bluecredits.org/fn on the Contabo server.
 */
window.PULSE_CONFIG = {
  appName: "Pulse",
  // functionsUrl: "https://pulse.bluecredits.org/fn",
  supabaseUrl: "https://dtnohwaxnnwqplmdtdeq.supabase.co",
  supabaseAnonKey: "sb_publishable_LSwFfqry2e6FfcEE_msnHw_dLzj910i",
};
