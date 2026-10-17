-- Execute em um projeto Supabase novo. Configure primeiro usuário admin no Auth.
create extension if not exists pgcrypto;
create table public.football_groups(id uuid primary key default gen_random_uuid(),name text not null,created_by uuid not null references auth.users(id),created_at timestamptz not null default now());
create table public.group_members(id uuid primary key default gen_random_uuid(),group_id uuid not null references public.football_groups(id) on delete cascade,user_id uuid references auth.users(id),display_name text not null,role text not null default 'player' check(role in('admin','player')),skill_level smallint not null default 3 check(skill_level between 1 and 5),active boolean not null default true,created_at timestamptz not null default now());
create unique index group_member_user_unique on public.group_members(group_id,user_id) where user_id is not null;
create table public.matches(id uuid primary key default gen_random_uuid(),group_id uuid not null references public.football_groups(id) on delete cascade,title text not null default 'Pelada',starts_at timestamptz not null,location text,player_limit integer check(player_limit is null or player_limit>0),status text not null default 'scheduled' check(status in('scheduled','completed','cancelled')),created_at timestamptz not null default now());
create table public.attendance(id uuid primary key default gen_random_uuid(),match_id uuid not null references public.matches(id) on delete cascade,member_id uuid not null references public.group_members(id) on delete cascade,status text not null default 'waitlist' check(status in('confirmed','declined','waitlist')),updated_at timestamptz not null default now(),unique(match_id,member_id));
create table public.attendance_links(id uuid primary key default gen_random_uuid(),match_id uuid not null references public.matches(id) on delete cascade,member_id uuid not null references public.group_members(id) on delete cascade,token_hash text not null unique,expires_at timestamptz not null,created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),revoked_at timestamptz);
create table public.teams(id uuid primary key default gen_random_uuid(),match_id uuid not null references public.matches(id) on delete cascade,name text not null,created_at timestamptz not null default now(),unique(match_id,name));
create table public.team_players(team_id uuid not null references public.teams(id) on delete cascade,member_id uuid not null references public.group_members(id) on delete cascade,skill_level_at_draw smallint not null check(skill_level_at_draw between 1 and 5),primary key(team_id,member_id));
create table public.cash_transactions(id uuid primary key default gen_random_uuid(),group_id uuid not null references public.football_groups(id) on delete cascade,type text not null check(type in('income','expense')),amount_cents bigint not null check(amount_cents>0),description text not null,occurred_at timestamptz not null default now(),created_by uuid not null references auth.users(id),created_at timestamptz not null default now());
create index idx_members_group on public.group_members(group_id,active);
create index idx_matches_group_date on public.matches(group_id,starts_at);
create index idx_attendance_match_status on public.attendance(match_id,status);
create index idx_cash_group_date on public.cash_transactions(group_id,occurred_at desc);

create function public.is_group_member(p_group_id uuid) returns boolean language sql stable security definer set search_path='' as $$ select exists(select 1 from public.group_members gm where gm.group_id=p_group_id and gm.user_id=(select auth.uid()) and gm.active); $$;
create function public.is_group_admin(p_group_id uuid) returns boolean language sql stable security definer set search_path='' as $$ select exists(select 1 from public.group_members gm where gm.group_id=p_group_id and gm.user_id=(select auth.uid()) and gm.active and gm.role='admin'); $$;

alter table public.football_groups enable row level security;
alter table public.group_members enable row level security;
alter table public.matches enable row level security;
alter table public.attendance enable row level security;
alter table public.attendance_links enable row level security;
alter table public.teams enable row level security;
alter table public.team_players enable row level security;
alter table public.cash_transactions enable row level security;

create policy groups_read on public.football_groups for select to authenticated using(public.is_group_member(id));
create policy groups_update on public.football_groups for update to authenticated using(public.is_group_admin(id)) with check(public.is_group_admin(id));
create policy members_read on public.group_members for select to authenticated using(public.is_group_member(group_id));
create policy members_add on public.group_members for insert to authenticated with check(public.is_group_admin(group_id));
create policy members_edit on public.group_members for update to authenticated using(public.is_group_admin(group_id)) with check(public.is_group_admin(group_id));
create policy members_remove on public.group_members for delete to authenticated using(public.is_group_admin(group_id));
create policy matches_read on public.matches for select to authenticated using(public.is_group_member(group_id));
create policy matches_add on public.matches for insert to authenticated with check(public.is_group_admin(group_id));
create policy matches_edit on public.matches for update to authenticated using(public.is_group_admin(group_id)) with check(public.is_group_admin(group_id));
create policy matches_remove on public.matches for delete to authenticated using(public.is_group_admin(group_id));
create policy attendance_read on public.attendance for select to authenticated using(exists(select 1 from public.matches m where m.id=match_id and public.is_group_member(m.group_id)));
create policy attendance_admin_add on public.attendance for insert to authenticated with check(exists(select 1 from public.matches m where m.id=match_id and public.is_group_admin(m.group_id)));
create policy attendance_admin_edit on public.attendance for update to authenticated using(exists(select 1 from public.matches m where m.id=match_id and public.is_group_admin(m.group_id))) with check(exists(select 1 from public.matches m where m.id=match_id and public.is_group_admin(m.group_id)));
create policy attendance_admin_remove on public.attendance for delete to authenticated using(exists(select 1 from public.matches m where m.id=match_id and public.is_group_admin(m.group_id)));
create policy teams_read on public.teams for select to authenticated using(exists(select 1 from public.matches m where m.id=match_id and public.is_group_member(m.group_id)));
create policy teams_add on public.teams for insert to authenticated with check(exists(select 1 from public.matches m where m.id=match_id and public.is_group_admin(m.group_id)));
create policy teams_edit on public.teams for update to authenticated using(exists(select 1 from public.matches m where m.id=match_id and public.is_group_admin(m.group_id))) with check(exists(select 1 from public.matches m where m.id=match_id and public.is_group_admin(m.group_id)));
create policy teams_remove on public.teams for delete to authenticated using(exists(select 1 from public.matches m where m.id=match_id and public.is_group_admin(m.group_id)));
create policy team_players_read on public.team_players for select to authenticated using(exists(select 1 from public.teams t join public.matches m on m.id=t.match_id where t.id=team_id and public.is_group_member(m.group_id)));
create policy team_players_add on public.team_players for insert to authenticated with check(exists(select 1 from public.teams t join public.matches m on m.id=t.match_id where t.id=team_id and public.is_group_admin(m.group_id)));
create policy team_players_remove on public.team_players for delete to authenticated using(exists(select 1 from public.teams t join public.matches m on m.id=t.match_id where t.id=team_id and public.is_group_admin(m.group_id)));
create policy cash_admin_read on public.cash_transactions for select to authenticated using(public.is_group_admin(group_id));
create policy cash_admin_add on public.cash_transactions for insert to authenticated with check(public.is_group_admin(group_id) and created_by=(select auth.uid()));
create policy cash_admin_edit on public.cash_transactions for update to authenticated using(public.is_group_admin(group_id)) with check(public.is_group_admin(group_id));
create policy cash_admin_remove on public.cash_transactions for delete to authenticated using(public.is_group_admin(group_id));

create function public.create_attendance_link(p_match_id uuid,p_member_id uuid) returns text language plpgsql security definer set search_path='' as $$
declare g uuid; tok text;
begin
 select group_id into g from public.matches where id=p_match_id;
 if g is null or not public.is_group_admin(g) then raise exception 'Not authorized'; end if;
 if not exists(select 1 from public.group_members where id=p_member_id and group_id=g and active) then raise exception 'Invalid player'; end if;
 tok:=encode(gen_random_bytes(32),'hex');
 insert into public.attendance_links(match_id,member_id,token_hash,expires_at,created_by) values(p_match_id,p_member_id,encode(digest(tok,'sha256'),'hex'),now()+interval '14 days',(select auth.uid()));
 return tok;
end; $$;

create function public.get_attendance_link_info(p_token text) returns table(match_title text,starts_at timestamptz,location text,player_name text,status text) language sql stable security definer set search_path='' as $$
 select m.title,m.starts_at,m.location,gm.display_name,coalesce(a.status,'waitlist')
 from public.attendance_links l join public.matches m on m.id=l.match_id join public.group_members gm on gm.id=l.member_id
 left join public.attendance a on a.match_id=l.match_id and a.member_id=l.member_id
 where l.token_hash=encode(digest(p_token,'sha256'),'hex') and l.revoked_at is null and l.expires_at>now() and m.status='scheduled' and gm.active;
$$;
create function public.respond_to_attendance(p_token text,p_status text) returns boolean language plpgsql security definer set search_path='' as $$
declare mid uuid; mem uuid; lim integer; cnt integer;
begin
 if p_status not in('confirmed','declined') then raise exception 'Invalid status'; end if;
 select l.match_id,l.member_id,m.player_limit into mid,mem,lim from public.attendance_links l join public.matches m on m.id=l.match_id join public.group_members gm on gm.id=l.member_id
 where l.token_hash=encode(digest(p_token,'sha256'),'hex') and l.revoked_at is null and l.expires_at>now() and m.status='scheduled' and gm.active;
 if mid is null then raise exception 'Invalid or expired link'; end if;
 if p_status='confirmed' and lim is not null then select count(*) into cnt from public.attendance where match_id=mid and status='confirmed' and member_id<>mem;
  if cnt>=lim then insert into public.attendance(match_id,member_id,status,updated_at) values(mid,mem,'waitlist',now()) on conflict(match_id,member_id) do update set status='waitlist',updated_at=now(); return true; end if;
 end if;
 insert into public.attendance(match_id,member_id,status,updated_at) values(mid,mem,p_status,now()) on conflict(match_id,member_id) do update set status=excluded.status,updated_at=now();
 return true;
end; $$;

-- Balance RPC deliberately returns only one number, not transactions; no login required.
create function public.get_group_balance(p_group_id uuid) returns bigint language sql stable security definer set search_path='' as $$
 select coalesce(sum(case when type='income' then amount_cents else -amount_cents end),0)::bigint from public.cash_transactions where group_id=p_group_id;
$$;

create function public.save_balanced_teams(p_match_id uuid,p_teams jsonb) returns void language plpgsql security definer set search_path='' as $$
declare g uuid; t jsonb; p jsonb; tid uuid;
begin
 select group_id into g from public.matches where id=p_match_id;
 if g is null or not public.is_group_admin(g) then raise exception 'Not authorized'; end if;
 if jsonb_typeof(p_teams)<>'array' or jsonb_array_length(p_teams) not between 2 and 4 then raise exception 'Invalid teams payload'; end if;
 delete from public.teams where match_id=p_match_id;
 for t in select value from jsonb_array_elements(p_teams) loop
  insert into public.teams(match_id,name) values(p_match_id,t->>'name') returning id into tid;
  for p in select value from jsonb_array_elements(t->'players') loop
   if not exists(select 1 from public.group_members where id=(p->>'member_id')::uuid and group_id=g and active) then raise exception 'Invalid player'; end if;
   insert into public.team_players(team_id,member_id,skill_level_at_draw) values(tid,(p->>'member_id')::uuid,(p->>'skill_level')::smallint);
  end loop;
 end loop;
end; $$;

revoke all on function public.create_attendance_link(uuid,uuid) from public,anon;
grant execute on function public.create_attendance_link(uuid,uuid) to authenticated;
revoke all on function public.get_attendance_link_info(text) from public;
grant execute on function public.get_attendance_link_info(text) to anon,authenticated;
revoke all on function public.respond_to_attendance(text,text) from public;
grant execute on function public.respond_to_attendance(text,text) to anon,authenticated;
revoke all on function public.get_group_balance(uuid) from public;
grant execute on function public.get_group_balance(uuid) to anon,authenticated;
revoke all on function public.save_balanced_teams(uuid,jsonb) from public,anon;
grant execute on function public.save_balanced_teams(uuid,jsonb) to authenticated;
