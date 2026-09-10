const crypto = require('crypto');
const express = require('express');
const supabase = require('../config/supabase');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

const BUCKET = 'blog-images';

// Where a given kind of image is allowed to land. The client used to pass a
// folder name straight through; it now picks from this list, so no caller can
// write outside these prefixes.
const FOLDERS = {
  'menu-items': 'menu-items',
  favicons: 'favicons',
  logos: 'logos',
};

// Raster image types only. Notably absent: svg (scriptable) and html — the
// bucket is public, so anything served from it runs on the storage origin.
const CONTENT_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

/**
 * POST /api/uploads/image-url — hand back a short-lived, single-use URL the
 * browser can upload one image to.
 *
 * Storage used to be writable by `anon`, which is public: the key ships in the
 * client bundle, so "only our upload form uses it" was never true — anyone
 * could overwrite or delete every image in the bucket. Writes are now closed to
 * anon entirely (supabase/lockdown-storage.sql) and go through here, where we
 * know who is asking and get to choose the path and the file type.
 */
router.post(
  '/image-url',
  authenticate,
  authorize('admin', 'manager'),
  async (req, res) => {
    try {
      const { content_type: contentType, folder = 'menu-items' } = req.body;

      const ext = CONTENT_TYPES[contentType];
      if (!ext) {
        return res.status(400).json({
          error: `Unsupported image type. Use one of: ${Object.keys(CONTENT_TYPES).join(', ')}`,
        });
      }

      const prefix = FOLDERS[folder];
      if (!prefix) {
        return res.status(400).json({ error: 'Unknown upload folder' });
      }

      // Tenant-scoped path: an admin can only ever write under their own store's
      // prefix, so one seller cannot overwrite another's imagery even by
      // guessing a filename.
      const name = `${crypto.randomUUID()}.${ext}`;
      const path = `${prefix}/${req.tenant.id}/${name}`;

      const { data, error } = await supabase.storage
        .from(BUCKET)
        .createSignedUploadUrl(path);

      if (error) {
        console.error('Signed upload URL error:', error.message);
        return res.status(500).json({ error: 'Could not prepare the upload' });
      }

      const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);

      res.status(201).json({
        bucket: BUCKET,
        path,
        token: data.token,
        signed_url: data.signedUrl,
        public_url: pub.publicUrl,
      });
    } catch (err) {
      console.error('Upload URL error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
