-- Pulse fix p (2026-11-10): agreement exhibits.
--   * A draft can carry exhibits (Statement of Work, rate schedule, flow-downs…) attached after the signatures.
--     Typed exhibits are part of the agreement text. An exhibit attached as a file is stored with the agreement, and the
--     agreement text records the file's SHA-256 fingerprint, so the signed text pins down exactly which file was agreed.
--   * Signers can download attached exhibits through their signing link.
--   * Copying an agreement copies its exhibit files too.
--   * Fix: "Add a file" on a draft no longer marks the agreement as executed (only "Upload signed copy" does).
-- Safe to run more than once.

-- the fingerprint of the file's bytes (what sha256sum / Get-FileHash prints), not of its base64 text
create or replace function public.pulse_file_sha256(p_b64 text) returns text language sql immutable set search_path = pg_catalog as $$
  select encode(sha256(decode(regexp_replace(coalesce(p_b64, ''), '^data:[^,]*,|\s', '', 'g'), 'base64')), 'hex') $$;

create or replace function public.agr_exhibit_add(p_id bigint, p_name text, p_mime text, p_b64 text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare a agreements; v_id bigint; v_sha text; v_size int;
begin
  perform plan_require('agreements');
  if staff_ws() is null then raise exception 'Only team members can prepare agreements.'; end if;
  a := agr_get(p_id);
  if a.status <> 'Draft' then raise exception 'Exhibits can only be attached while the agreement is a draft.'; end if;
  if coalesce(p_b64, '') = '' then raise exception 'That file is empty.'; end if;
  if length(p_b64) > 14000000 then raise exception 'Files up to 10 MB, please.'; end if;
  begin
    v_sha := pulse_file_sha256(p_b64);
  exception when others then raise exception 'That file couldn''t be read. Try saving it again as a PDF.';
  end;
  v_size := length(regexp_replace(p_b64, '\s', '', 'g')) * 3 / 4;
  insert into agreement_files (workspace_id, agreement_id, name, mime, size, sha256, data_b64, uploaded_by)
  values (a.workspace_id, p_id, left(coalesce(nullif(trim(p_name), ''), 'exhibit.pdf'), 200), p_mime, v_size, v_sha, p_b64, member_name())
  returning id into v_id;
  perform agr_log(p_id, 'file', 'Attached exhibit file: ' || coalesce(p_name, 'file'));
  return jsonb_build_object('id', v_id, 'name', left(coalesce(nullif(trim(p_name), ''), 'exhibit.pdf'), 200), 'sha256', v_sha, 'size', v_size);
end $$;

create or replace function public.agr_exhibit_remove(p_file bigint) returns void
language plpgsql volatile security definer set search_path = public as $$
declare f agreement_files; a agreements;
begin
  perform plan_require('agreements');
  if staff_ws() is null then raise exception 'Only team members can prepare agreements.'; end if;
  select * into f from agreement_files where id = p_file and workspace_id = staff_ws();
  if not found then return; end if;
  a := agr_get(f.agreement_id);
  if a.status <> 'Draft' then raise exception 'This agreement was already sent, so its exhibits are locked.'; end if;
  delete from agreement_files where id = p_file;
  perform agr_log(a.id, 'file', 'Removed exhibit file: ' || f.name);
end $$;

-- a signer downloads an exhibit file named in the agreement they were sent
create or replace function public.sign_exhibit(p_token text, p_file bigint) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare s agreement_signers; a agreements; f agreement_files;
begin
  s := sign_lookup(p_token);
  select * into a from agreements where id = s.agreement_id;
  if not exists (select 1 from jsonb_array_elements(coalesce(a.fields -> 'exhibits', '[]')) e where (e ->> 'file_id') = p_file::text) then
    raise exception 'That exhibit isn''t part of this agreement.';
  end if;
  select * into f from agreement_files where id = p_file and agreement_id = a.id;
  if not found then raise exception 'That exhibit file is missing. Ask the sender to resend it.'; end if;
  perform agr_log(a.id, 'viewed', s.name || ' downloaded exhibit ' || f.name, s.name);
  return jsonb_build_object('name', f.name, 'mime', f.mime, 'data_b64', f.data_b64);
end $$;

-- copying an agreement copies its exhibit files and points the copy at them
create or replace function public.agr_copy(p_id bigint) returns bigint
language plpgsql volatile security definer set search_path = public as $$
declare a agreements; v_id bigint; v_fields jsonb; v_body text; e jsonb; v_new bigint; v_list jsonb := '[]';
begin
  perform plan_require('agreements');
  a := agr_get(p_id);
  v_fields := coalesce(a.fields, '{}'); v_body := a.body_html;
  v_id := agr_save(jsonb_build_object('template_key', a.template_key, 'template_name', a.template_name, 'kind', a.kind, 'title', a.title,
    'party_name', a.party_name, 'party_email', a.party_email, 'fields', v_fields, 'body_html', v_body, 'onboarding_id', a.onboarding_id,
    'contact_id', a.contact_id, 'project_id', a.project_id, 'opportunity_id', a.opportunity_id, 'parent_id', a.parent_id, 'value', a.value,
    'currency', a.currency, 'start_date', a.start_date, 'end_date', a.end_date));
  if jsonb_typeof(v_fields -> 'exhibits') = 'array' then
    for e in select * from jsonb_array_elements(v_fields -> 'exhibits') loop
      v_new := null;
      if nullif(e ->> 'file_id', '') is not null then
        insert into agreement_files (workspace_id, agreement_id, name, mime, size, sha256, data_b64, uploaded_by)
        select workspace_id, v_id, name, mime, size, sha256, data_b64, member_name() from agreement_files
         where id = (e ->> 'file_id')::bigint and agreement_id = a.id
        returning id into v_new;
        if v_new is null then e := e - 'file_id' - 'file_name' - 'sha256' - 'size';
        else
          v_body := replace(v_body, 'data-exfile="' || (e ->> 'file_id') || '"', 'data-exfile="' || v_new || '"');
          e := jsonb_set(e, '{file_id}', to_jsonb(v_new));
        end if;
      end if;
      v_list := v_list || jsonb_build_array(e);
    end loop;
    update agreements set fields = jsonb_set(v_fields, '{exhibits}', v_list), body_html = v_body where id = v_id;
  end if;
  perform agr_log(v_id, 'created', 'Copied from AGR-' || lpad(a.number::text, 4, '0'));
  return v_id;
end $$;

-- "Add a file" (no execution date) only adds a file; "Upload signed copy" (with a date) executes the agreement
create or replace function public.agr_upload_signed(p_id bigint, p_name text, p_mime text, p_b64 text, p_executed date default null) returns void
language plpgsql volatile security definer set search_path = public as $$
declare a agreements;
begin
  perform plan_require('agreements');
  a := agr_get(p_id);
  if a.status in ('Voided', 'Closed out') then raise exception 'This agreement is %.', lower(a.status); end if;
  if length(coalesce(p_b64, '')) > 14000000 then raise exception 'Files up to 10 MB, please.'; end if;
  insert into agreement_files (workspace_id, agreement_id, name, mime, size, sha256, data_b64, uploaded_by)
  values (a.workspace_id, p_id, left(coalesce(p_name, 'signed.pdf'), 200), p_mime, (length(p_b64) * 3 / 4), pulse_sha256(p_b64), p_b64, member_name());
  if p_executed is not null and a.status in ('Draft', 'Out for signature', 'Declined') then
    update agreements set status = 'Active', executed_at = coalesce(p_executed::timestamptz, now()), executed_via = 'Signed copy uploaded',
      doc_hash = coalesce(doc_hash, pulse_sha256(coalesce(body_html, ''))), updated_at = now() where id = p_id;
    update agreement_signers set token_hash = null where agreement_id = p_id and status <> 'Signed';
    perform agr_log(p_id, 'executed', 'Signed copy uploaded: ' || coalesce(p_name, 'file'));
    if a.onboarding_id is not null then perform agr_tick_onboarding(p_id); end if;
  else
    perform agr_log(p_id, 'file', 'Added file: ' || coalesce(p_name, 'file'));
  end if;
end $$;

revoke execute on function public.agr_exhibit_add(bigint, text, text, text), public.agr_exhibit_remove(bigint), public.agr_copy(bigint),
  public.agr_upload_signed(bigint, text, text, text, date), public.sign_exhibit(text, bigint) from public, anon;
grant execute on function public.agr_exhibit_add(bigint, text, text, text), public.agr_exhibit_remove(bigint), public.agr_copy(bigint),
  public.agr_upload_signed(bigint, text, text, text, date) to authenticated;
grant execute on function public.sign_exhibit(text, bigint) to anon, authenticated;
