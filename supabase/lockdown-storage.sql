-- ============================================================
-- LOCK DOWN STORAGE WRITES  (bucket: blog-images)
-- ============================================================
-- lockdown-anon.sql closed the `public` schema to anon/authenticated but said,
-- correctly at the time, that "Storage is unaffected: storage.objects lives in
-- its own schema with its own RLS policies". Those policies were the hole.
--
-- A policy with no TO clause grants to `public`, which includes `anon` — and
-- the anon key ships inside the client bundle, so every visitor holds it.
--
-- On blog-images there were two families of policy:
--
--   UNRESTRICTED — the actual breach. No role check at all, so anyone with the
--   anon key could upload arbitrary files, overwrite any product image, or
--   delete the whole bucket's contents across every tenant:
--     "Allow Uploads"  INSERT  WITH CHECK (bucket_id = 'blog-images')
--     "Allow Updates"  UPDATE  USING      (bucket_id = 'blog-images')
--     "Allow Deletes"  DELETE  USING      (bucket_id = 'blog-images')
--
--   auth.role() = 'authenticated' — NOT currently exploitable, because this
--   application does not use Supabase Auth at all (it runs its own JWT against
--   its own users table), so no client ever holds a Supabase session and
--   auth.role() is always 'anon'. They are dropped anyway: they grant nothing
--   today, and they would silently become a full write path for anyone holding
--   any Supabase-authenticated token the moment Supabase Auth is introduced.
--     "Admins can upload images"  /  "Admins can update images"
--     "Admins can delete images"
--
-- Reads stay public: the bucket backs <img> tags on storefronts.
-- Writes now go through the API, which issues a signed, single-use upload URL
-- after checking the caller is an admin/manager (server/src/routes/uploads.js).
-- A signed upload is authorized by its token, not by the caller's role, so it
-- keeps working with anon's key while anon itself can no longer write.
--
-- ⚠️  SCOPE: this file touches ONLY the blog-images bucket. This Supabase
-- project is shared with another application, which owns the `documents` and
-- `opportunities` buckets and has its own world-writable policies on them.
-- Those are deliberately left alone here — see docs/storage-findings.md.
--
-- ⚠️  DEPLOY THE API FIRST. Until routes/uploads.js is live and the client is
-- using it, running this file stops image upload from working.
--
-- Safe to re-run. Apply with: node server/scripts/run-lockdown-storage.js
-- (that runner sends these one at a time with a short lock_timeout — DROP
-- POLICY needs an ACCESS EXCLUSIVE lock on storage.objects, and this database
-- has lock_timeout=0 with statement_timeout=2min, so a single file sent as one
-- query queues behind any concurrent reader and is cancelled wholesale).

-- ── Unrestricted write policies: the breach ────────────────────────────────

DROP POLICY IF EXISTS "Allow Uploads" ON storage.objects;
DROP POLICY IF EXISTS "Allow Updates" ON storage.objects;
DROP POLICY IF EXISTS "Allow Deletes" ON storage.objects;

-- ── Latent write policies gated on a Supabase session this app never creates ──

DROP POLICY IF EXISTS "Admins can upload images" ON storage.objects;
DROP POLICY IF EXISTS "Admins can update images" ON storage.objects;
DROP POLICY IF EXISTS "Admins can delete images" ON storage.objects;

-- ── Keep public read ───────────────────────────────────────────────────────
-- Recreated rather than assumed, so this file is sufficient on its own.
-- ("Public can view images" is a pre-existing duplicate of this policy; it is
-- left in place because it grants exactly the same SELECT and removing it
-- would change nothing.)

DROP POLICY IF EXISTS "Public Access" ON storage.objects;
CREATE POLICY "Public Access" ON storage.objects
  FOR SELECT USING ( bucket_id = 'blog-images' );

-- ── Constrain the bucket itself ────────────────────────────────────────────
-- Defence in depth: even a leaked signed URL cannot be used to park a large
-- file, or an HTML/SVG page that would execute on the storage origin.

UPDATE storage.buckets
   SET public = true,
       file_size_limit = 5242880,  -- 5 MB
       allowed_mime_types = ARRAY[
         'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'
       ]
 WHERE id = 'blog-images';

-- ── Report ────────────────────────────────────────────────────────────────
-- Fails loudly if any writable-by-anon policy still covers blog-images.

DO $$
DECLARE
  leftover TEXT;
BEGIN
  SELECT string_agg(policyname || ' (' || cmd || ')', ', ')
    INTO leftover
  FROM pg_policies
  WHERE schemaname = 'storage'
    AND tablename  = 'objects'
    AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
    AND COALESCE(qual, '') || COALESCE(with_check, '') LIKE '%blog-images%';

  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION 'Storage lockdown incomplete — blog-images is still writable via: %', leftover;
  END IF;

  RAISE NOTICE 'blog-images: no write policies remain. Reads still public.';
END $$;
