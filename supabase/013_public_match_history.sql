-- Migration 013: public read-only history of completed matches.
-- Depends on the existing matches/teams/team_players/group_members tables and migration 011 (score).
-- It only exposes completed matches, team names/scores, game date/location and saved rosters.

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
