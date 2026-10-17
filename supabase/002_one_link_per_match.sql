-- Migração para trocar links individuais por um único link por pelada.
-- Execute depois de 001_schema_and_security.sql no SQL Editor do Supabase.
-- Um link é um bearer token: quem o possui pode selecionar qualquer jogador ativo
-- do grupo. Compartilhe-o somente no grupo esperado.

create table if not exists public.match_attendance_links (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null unique references public.matches(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

alter table public.match_attendance_links enable row level security;
-- Sem políticas diretas: leitura/gravação só pelas funções SECURITY DEFINER.

create or replace function public.create_match_attendance_link(p_match_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group uuid;
  v_token text;
begin
  select group_id into v_group
  from public.matches
  where id = p_match_id;

  if v_group is null or not public.is_group_admin(v_group) then
    raise exception 'Not authorized';
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  -- There is one active link per match. Creating a new one rotates the token
  -- and invalidates any previously shared URL for that match.
  insert into public.match_attendance_links
    (match_id, token_hash, expires_at, created_by, revoked_at)
  values
    (p_match_id, encode(extensions.digest(v_token, 'sha256'), 'hex'),
     now() + interval '14 days', (select auth.uid()), null)
  on conflict (match_id) do update set
    token_hash = excluded.token_hash,
    expires_at = excluded.expires_at,
    created_by = excluded.created_by,
    created_at = now(),
    revoked_at = null;

  return v_token;
end;
$$;

create or replace function public.get_match_attendance_link_info(p_token text)
returns table (
  match_id uuid,
  match_title text,
  starts_at timestamptz,
  location text,
  member_id uuid,
  player_name text,
  attendance_status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    m.id,
    m.title,
    m.starts_at,
    m.location,
    gm.id,
    gm.display_name,
    coalesce(a.status, 'not_responded')
  from public.match_attendance_links l
  join public.matches m on m.id = l.match_id
  join public.group_members gm on gm.group_id = m.group_id and gm.active
  left join public.attendance a on a.match_id = m.id and a.member_id = gm.id
  where l.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and l.revoked_at is null
    and l.expires_at > now()
    and m.status = 'scheduled'
  order by gm.display_name;
$$;

create or replace function public.respond_to_match_attendance(
  p_token text,
  p_member_id uuid,
  p_status text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match uuid;
  v_group uuid;
  v_limit integer;
  v_count integer;
  v_member_active boolean;
begin
  if p_status is null or p_status not in ('confirmed', 'declined') then
    raise exception 'Invalid status';
  end if;

  select m.id, m.group_id, m.player_limit
    into v_match, v_group, v_limit
  from public.match_attendance_links l
  join public.matches m on m.id = l.match_id
  where l.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and l.revoked_at is null
    and l.expires_at > now()
    and m.status = 'scheduled';

  if v_match is null then
    raise exception 'Invalid or expired link';
  end if;

  -- Serialize responses for the same match so concurrent confirmations are
  -- less likely to exceed the player limit.
  perform 1 from public.matches where id = v_match for update;

  -- Recheck link after waiting for the match lock (it may have been rotated).
  if not exists (
    select 1 from public.match_attendance_links l
    where l.match_id = v_match
      and l.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
      and l.revoked_at is null
      and l.expires_at > now()
  ) then
    raise exception 'Invalid or expired link';
  end if;

  select exists (
    select 1 from public.group_members gm
    where gm.id = p_member_id and gm.group_id = v_group and gm.active
  ) into v_member_active;

  if not coalesce(v_member_active, false) then
    raise exception 'Invalid player';
  end if;

  if p_status = 'confirmed' and v_limit is not null then
    select count(*) into v_count
    from public.attendance
    where match_id = v_match
      and status = 'confirmed'
      and member_id <> p_member_id;

    if v_count >= v_limit then
      insert into public.attendance(match_id, member_id, status, updated_at)
      values (v_match, p_member_id, 'waitlist', now())
      on conflict (match_id, member_id) do update
        set status = 'waitlist', updated_at = now();
      return true;
    end if;
  end if;

  insert into public.attendance(match_id, member_id, status, updated_at)
  values (v_match, p_member_id, p_status, now())
  on conflict (match_id, member_id) do update
    set status = excluded.status, updated_at = now();

  return true;
end;
$$;

revoke all on function public.create_match_attendance_link(uuid) from public, anon;
grant execute on function public.create_match_attendance_link(uuid) to authenticated;
revoke all on function public.get_match_attendance_link_info(text) from public;
grant execute on function public.get_match_attendance_link_info(text) to anon, authenticated;
revoke all on function public.respond_to_match_attendance(text, uuid, text) from public;
grant execute on function public.respond_to_match_attendance(text, uuid, text) to anon, authenticated;
