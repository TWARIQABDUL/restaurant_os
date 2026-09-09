import { useState, useEffect, useMemo, useCallback } from 'react';
import api from '../services/api';
import { uploadImage } from '../services/supabase';
import OptionsManagement from './OptionsManagement';
import CategoriesManagement from './CategoriesManagement';
import toast from 'react-hot-toast';
import { Plus, Minus, Pencil, Trash2, Package, Search, AlertTriangle, EyeOff } from 'lucide-react';

const EMPTY = {
  name: '', description: '', price: '', category: '', image_url: '',
  track_inventory: false, stock_quantity: '', low_stock_threshold: 5, sku: '',
  variant_label: 'Size', variants: [],
};

const EMPTY_VARIANT = { name: '', price: '', stock_quantity: '' };

/** Worst stock state across a product's variants, or null if it has none. */
function variantState(p) {
  const vs = p.variants || [];
  if (vs.length === 0) return null;
  if (vs.some((v) => v.stock_quantity <= 0)) return 'out';
  if (vs.some((v) => v.stock_quantity <= (v.low_stock_threshold ?? 0))) return 'low';
  return 'ok';
}

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'low', label: 'Low stock' },
  { key: 'out', label: 'Out of stock' },
  { key: 'hidden', label: 'Hidden' },
];

/** Stock state for one product, or null when it isn't tracked. */
function stockState(p) {
  if (!p.track_inventory) return null;
  if (p.stock_quantity <= 0) return 'out';
  if (p.stock_quantity <= (p.low_stock_threshold ?? 0)) return 'low';
  return 'ok';
}

export default function ProductsManagement() {
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(EMPTY);
  const [imageFile, setImageFile] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [adjustingId, setAdjustingId] = useState(null);

  // NOTE: `/menu` is legacy API naming from when this was restaurant-only.
  // `/menu/manage` returns every product — including hidden and sold-out ones,
  // which the public list deliberately omits.
  const fetchProducts = async () => {
    try {
      const { data } = await api.get('/menu/manage');
      setProducts(data.items || []);
    } catch (err) {
      console.error('Failed to fetch products', err);
      toast.error('Could not load products');
    }
  };

  const fetchCategories = useCallback(async () => {
    try {
      const { data } = await api.get('/categories');
      setCategories(data.categories || []);
    } catch (err) {
      console.error('Failed to fetch categories', err);
    }
  }, []);

  useEffect(() => {
    fetchProducts();
    fetchCategories();
  }, [fetchCategories]);

  // A rename cascades on the server, so refresh products too.
  const onCategoriesChanged = useCallback(() => {
    fetchCategories();
    fetchProducts();
  }, [fetchCategories]);

  const closeForm = () => {
    setIsAdding(false);
    setEditingId(null);
    setDraft(EMPTY);
    setImageFile(null);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      let finalImageUrl = draft.image_url;
      if (imageFile) {
        finalImageUrl = await uploadImage(imageFile, 'blog-images');
      }
      const cleanVariants = (draft.variants || [])
        .filter((v) => v.name.trim())
        .map((v) => ({
          id: v.id,
          name: v.name.trim(),
          price: Number(v.price) || 0,
          stock_quantity: Math.max(0, Number(v.stock_quantity) || 0),
        }));

      const payload = {
        name: draft.name,
        description: draft.description,
        price: draft.price,
        category: draft.category,
        image_url: finalImageUrl,
        track_inventory: draft.track_inventory,
        stock_quantity: draft.track_inventory ? Number(draft.stock_quantity) || 0 : 0,
        low_stock_threshold: Number(draft.low_stock_threshold) || 0,
        sku: draft.sku?.trim() || null,
        variant_label: draft.variant_label,
        // Always send on edit so removed rows sync; on create only if any exist.
        ...(editingId || cleanVariants.length > 0 ? { variants: cleanVariants } : {}),
      };

      if (editingId) {
        await api.put(`/menu/${editingId}`, payload);
      } else {
        await api.post('/menu', payload);
      }
      toast.success(editingId ? 'Product updated' : 'Product added');
      closeForm();
      fetchProducts();
    } catch (err) {
      toast.error(err.response?.data?.error || err.message || 'Failed to save product');
    } finally {
      setIsSaving(false);
    }
  };

  const handleEdit = (product) => {
    setEditingId(product.id);
    setDraft({
      name: product.name,
      description: product.description || '',
      price: product.price,
      category: product.category,
      image_url: product.image_url || '',
      track_inventory: !!product.track_inventory,
      stock_quantity: product.stock_quantity ?? '',
      low_stock_threshold: product.low_stock_threshold ?? 5,
      sku: product.sku || '',
      variant_label: product.variants?.[0]?.category
        ? product.variants[0].category.charAt(0).toUpperCase() + product.variants[0].category.slice(1)
        : 'Size',
      variants: (product.variants || []).map((v) => ({
        id: v.id, name: v.name, price: v.price, stock_quantity: v.stock_quantity,
      })),
    });
    setImageFile(null);
    setIsAdding(true);
  };

  const setVariant = (i, patch) => setDraft((d) => ({
    ...d,
    variants: d.variants.map((v, j) => (j === i ? { ...v, ...patch } : v)),
  }));
  const addVariant = () => setDraft((d) => ({ ...d, variants: [...d.variants, { ...EMPTY_VARIANT }] }));
  const removeVariant = (i) => setDraft((d) => ({ ...d, variants: d.variants.filter((_, j) => j !== i) }));

  const handleDelete = async (product) => {
    if (!window.confirm(`Delete "${product.name}"? This can't be undone.`)) return;
    try {
      await api.delete(`/menu/${product.id}`);
      toast.success('Product deleted');
      fetchProducts();
    } catch {
      toast.error('Failed to delete product');
    }
  };

  /** Quick +1 / −1 from the table, without opening the form. */
  const adjustStock = async (product, delta) => {
    setAdjustingId(product.id);
    // Optimistic — the row updates immediately, then reconciles.
    setProducts((prev) => prev.map((p) => (
      p.id === product.id
        ? { ...p, stock_quantity: Math.max(0, (p.stock_quantity || 0) + delta) }
        : p
    )));
    try {
      const { data } = await api.patch(`/menu/${product.id}/stock`, { delta });
      setProducts((prev) => prev.map((p) => (p.id === product.id ? data.item : p)));
    } catch {
      toast.error('Could not update stock');
      fetchProducts();
    } finally {
      setAdjustingId(null);
    }
  };

  // Worst of product-level and variant-level stock state.
  const worstState = (p) => {
    const a = stockState(p);
    const b = variantState(p);
    if (a === 'out' || b === 'out') return 'out';
    if (a === 'low' || b === 'low') return 'low';
    return a || b;
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter((p) => {
      const state = worstState(p);
      if (filter === 'low' && state !== 'low') return false;
      if (filter === 'out' && state !== 'out') return false;
      if (filter === 'hidden' && p.available) return false;
      if (!q) return true;
      return (
        p.name?.toLowerCase().includes(q) ||
        p.category?.toLowerCase().includes(q) ||
        p.sku?.toLowerCase().includes(q)
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, query, filter]);

  const categoryNames = categories.map((c) => c.name);
  const lowCount = products.filter((p) => worstState(p) === 'low').length;
  const outCount = products.filter((p) => worstState(p) === 'out').length;
  const noCategories = categories.length === 0;

  return (
    <div className="flex flex-col gap-8">
      <CategoriesManagement categories={categories} onChange={onCategoriesChanged} />

      <div>
        {/* Stock alerts */}
        {(lowCount > 0 || outCount > 0) && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-[#fde68a] bg-[#fffbeb] px-4 py-3">
            <AlertTriangle size={16} className="shrink-0 text-[#d97706]" />
            <span className="text-sm text-[#92400e]">
              {outCount > 0 && <strong className="font-semibold">{outCount} out of stock</strong>}
              {outCount > 0 && lowCount > 0 && ' · '}
              {lowCount > 0 && <strong className="font-semibold">{lowCount} running low</strong>}
            </span>
            <button
              onClick={() => setFilter(outCount > 0 ? 'out' : 'low')}
              className="ml-auto text-xs font-semibold text-[#92400e] underline"
            >
              Show them
            </button>
          </div>
        )}

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h3 className="text-[15px] font-semibold">Products</h3>
            <span className="rounded-full bg-[#f1f5f9] px-2 py-0.5 text-xs font-semibold text-[#475569]">
              {filtered.length}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {products.length > 0 && (
              <>
                <div className="relative">
                  <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#94a3b8]" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search name, category or SKU"
                    className="w-56 rounded-lg border border-[#e2e8f0] bg-[#f8fafc] py-1.5 pl-8 pr-3 text-sm outline-none transition-colors focus:border-[#dc2626] focus:bg-white"
                  />
                </div>
                <div className="flex gap-1 rounded-lg bg-[#f1f5f9] p-1">
                  {FILTERS.map((f) => (
                    <button
                      key={f.key}
                      onClick={() => setFilter(f.key)}
                      className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                        filter === f.key ? 'bg-white text-[#0f172a] shadow-[0_1px_2px_rgba(15,23,42,0.06)]' : 'text-[#94a3b8] hover:text-[#475569]'
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </>
            )}
            <button
              className="btn btn-primary btn-sm"
              onClick={() => (isAdding ? closeForm() : setIsAdding(true))}
              disabled={noCategories && !isAdding}
              title={noCategories ? 'Add a category first' : undefined}
            >
              {isAdding ? 'Cancel' : <><Plus size={14} /> Add product</>}
            </button>
          </div>
        </div>

        {isAdding && (
          <div className="mb-5 rounded-xl border border-[#e2e8f0] bg-[#f8fafc] p-5">
            <h4 className="mb-4 text-sm font-semibold">{editingId ? 'Edit product' : 'New product'}</h4>
            <form onSubmit={handleSave} className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="form-label">Product name</label>
                  <input
                    type="text" className="form-input" required
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </div>
                <div>
                  <label className="form-label">Category</label>
                  <select
                    className="form-select" required
                    value={draft.category}
                    onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                  >
                    <option value="" disabled>Choose a category…</option>
                    {categoryNames.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <p className="mt-1 text-[11px] text-[#94a3b8]">Manage the list in the Categories panel above.</p>
                </div>
                <div>
                  <label className="form-label">Price ($)</label>
                  <input
                    type="number" step="0.01" min="0" className="form-input" required
                    value={draft.price}
                    onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                  />
                </div>
                <div>
                  <label className="form-label">Photo</label>
                  <input
                    type="file" accept="image/*" className="form-input !py-1.5 text-sm"
                    onChange={(e) => e.target.files?.[0] && setImageFile(e.target.files[0])}
                  />
                  {(draft.image_url || imageFile) && (
                    <p className="mt-1 text-[11px] text-[#94a3b8]">
                      {imageFile ? `Selected: ${imageFile.name}` : 'Current photo kept unless you choose a new one'}
                    </p>
                  )}
                </div>
              </div>

              <div>
                <label className="form-label">Description (optional)</label>
                <textarea
                  className="form-textarea min-h-20" rows="2"
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </div>

              {/* Inventory */}
              <div className="rounded-lg border border-[#e2e8f0] bg-white p-4">
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-[18px] w-[18px] shrink-0 accent-[#dc2626]"
                    checked={draft.track_inventory}
                    onChange={(e) => setDraft({ ...draft, track_inventory: e.target.checked })}
                  />
                  <span>
                    <span className="block text-sm font-semibold">Track stock for this product</span>
                    <span className="mt-0.5 block text-xs text-[#94a3b8]">
                      Every sale draws the count down, and it stops taking orders at zero.
                      Leave off for made-to-order goods or services.
                    </span>
                  </span>
                </label>

                {draft.track_inventory && (
                  <div className="mt-4 grid gap-4 border-t border-[#f1f5f9] pt-4 sm:grid-cols-3">
                    <div>
                      <label className="form-label">Units in stock</label>
                      <input
                        type="number" min="0" className="form-input" required
                        value={draft.stock_quantity}
                        onChange={(e) => setDraft({ ...draft, stock_quantity: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="form-label">Warn me at</label>
                      <input
                        type="number" min="0" className="form-input"
                        value={draft.low_stock_threshold}
                        onChange={(e) => setDraft({ ...draft, low_stock_threshold: e.target.value })}
                      />
                      <p className="mt-1 text-[11px] text-[#94a3b8]">Units left before a low-stock warning.</p>
                    </div>
                    <div>
                      <label className="form-label">SKU (optional)</label>
                      <input
                        type="text" className="form-input font-mono text-sm"
                        placeholder="ABC-001"
                        value={draft.sku}
                        onChange={(e) => setDraft({ ...draft, sku: e.target.value })}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Variants — per-product sizes/colours, each with its own stock */}
              <div className="rounded-lg border border-[#e2e8f0] bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold">Variants</span>
                  <input
                    type="text"
                    className="form-input h-8 w-32 !py-1 text-sm"
                    value={draft.variant_label}
                    onChange={(e) => setDraft({ ...draft, variant_label: e.target.value })}
                    placeholder="Size"
                    aria-label="Variant label"
                  />
                </div>
                <p className="mt-1 mb-3 text-xs text-[#94a3b8]">
                  Sizes or colours the customer picks one of. Each keeps its own stock — this shirt's
                  large is separate from any other product's.
                </p>

                {draft.variants.length > 0 && (
                  <div className="mb-2 grid grid-cols-[1fr_5rem_5rem_2rem] gap-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-[#94a3b8]">
                    <span>{draft.variant_label || 'Variant'}</span>
                    <span>+ price</span>
                    <span>Stock</span>
                    <span />
                  </div>
                )}
                <div className="flex flex-col gap-2">
                  {draft.variants.map((v, i) => (
                    <div key={i} className="grid grid-cols-[1fr_5rem_5rem_2rem] gap-2">
                      <input
                        type="text" className="form-input !py-1.5 text-sm" placeholder="e.g. XL"
                        value={v.name} onChange={(e) => setVariant(i, { name: e.target.value })}
                      />
                      <input
                        type="number" step="0.01" min="0" className="form-input !py-1.5 text-sm" placeholder="0"
                        value={v.price} onChange={(e) => setVariant(i, { price: e.target.value })}
                      />
                      <input
                        type="number" min="0" className="form-input !py-1.5 text-sm" placeholder="0"
                        value={v.stock_quantity} onChange={(e) => setVariant(i, { stock_quantity: e.target.value })}
                      />
                      <button
                        type="button" onClick={() => removeVariant(i)}
                        className="icon-btn text-[#94a3b8] hover:text-[#dc2626]" aria-label="Remove variant"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button" onClick={addVariant}
                  className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-[#dc2626] hover:underline"
                >
                  <Plus size={13} /> Add {(draft.variant_label || 'variant').toLowerCase()}
                </button>
              </div>

              <div className="flex gap-2">
                <button type="submit" className="btn btn-primary btn-sm" disabled={isSaving}>
                  {isSaving ? 'Saving…' : 'Save product'}
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={closeForm}>Cancel</button>
              </div>
            </form>
          </div>
        )}

        {filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[#e2e8f0] p-10 text-center">
            <Package size={30} strokeWidth={1.25} className="mx-auto mb-3 text-[#cbd5e1]" />
            <h4 className="text-sm font-semibold text-[#475569]">
              {products.length === 0 ? 'No products yet' : 'Nothing matches'}
            </h4>
            <p className="mt-1 text-sm text-[#94a3b8]">
              {products.length === 0
                ? 'Add your first product and it goes live on your store page straight away.'
                : 'Try a different search or filter.'}
            </p>
          </div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Category</th>
                  <th>Price</th>
                  <th>Stock</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((product) => {
                  const state = stockState(product);
                  const vState = variantState(product);
                  return (
                    <tr key={product.id}>
                      <td>
                        <div className="flex items-center gap-3">
                          {product.image_url ? (
                            <img src={product.image_url} alt={product.name} className="h-10 w-10 shrink-0 rounded-lg object-cover" />
                          ) : (
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#eef2f6] text-[#cbd5e1]">
                              <Package size={16} />
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-sm font-semibold">{product.name}</span>
                              {!product.available && (
                                <span title="Hidden from your store" className="text-[#94a3b8]">
                                  <EyeOff size={13} />
                                </span>
                              )}
                            </div>
                            <div className="truncate text-xs text-[#94a3b8]">
                              {product.sku ? <span className="font-mono">{product.sku}</span> : product.description}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="text-sm text-[#475569]">{product.category}</td>
                      <td className="text-sm font-semibold">${parseFloat(product.price).toFixed(2)}</td>
                      <td>
                        {product.variants?.length > 0 ? (
                          <button
                            onClick={() => handleEdit(product)}
                            className="inline-flex items-center gap-1.5 text-left"
                          >
                            <span className="text-sm font-semibold">
                              {product.variants.reduce((s, v) => s + (v.stock_quantity || 0), 0)}
                            </span>
                            <span className="text-xs text-[#94a3b8]">
                              across {product.variants.length} {(product.variants[0].category || 'variant')}s
                            </span>
                            {vState === 'out' && (
                              <span className="rounded-full bg-[#fee2e2] px-2 py-0.5 text-[10px] font-bold uppercase text-[#dc2626]">
                                A {product.variants[0].category || 'variant'} sold out
                              </span>
                            )}
                            {vState === 'low' && (
                              <span className="rounded-full bg-[#fef3c7] px-2 py-0.5 text-[10px] font-bold uppercase text-[#d97706]">
                                Low
                              </span>
                            )}
                          </button>
                        ) : state === null ? (
                          <span className="text-xs text-[#94a3b8]">Not tracked</span>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => adjustStock(product, -1)}
                              disabled={adjustingId === product.id || product.stock_quantity <= 0}
                              className="icon-btn h-6 w-6 rounded-md border border-[#e2e8f0] text-[#475569] hover:border-[#cbd5e1] disabled:opacity-40"
                              aria-label={`Decrease stock of ${product.name}`}
                            >
                              <Minus size={12} />
                            </button>
                            <span
                              className={`min-w-[2rem] text-center text-sm font-bold ${
                                state === 'out' ? 'text-[#dc2626]' : state === 'low' ? 'text-[#d97706]' : 'text-[#0f172a]'
                              }`}
                            >
                              {product.stock_quantity}
                            </span>
                            <button
                              onClick={() => adjustStock(product, 1)}
                              disabled={adjustingId === product.id}
                              className="icon-btn h-6 w-6 rounded-md border border-[#e2e8f0] text-[#475569] hover:border-[#cbd5e1] disabled:opacity-40"
                              aria-label={`Increase stock of ${product.name}`}
                            >
                              <Plus size={12} />
                            </button>
                            {state === 'out' && (
                              <span className="ml-1 rounded-full bg-[#fee2e2] px-2 py-0.5 text-[10px] font-bold uppercase text-[#dc2626]">
                                Sold out
                              </span>
                            )}
                            {state === 'low' && (
                              <span className="ml-1 rounded-full bg-[#fef3c7] px-2 py-0.5 text-[10px] font-bold uppercase text-[#d97706]">
                                Low
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="flex justify-end gap-1">
                          <button
                            onClick={() => handleEdit(product)}
                            className="icon-btn p-1.5 text-[#94a3b8] hover:text-[#0f172a]"
                            title="Edit"
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            onClick={() => handleDelete(product)}
                            className="icon-btn p-1.5 text-[#94a3b8] hover:text-[#dc2626]"
                            title="Delete"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="border-t border-[#e2e8f0] pt-7">
        <OptionsManagement categories={categoryNames} />
      </div>
    </div>
  );
}
