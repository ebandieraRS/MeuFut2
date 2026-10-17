-- Migration 004: allow adding a guest from a valid shared match link.
-- The guest becomes a regular active player with skill level 3 and gets a
-- presence status for this match (confirmed or waitlist if the match is full).
-- Execute after migrations 001, 002, and 003 if present.

create or replace function public.add_guest_to_match(
  p_token text,
  p_player_name text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match uuid;
  v_group uuid;
  v_limit integer;
  v_name text;
  v_existing uuid;
  v_member uuid;
  v_count integer;
  v_status text;
begin
  v_name := regexp_replace(
    btrim(coalesce(p_player_name, '')),
    '[[:space:]]+', ' ', 'g'
  );

  if char_length(v_name) < 2 or char_length(v_name) > 80 then
    raise exception 'Informe um nome entre 2 e 80 caracteres.';
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
    raise exception 'Link de presença inválido ou expirado.';
  end if;

  -- Serialize guest creation for this group and seat allocation for this match.
  perform 1 from public.matches where id = v_match for update;
  perform 1 from public.football_groups where id = v_group for update;

  -- Recheck the bearer token after acquiring locks in case it was rotated.
  if not exists (
    select 1
      from public.match_attendance_links l
     where l.match_id = v_match
       and l.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
       and l.revoked_at is null
       and l.expires_at > now()
  ) then
    raise exception 'Link de presença inválido ou expirado.';
  end if;

  select gm.id into v_existing
    from public.group_members gm
   where gm.group_id = v_group
     and gm.active
     and lower(btrim(gm.display_name)) = lower(v_name)
   limit 1;

  if v_existing is not null then
    raise exception 'Já existe um jogador ativo com esse nome. Se for você, selecione seu nome na lista; caso contrário, diferencie o nome do convidado.';
  end if;

  insert into public.group_members (
    group_id, user_id, display_name, role, skill_level, active
  ) values (
    v_group, null, v_name, 'player', 3, true
  ) returning id into v_member;

  if v_limit is null then
    v_status := 'confirmed';
  else
    select count(*) into v_count
      from public.attendance
     where match_id = v_match
       and status = 'confirmed';
    v_status := case when v_count < v_limit then 'confirmed' else 'waitlist' end;
  end if;

  insert into public.attendance (match_id, member_id, status, updated_at)
  values (v_match, v_member, v_status, now())
  on conflict (match_id, member_id) do update
    set status = excluded.status, updated_at = now();

  return v_member;
end;
$$;

revoke all on function public.add_guest_to_match(text, text) from public;
grant execute on function public.add_guest_to_match(text, text) to anon, authenticated;
