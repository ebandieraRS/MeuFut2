-- Migration 017: do not expose the vest-washer name through the public group attendance link.
-- Run after 016_match_vest_washer.sql.
-- The saved washer remains available to the authenticated admin panel and public match history.

DROP FUNCTION IF EXISTS public.get_group_attendance_matches(text);

CREATE FUNCTION public.get_group_attendance_matches(p_token text)
RETURNS TABLE(
  group_id uuid,
  group_name text,
  match_id uuid,
  match_title text,
  starts_at timestamptz,
  location text,
  player_limit integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT g.id, g.name, m.id, m.title, m.starts_at, m.location, m.player_limit
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
