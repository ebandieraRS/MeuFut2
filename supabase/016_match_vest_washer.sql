-- Migration 016: store the player responsible for washing the vests for each match.
-- Run after migration 015_group_link_copy.sql and the previous app migrations.

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS vest_washer_member_id uuid,
  ADD COLUMN IF NOT EXISTS vest_washer_name text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint
     WHERE conname = 'matches_vest_washer_member_id_fkey'
       AND conrelid = 'public.matches'::regclass
  ) THEN
    ALTER TABLE public.matches
      ADD CONSTRAINT matches_vest_washer_member_id_fkey
      FOREIGN KEY (vest_washer_member_id)
      REFERENCES public.group_members(id)
      ON DELETE SET NULL;
  END IF;
END;
$$;

-- Admin-only assignment. A name snapshot is stored as well, so the historical
-- record remains readable even if the player is later deactivated or removed.
CREATE OR REPLACE FUNCTION public.set_match_vest_washer(
  p_match_id uuid,
  p_member_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_group uuid;
  v_name text;
BEGIN
  SELECT m.group_id
    INTO v_group
    FROM public.matches AS m
   WHERE m.id = p_match_id
   FOR UPDATE;

  IF v_group IS NULL OR NOT public.is_group_admin(v_group) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF p_member_id IS NULL THEN
    UPDATE public.matches
       SET vest_washer_member_id = NULL,
           vest_washer_name = NULL
     WHERE id = p_match_id;

    RETURN pg_catalog.jsonb_build_object(
      'match_id', p_match_id,
      'vest_washer_member_id', NULL,
      'vest_washer_name', NULL
    );
  END IF;

  SELECT gm.display_name
    INTO v_name
    FROM public.group_members AS gm
   WHERE gm.id = p_member_id
     AND gm.group_id = v_group
     AND gm.active = true;

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Jogador inválido ou inativo para este grupo';
  END IF;

  UPDATE public.matches
     SET vest_washer_member_id = p_member_id,
         vest_washer_name = v_name
   WHERE id = p_match_id;

  RETURN pg_catalog.jsonb_build_object(
    'match_id', p_match_id,
    'vest_washer_member_id', p_member_id,
    'vest_washer_name', v_name
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_match_vest_washer(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_match_vest_washer(uuid, uuid) TO authenticated;

-- Extend the public history response with the saved vest-washer name.
-- The function continues exposing only completed matches, their teams and rosters.
CREATE OR REPLACE FUNCTION public.get_public_match_history(p_group_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'match_id', m.id,
        'title', m.title,
        'starts_at', m.starts_at,
        'location', m.location,
        'closed_at', m.closed_at,
        'vest_washer_name', m.vest_washer_name,
        'teams', COALESCE(
          (
            SELECT pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'id', t.id,
                'name', t.name,
                'score', t.score,
                'players', COALESCE(
                  (
                    SELECT pg_catalog.jsonb_agg(gm.display_name ORDER BY gm.display_name)
                    FROM public.team_players AS tp
                    JOIN public.group_members AS gm ON gm.id = tp.member_id
                    WHERE tp.team_id = t.id
                  ),
                  '[]'::pg_catalog.jsonb
                )
              )
              ORDER BY t.name
            )
            FROM public.teams AS t
            WHERE t.match_id = m.id
          ),
          '[]'::pg_catalog.jsonb
        )
      )
      ORDER BY COALESCE(m.closed_at, m.starts_at) DESC, m.starts_at DESC
    ),
    '[]'::pg_catalog.jsonb
  )
  FROM public.matches AS m
  WHERE m.group_id = p_group_id
    AND m.status = 'completed';
$$;

REVOKE ALL ON FUNCTION public.get_public_match_history(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_match_history(uuid) TO anon, authenticated;

-- Include the washer in the unauthenticated group-link match picker as well.
-- PostgreSQL requires dropping/recreating this function because its TABLE
-- return type gains one additional column.
DROP FUNCTION IF EXISTS public.get_group_attendance_matches(text);

CREATE FUNCTION public.get_group_attendance_matches(p_token text)
RETURNS TABLE(
  group_id uuid,
  group_name text,
  match_id uuid,
  match_title text,
  starts_at timestamptz,
  location text,
  player_limit integer,
  vest_washer_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT g.id, g.name, m.id, m.title, m.starts_at, m.location, m.player_limit, m.vest_washer_name
    FROM public.group_attendance_links AS l
    JOIN public.football_groups AS g ON g.id = l.group_id
    JOIN public.matches AS m ON m.group_id = g.id
   WHERE l.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
     AND l.revoked_at IS NULL
     AND m.status = 'scheduled'
   ORDER BY m.starts_at;
$$;

REVOKE ALL ON FUNCTION public.get_group_attendance_matches(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_group_attendance_matches(text) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
