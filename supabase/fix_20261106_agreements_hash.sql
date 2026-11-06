-- Pulse fix (Nov 6, 2026): agreements hashing/signing without pgcrypto. Safe to run more than once.
create or replace function public.pulse_sha256(p text) returns text language sql immutable set search_path = pg_catalog as $$
  select encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex') $$;
create or replace function public.pulse_token() returns text language sql volatile set search_path = pg_catalog as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') $$;
create or replace function public.agr_send(p_id bigint, p_signers jsonb, p_days int default 30) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare a agreements; s jsonb; tok text; out jsonb := '[]'; v_uid uuid;
begin
  a := agr_get(p_id);
  if a.status <> 'Draft' then raise exception 'Only drafts can be sent.'; end if;
  if coalesce(a.body_html, '') = '' then raise exception 'The agreement has no text yet.'; end if;
  if a.body_html ~ 'agr-blank' then raise exception 'Fill in every blank before sending (look for the [highlighted] gaps).'; end if;
  if jsonb_typeof(p_signers) <> 'array' or jsonb_array_length(p_signers) = 0 then raise exception 'Add at least one signer.'; end if;
  delete from agreement_signers where agreement_id = p_id;
  for s in select value from jsonb_array_elements(p_signers) loop
    if coalesce(trim(s ->> 'name'), '') = '' then raise exception 'Every signer needs a name.'; end if;
    if coalesce(s ->> 'email', '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Every signer needs a valid email (%).', s ->> 'name'; end if;
    v_uid := nullif(s ->> 'user_id', '')::uuid;
    if v_uid is null then select id into v_uid from profiles where workspace_id = a.workspace_id and lower(email) = lower(s ->> 'email') and active limit 1; end if;
    tok := pulse_token();
    insert into agreement_signers (workspace_id, agreement_id, role, label, sign_order, name, email, title, user_id, token_hash, token_expires_at)
    values (a.workspace_id, p_id, coalesce(s ->> 'role', 'party'), s ->> 'label', coalesce((s ->> 'sign_order')::int, 1), trim(s ->> 'name'),
            lower(trim(s ->> 'email')), nullif(trim(s ->> 'title'), ''), v_uid, pulse_sha256(tok), now() + make_interval(days => greatest(1, least(p_days, 90))));
    out := out || jsonb_build_object('role', coalesce(s ->> 'role', 'party'), 'name', trim(s ->> 'name'), 'email', lower(trim(s ->> 'email')), 'token', tok);
  end loop;
  update agreements set status = 'Out for signature', sent_at = now(), doc_hash = pulse_sha256(body_html), updated_at = now() where id = p_id;
  perform agr_log(p_id, 'sent', 'Sent for signature to ' || (select string_agg(name, ', ' order by sign_order) from agreement_signers where agreement_id = p_id)
    || '. Document fingerprint ' || left((select doc_hash from agreements where id = p_id), 16) || '…');
  return out;
end $$;
create or replace function public.agr_new_link(p_signer bigint) returns text
language plpgsql volatile security definer set search_path = public as $$
declare s agreement_signers; a agreements; tok text := pulse_token();
begin
  select * into s from agreement_signers where id = p_signer; a := agr_get(s.agreement_id);
  if a.status <> 'Out for signature' or s.status in ('Signed', 'Declined') then raise exception 'This signer can''t get a new link.'; end if;
  update agreement_signers set token_hash = pulse_sha256(tok), token_expires_at = now() + interval '30 days' where id = p_signer;
  perform agr_log(a.id, 'link', 'New signing link for ' || s.name);
  return tok;
end $$;
create or replace function public.sign_lookup(p_token text) returns agreement_signers
language plpgsql stable security definer set search_path = public as $$
declare s agreement_signers;
begin
  select * into s from agreement_signers where token_hash = pulse_sha256(coalesce(p_token, ''));
  if not found then raise exception 'This signing link isn''t valid. Ask the sender for a new one.'; end if;
  if s.token_expires_at < now() and s.status not in ('Signed', 'Declined') then raise exception 'This signing link has expired. Ask the sender for a new one.'; end if;
  return s;
end $$;
create or replace function public.sign_submit(p_token text, p_name text, p_title text, p_kind text, p_data text, p_consent boolean, p_user_agent text default null) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare s agreement_signers; a agreements;
begin
  s := sign_lookup(p_token);
  select * into a from agreements where id = s.agreement_id for update;
  if a.status <> 'Out for signature' then raise exception 'This agreement is no longer open for signature (%).', a.status; end if;
  if s.status in ('Signed', 'Declined') then raise exception 'You have already responded to this agreement.'; end if;
  if not coalesce(p_consent, false) then raise exception 'Please agree to sign electronically first.'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Type your full name.'; end if;
  if p_kind not in ('typed', 'drawn') then raise exception 'Choose to type or draw your signature.'; end if;
  if p_kind = 'drawn' and (coalesce(p_data, '') !~ '^data:image/png;base64,[A-Za-z0-9+/=]+$' or length(p_data) > 400000) then raise exception 'Draw your signature again.'; end if;
  if p_kind = 'typed' and coalesce(trim(p_data), '') = '' then raise exception 'Type your signature.'; end if;
  if pulse_sha256(a.body_html) <> a.doc_hash then raise exception 'The document changed after it was sent. Ask the sender to send it again.'; end if;
  update agreement_signers set status = 'Signed', name = trim(p_name), title = coalesce(nullif(trim(p_title), ''), title), signed_at = now(), consent_at = now(),
    signature_kind = p_kind, signature_data = case when p_kind = 'typed' then left(trim(p_data), 120) else p_data end,
    ip = coalesce(agr_request_ip(), ip), user_agent = left(p_user_agent, 300)
  where id = s.id;
  perform agr_log(a.id, 'signed', trim(p_name) || ' signed (' || p_kind || ' signature) and agreed to sign electronically', trim(p_name));
  perform agr_maybe_execute(a.id);
  return sign_view(p_token);
end $$;
create or replace function public.agr_upload_signed(p_id bigint, p_name text, p_mime text, p_b64 text, p_executed date default null) returns void
language plpgsql volatile security definer set search_path = public as $$
declare a agreements;
begin
  a := agr_get(p_id);
  if a.status in ('Voided', 'Closed out') then raise exception 'This agreement is %.', lower(a.status); end if;
  if length(coalesce(p_b64, '')) > 14000000 then raise exception 'Files up to 10 MB, please.'; end if;
  insert into agreement_files (workspace_id, agreement_id, name, mime, size, sha256, data_b64, uploaded_by)
  values (a.workspace_id, p_id, left(coalesce(p_name, 'signed.pdf'), 200), p_mime, (length(p_b64) * 3 / 4), pulse_sha256(p_b64), p_b64, member_name());
  if a.status in ('Draft', 'Out for signature', 'Declined') then
    update agreements set status = 'Active', executed_at = coalesce(p_executed::timestamptz, now()), executed_via = 'Signed copy uploaded',
      doc_hash = coalesce(doc_hash, pulse_sha256(coalesce(body_html, ''))), updated_at = now() where id = p_id;
    update agreement_signers set token_hash = null where agreement_id = p_id and status <> 'Signed';
    perform agr_log(p_id, 'executed', 'Signed copy uploaded: ' || coalesce(p_name, 'file'));
    if a.onboarding_id is not null then perform agr_tick_onboarding(p_id); end if;
  else
    perform agr_log(p_id, 'file', 'Added file: ' || coalesce(p_name, 'file'));
  end if;
end $$;
create or replace function public.agr_sign_member(p_id bigint, p_name text, p_title text, p_kind text, p_data text, p_consent boolean, p_user_agent text default null) returns void
language plpgsql volatile security definer set search_path = public as $$
declare s agreement_signers; tok text := pulse_token();
begin
  select * into s from agreement_signers where agreement_id = p_id and user_id = auth.uid() and status not in ('Signed', 'Declined') order by sign_order limit 1;
  if not found then raise exception 'You aren''t waiting to sign this agreement.'; end if;
  update agreement_signers set token_hash = pulse_sha256(tok), token_expires_at = now() + interval '1 hour' where id = s.id;
  perform sign_submit(tok, p_name, p_title, p_kind, p_data, p_consent, p_user_agent);
end $$;
notify pgrst, 'reload schema';
