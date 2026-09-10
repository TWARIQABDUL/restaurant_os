-- ============================================================
-- LOCK DOWN STORAGE WRITES
-- ============================================================
-- lockdown-anon.sql closed the `public` schema to anon/authenticated but said,
-- correctly at the time, that "Storage is unaffected: storage.objects lives in
-- its own schema with its own RLS policies". Those policies were:
--
--   FOR INSERT WITH CHECK ( bucket_id = 'blog-images' )
--   FOR UPDATE USING      ( bucket_id = 'blog-images' )
--   FOR DELETE USING      ( bucket_id = 'blog-images' )
--
-- with no role restriction, which means they granted to `public` — and `public`
-- includes `anon`, whose key ships inside the client bundle. So every visitor
-- could upload arbitrary files into a public bucket, overwrite any product
-- image, or delete the entire bucket's contents across every tenant.
--
-- Reads stay public: the bucket backs <img> tags on storefronts.
-- Writes now go through the API, which issues a signed, single-use upload URL
-- after checking the caller is an admin/manager (server/src/routes/uploads.js).
-- A signed upload is authorized by its token, not by the caller's role, so it
-- keeps working with anon's key while anon itself can no longer write.
--
-- ⚠️  DEPLOY THE API FIRST. Until routes/uploads.js is live and the client is
-- using it, running this file stops image upload from working.
--
-- Safe to re-run.

-- ── Remove the open write policies ─────────────────────────────────────────

DROP POLICY IF EXISTS "Allow Uploads" ON storage.objects;
DROP POLICY IF EXISTS "Allow Updates" ON storage.objects;
DROP POLICY IF EXISTS "Allow Deletes" ON storage.objects;

-- ── Keep public read ───────────────────────────────────────────────────────
-- Recreated rather than assumed, so this file is sufficient on its own.

DROP POLICY IF EXISTS "Public Access" ON storage.objects;
CREATE POLICY "Public Access" ON storage.objects
  FOR SELECT USING ( bucket_id = 'blog-images' );

-- ── Constrain the bucket itself ────────────────────────────────────────────
-- Defence in depth: even a leaked signed URL cannot be used to park a 2 GB file
-- or an HTML page that would execute on the storage origin.

UPDATE storage.buckets
   SET public = true,
       file_size_limit = 5242880,  -- 5 MB
       allowed_mime_types = ARRAY[
         'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'
       ]
 WHERE id = 'blog-images';

-- ── Report ────────────────────────────────────────────────────────────────

DO $$
DECLARE
  write_policies int;
BEGIN
  SELECT count(*) INTO write_policies
  FROM pg_policies
  WHERE schemaname = 'storage'
    AND tablename = 'objects'
    AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
    AND qual IS NOT DISTINCT FROM qual
    AND policyname IN ('Allow Uploads', 'Allow Updates', 'Allow Deletes');

  RAISE NOTICE 'open storage write policies remaining: %', write_policies;

  IF write_policies > 0 THEN
    RAISE EXCEPTION 'Storage lockdown incomplete — % open write policies remain', write_policies;
  END IF;
END $$;
