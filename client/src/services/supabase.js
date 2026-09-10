import { createClient } from '@supabase/supabase-js';
import api from './api';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in client environment variables');
}

// This client is used for exactly one thing: PUTting a file to a signed upload
// URL the API issued (see uploadImage). It has no read or write rights of its
// own — anon holds no privileges on the database, and none on storage beyond
// public read.

export const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseAnonKey || 'placeholder');

/**
 * Upload an image and return its public URL.
 *
 * The browser no longer writes to storage with the anon key — that key is
 * public (it ships in this bundle), so anon-writable storage meant anyone could
 * overwrite or delete every image in the bucket. Instead the API checks we are
 * an admin/manager, picks the destination path, and hands back a signed
 * single-use upload URL that we then PUT the file to.
 *
 * @param {File} file - the file from an <input type="file">
 * @param {string} folder - 'menu-items' | 'favicons' | 'logos'
 * @returns {Promise<string|null>} public URL of the uploaded image
 */
export async function uploadImage(file, folder = 'menu-items') {
  if (!file) return null;

  const { data: slot } = await api.post('/uploads/image-url', {
    content_type: file.type,
    folder,
  });

  const { error } = await supabase.storage
    .from(slot.bucket)
    .uploadToSignedUrl(slot.path, slot.token, file, {
      contentType: file.type,
    });

  if (error) throw error;

  return slot.public_url;
}
