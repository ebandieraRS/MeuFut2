-- Migration 008: expose response timestamps for the attendance clipboard order.
-- Execute after migration 002_one_link_per_match.sql and the later project migrations.
-- PostgreSQL requires dropping/recreating the RPC because its return type gains a column.
DROP FUNCTION IF EXISTS public.get_match_attendance_link_info(text);

CREATE FUNCTION public.get_match_attendance_link_info(p_token text)
RETURNS TABLE (
  match_id uuid,
  match_title text,
  starts_at timestamptz,
  location text,
  member_id uuid,
  player_name text,
  attendance_status text,
  attendance_updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    m.id,
    m.title,
    m.starts_at,
    m.location,
    gm.id,
    gm.display_name,
    coalesce(a.status, 'not_responded'),
    a.updated_at
  FROM public.match_attendance_links l
  JOIN public.matches m
    ON m.id = l.match_id
  JOIN public.group_members gm
    ON gm.group_id = m.group_id
   AND gm.active
  LEFT JOIN public.attendance a
    ON a.match_id = m.id
   AND a.member_id = gm.id
  WHERE l.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    AND l.revoked_at IS NULL
    AND l.expires_at > now()
    AND m.status = 'scheduled'
  ORDER BY a.updated_at ASC NULLS LAST, gm.display_name;
$$;

REVOKE ALL ON FUNCTION public.get_match_attendance_link_info(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_match_attendance_link_info(text) TO anon, authenticated;
