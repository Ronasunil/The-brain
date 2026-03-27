-- ============================================
-- OrgBrain — Admin analytics snapshot (RPC)
-- Run in Supabase SQL Editor after 001 + 002
-- ============================================

CREATE OR REPLACE FUNCTION admin_analytics_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'generated_at', to_jsonb(now() AT TIME ZONE 'utc'),
    'code_totals', (
      SELECT jsonb_build_object(
        'chunk_count', COUNT(*)::bigint,
        'content_bytes', COALESCE(SUM(octet_length(content)), 0)::bigint,
        'embedded_chunks', COUNT(*) FILTER (WHERE embedding IS NOT NULL)::bigint,
        'pending_embedding', COUNT(*) FILTER (WHERE embedding IS NULL)::bigint,
        'distinct_files', COUNT(DISTINCT file_path)::bigint
      )
      FROM code_chunks
    ),
    'code_repos', (
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'workspace_id', bk.workspace_id,
            'repo_name', bk.repo_key,
            'chunk_count', bk.chunk_count,
            'file_count', bk.file_count,
            'content_bytes', bk.content_bytes,
            'embedded_chunks', bk.embedded_chunks,
            'pending_embedding', bk.pending_embedding
          )
          ORDER BY bk.chunk_count DESC
        ),
        '[]'::jsonb
      )
      FROM (
        SELECT
          c.workspace_id,
          COALESCE(NULLIF(trim(c.repo_name), ''), '(unnamed)') AS repo_key,
          COUNT(*)::bigint AS chunk_count,
          COUNT(DISTINCT c.file_path)::bigint AS file_count,
          COALESCE(SUM(octet_length(c.content)), 0)::bigint AS content_bytes,
          COUNT(*) FILTER (WHERE c.embedding IS NOT NULL)::bigint AS embedded_chunks,
          COUNT(*) FILTER (WHERE c.embedding IS NULL)::bigint AS pending_embedding
        FROM code_chunks c
        GROUP BY c.workspace_id, COALESCE(NULLIF(trim(c.repo_name), ''), '(unnamed)')
      ) bk
    ),
    'messages_totals', (
      SELECT jsonb_build_object(
        'message_count', COUNT(*)::bigint,
        'embedded_messages', COUNT(*) FILTER (WHERE embedding IS NOT NULL)::bigint,
        'pending_embedding', COUNT(*) FILTER (WHERE embedding IS NULL)::bigint,
        'content_bytes', COALESCE(SUM(octet_length(content)), 0)::bigint
      )
      FROM messages
    )
  ) INTO result;

  RETURN result;
END;
$$;

COMMENT ON FUNCTION admin_analytics_snapshot() IS
  'Aggregated OrgBrain stats for admin dashboard (code repos, chunks, messages).';

GRANT EXECUTE ON FUNCTION admin_analytics_snapshot() TO service_role;
GRANT EXECUTE ON FUNCTION admin_analytics_snapshot() TO authenticated;
