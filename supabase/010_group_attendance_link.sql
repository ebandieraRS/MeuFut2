-- Migration 010: one reusable public attendance link per group.
-- Run after existing migrations 001-009.
-- The raw token is returned only when generated/rotated; only its hash is stored.
CREATE TABLE IF NOT EXISTS public.group_attendance_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL UNIQUE REFERENCES public.football_groups(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
ALTER TABLE public.group_attendance_links ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.create_group_attendance_link(p_group_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_token text;
BEGIN
  IF NOT public.is_group_admin(p_group_id) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  INSERT INTO public.group_attendance_links(group_id, token_hash, created_by, created_at, revoked_at)
  VALUES(p_group_id, encode(extensions.digest(v_token, 'sha256'), 'hex'), (SELECT auth.uid()), now(), NULL)
  ON CONFLICT(group_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,
    created_by=EXCLUDED.created_by, created_at=now(), revoked_at=NULL;
  RETURN v_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_group_attendance_matches(p_token text)
RETURNS TABLE(group_id uuid, group_name text, match_id uuid, match_title text, starts_at timestamptz, location text, player_limit integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT g.id, g.name, m.id, m.title, m.starts_at, m.location, m.player_limit
  FROM public.group_attendance_links l
  JOIN public.football_groups g ON g.id=l.group_id
  JOIN public.matches m ON m.group_id=g.id
  WHERE l.token_hash=encode(extensions.digest(p_token, 'sha256'), 'hex')
    AND l.revoked_at IS NULL AND m.status='scheduled'
  ORDER BY m.starts_at;
$$;

CREATE OR REPLACE FUNCTION public.get_group_match_attendance_info(p_token text, p_match_id uuid)
RETURNS TABLE(member_id uuid, player_name text, attendance_status text, attendance_updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT gm.id, gm.display_name, coalesce(a.status, 'not_responded'), a.updated_at
  FROM public.group_attendance_links l
  JOIN public.matches m ON m.group_id=l.group_id
  JOIN public.group_members gm ON gm.group_id=l.group_id AND gm.active
  LEFT JOIN public.attendance a ON a.match_id=m.id AND a.member_id=gm.id
  WHERE l.token_hash=encode(extensions.digest(p_token, 'sha256'), 'hex')
    AND l.revoked_at IS NULL AND m.id=p_match_id AND m.status='scheduled'
  ORDER BY gm.display_name;
$$;

CREATE OR REPLACE FUNCTION public.respond_to_group_match_attendance(p_token text, p_match_id uuid, p_member_id uuid, p_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_group uuid; v_limit integer; v_count integer;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('confirmed', 'declined') THEN RAISE EXCEPTION 'Invalid status'; END IF;
  SELECT l.group_id, m.player_limit INTO v_group, v_limit
  FROM public.group_attendance_links l JOIN public.matches m ON m.group_id=l.group_id
  WHERE l.token_hash=encode(extensions.digest(p_token, 'sha256'), 'hex')
    AND l.revoked_at IS NULL AND m.id=p_match_id AND m.status='scheduled';
  IF v_group IS NULL THEN RAISE EXCEPTION 'Link inválido ou pelada indisponível.'; END IF;

  PERFORM 1 FROM public.matches WHERE id=p_match_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM public.group_attendance_links l JOIN public.matches m ON m.group_id=l.group_id
    WHERE l.token_hash=encode(extensions.digest(p_token, 'sha256'), 'hex')
      AND l.revoked_at IS NULL AND l.group_id=v_group AND m.id=p_match_id AND m.status='scheduled'
  ) THEN RAISE EXCEPTION 'Link inválido ou pelada indisponível.'; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.group_members gm WHERE gm.id=p_member_id AND gm.group_id=v_group AND gm.active) THEN
    RAISE EXCEPTION 'Jogador inválido.';
  END IF;

  IF p_status='confirmed' AND v_limit IS NOT NULL THEN
    SELECT count(*) INTO v_count FROM public.attendance
    WHERE match_id=p_match_id AND status='confirmed' AND member_id<>p_member_id;
    IF v_count>=v_limit THEN
      INSERT INTO public.attendance(match_id, member_id, status, updated_at) VALUES(p_match_id,p_member_id,'waitlist',now())
      ON CONFLICT(match_id, member_id) DO UPDATE SET status='waitlist',updated_at=now();
      RETURN true;
    END IF;
  END IF;

  INSERT INTO public.attendance(match_id, member_id, status, updated_at) VALUES(p_match_id,p_member_id,p_status,now())
  ON CONFLICT(match_id, member_id) DO UPDATE SET status=EXCLUDED.status,updated_at=now();
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.add_guest_to_group_match(p_token text, p_match_id uuid, p_player_name text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_group uuid; v_limit integer; v_name text; v_existing uuid; v_member uuid; v_count integer; v_status text;
BEGIN
  v_name:=regexp_replace(btrim(coalesce(p_player_name, '')), '[[:space:]]+', ' ', 'g');
  IF char_length(v_name)<2 OR char_length(v_name)>80 THEN RAISE EXCEPTION 'Informe um nome entre 2 e 80 caracteres.'; END IF;
  SELECT l.group_id,m.player_limit INTO v_group,v_limit
  FROM public.group_attendance_links l JOIN public.matches m ON m.group_id=l.group_id
  WHERE l.token_hash=encode(extensions.digest(p_token, 'sha256'), 'hex')
    AND l.revoked_at IS NULL AND m.id=p_match_id AND m.status='scheduled';
  IF v_group IS NULL THEN RAISE EXCEPTION 'Link inválido ou pelada indisponível.'; END IF;

  PERFORM 1 FROM public.matches WHERE id=p_match_id FOR UPDATE;
  PERFORM 1 FROM public.football_groups WHERE id=v_group FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM public.group_attendance_links l JOIN public.matches m ON m.group_id=l.group_id
    WHERE l.token_hash=encode(extensions.digest(p_token, 'sha256'), 'hex')
      AND l.revoked_at IS NULL AND l.group_id=v_group AND m.id=p_match_id AND m.status='scheduled'
  ) THEN RAISE EXCEPTION 'Link inválido ou pelada indisponível.'; END IF;

  SELECT gm.id INTO v_existing FROM public.group_members gm
  WHERE gm.group_id=v_group AND gm.active AND lower(btrim(gm.display_name))=lower(v_name) LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'Já existe um jogador ativo com esse nome. Se for você, selecione o nome existente na lista; caso contrário, diferencie o nome do convidado.';
  END IF;
  INSERT INTO public.group_members(group_id,user_id,display_name,role,skill_level,active)
  VALUES(v_group,NULL,v_name,'player',3,true) RETURNING id INTO v_member;

  IF v_limit IS NULL THEN v_status:='confirmed';
  ELSE
    SELECT count(*) INTO v_count FROM public.attendance WHERE match_id=p_match_id AND status='confirmed';
    v_status:=CASE WHEN v_count<v_limit THEN 'confirmed' ELSE 'waitlist' END;
  END IF;
  INSERT INTO public.attendance(match_id,member_id,status,updated_at) VALUES(p_match_id,v_member,v_status,now())
  ON CONFLICT(match_id,member_id) DO UPDATE SET status=EXCLUDED.status,updated_at=now();
  RETURN v_member;
END;
$$;

REVOKE ALL ON FUNCTION public.create_group_attendance_link(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_group_attendance_link(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.get_group_attendance_matches(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_group_attendance_matches(text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.get_group_match_attendance_info(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_group_match_attendance_info(text, uuid) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.respond_to_group_match_attendance(text, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.respond_to_group_match_attendance(text, uuid, uuid, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.add_guest_to_group_match(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_guest_to_group_match(text, uuid, text) TO anon, authenticated;
