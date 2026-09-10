# Storage findings — including two buckets this app does not own

While fixing SEC-01 I dumped every RLS policy on `storage.objects`, because the
three policies named in the audit turned out not to be the whole picture. What
came back covers three buckets, and only one of them belongs to Restaurant OS.

## `blog-images` — ours. Fixed.

Six write policies existed, in two families.

**Unrestricted — the actual breach, now dropped.** No role test at all, so the
predicate was satisfied by anyone holding the anon key, which ships in the
client bundle:

```
"Allow Uploads"  INSERT  WITH CHECK (bucket_id = 'blog-images')
"Allow Updates"  UPDATE  USING      (bucket_id = 'blog-images')
"Allow Deletes"  DELETE  USING      (bucket_id = 'blog-images')
```

**Gated on `auth.role() = 'authenticated'` — not exploitable, dropped anyway.**

```
"Admins can upload images"  INSERT  WITH CHECK (bucket_id = 'blog-images' AND auth.role() = 'authenticated')
"Admins can update images"  UPDATE  USING      (... same ...)
"Admins can delete images"  DELETE  USING      (... same ...)
```

The audit did not flag these three, and on the evidence they were never a live
hole: this application does not use Supabase Auth at all — it runs its own JWT
against its own `users` table — so no browser ever holds a Supabase session and
`auth.role()` is always `'anon'`. They were dropped because they grant nothing
today and would quietly become a full write path for any Supabase-authenticated
token the moment Supabase Auth is introduced for anything.

Public `SELECT` was kept, so storefront `<img>` tags keep working. The bucket
now also carries a 5 MB size limit and a raster-only MIME allowlist, so a leaked
signed upload URL cannot park an HTML or SVG file that would execute on the
storage origin.

## `documents` and `opportunities` — **not ours. Untouched. Please review.**

This Supabase project is shared with another application. Two buckets belong to
it, both `public = true`, and both carry policies with no role test — meaning
the same anon-key exposure that SEC-01 described:

```
"Allow public uploads"           INSERT  WITH CHECK (bucket_id = 'opportunities')
"venturehub_allow_pdf_uploads"   INSERT  WITH CHECK (bucket_id = 'documents'
                                           AND extension IN ('pdf','jpg','jpeg','png'))
"venturehub_allow_pdf_reads"     SELECT  USING      (bucket_id = 'documents')
```

Anyone holding that project's anon key — which likewise ships in whatever client
that app has — can upload into both buckets. Everything in `documents` is also
world-readable. For a bucket named "documents" holding PDFs, that is worth a
look: if anything in it is not meant to be public, it is public now.

There is no `UPDATE` or `DELETE` policy on either, so existing objects cannot be
overwritten or destroyed — the exposure is unbounded upload, plus unrestricted
read on `documents`.

**I deliberately did not change these.** Dropping a policy that another
application depends on would break that application's uploads, and that is not
a call to make from inside this repo's security work. They need the same
treatment `blog-images` just got — signed upload URLs issued by that app's own
backend — but it has to be done alongside a matching change on its side.

## Re-checking this later

```
node server/scripts/verify-storage-lockdown.js
```

It checks both sides: the policy catalog, and the anon key itself, driven to
genuinely attempt an upload and a delete. A timeout or a rate-limit is reported
as **inconclusive**, never as a pass — the point of the script is to avoid
believing a hole is closed because a probe merely failed to complete.
