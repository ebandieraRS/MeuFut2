-- Migration 015: allow an administrator to retrieve and copy the current
-- group attendance link without rotating (invalidating) that link.
-- Run after migration 010_group_attendance_link.sql and all later migrations.
--
-- Existing links created before this migration remain valid, but their raw
-- token cannot be reconstructed because only its SHA-256 hash was stored.
-- Generate a new link once after applying this migration; subsequent copies
-- will not rotate it.

ALTER TABLE public.group_attendance_links
  ADD COLUMN IF NOT EXISTS token_value text;

-- Replace the generator so newly generated tokens are retained for the
-- admin-only retrieval RPC. The table still has RLS enabled and no public
-- read policy; clients must use the security-definer admin check below.
CREATE OR REPLACE FUNCTION public.create_group_attendance_link(p_group_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_token text;
BEGIN
  IF NOT public.is_group_admin(p_group_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  INSERT INTO public.group_attendance_links(
    group_id, token_hash, token_value, created_by, created_at, revoked_at
  )
  VALUES(
    p_group_id,
    encode(extensions.digest(v_token, 'sha256'), 'hex'),
    v_token,
    (SELECT auth.uid()),
    now(),
    NULL
  )
  ON CONFLICT(group_id) DO UPDATE SET
    token_hash = EXCLUDED.token_hash,
    token_value = EXCLUDED.token_value,
    created_by = EXCLUDED.created_by,
    created_at = now(),
    revoked_at = NULL;

  RETURN v_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_group_attendance_link(p_group_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_token text;
BEGIN
  IF NOT public.is_group_admin(p_group_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT l.token_value
    INTO v_token
    FROM public.group_attendance_links AS l
   WHERE l.group_id = p_group_id
     AND l.revoked_at IS NULL;

  RETURN v_token;
END;
$$;

REVOKE ALL ON FUNCTION public.create_group_attendance_link(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_group_attendance_link(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.get_group_attendance_link(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_group_attendance_link(uuid) TO authenticated;
