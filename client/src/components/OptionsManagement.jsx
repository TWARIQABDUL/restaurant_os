import { useState, useEffect } from 'react';
import api from '../services/api';
import toast from 'react-hot-toast';
import { Plus, Pencil, Trash2, SlidersHorizontal } from 'lucide-react';

/** Suggested option groups — free text, so sellers can type their own. */
const GROUP_SUGGESTIONS = ['extras', 'packaging', 'warranty', 'gift'];

const ALL_PRODUCTS = '__all__';
const EMPTY = { name: '', price: '', category: 'extras', product_category: ALL_PRODUCTS, single_choice: false };

export default function OptionsManagement({ categories = [] }) {
  const [options, setOptions] = useState([]);
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(EMPTY);
  const [isSaving, setIsSaving] = useState(false);

  const fetchOptions = async () => {
    try {
      const { data } = await api.get('/addons');
      setOptions(data.addOns || []);
    } catch (err) {
      console.error('Failed to fetch options', err);
    }
  };

  useEffect(() => { fetchOptions(); }, []);

  const closeForm = () => {
    setIsAdding(false);
    setEditingId(null);
    setDraft(EMPTY);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      const payload = {
        name: draft.name,
        price: draft.price || 0,
        category: draft.category.trim().toLowerCase(),
        product_category: draft.product_category === ALL_PRODUCTS ? null : draft.product_category,
        single_choice: draft.single_choice,
      };
      if (editingId) await api.put(`/addons/${editingId}`, payload);
      else await api.post('/addons', payload);
      toast.success(editingId ? 'Option updated' : 'Option added');
      closeForm();
      fetchOptions();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save option');
    } finally {
      setIsSaving(false);
    }
  };

  const handleEdit = (option) => {
    setEditingId(option.id);
    setDraft({
      name: option.name,
      price: option.price,
      category: option.category,
      product_category: option.product_category || ALL_PRODUCTS,
      single_choice: !!option.single_choice,
    });
    setIsAdding(true);
  };

  const handleDelete = async (option) => {
    if (!window.confirm(`Delete "${option.name}"? It will be removed from any product using it.`)) return;
    try {
      await api.delete(`/addons/${option.id}`);
      toast.success('Option deleted');
      fetchOptions();
    } catch {
      toast.error('Failed to delete option');
    }
  };

  const grouped = options.reduce((acc, o) => {
    (acc[o.category] = acc[o.category] || []).push(o);
    return acc;
  }, {});

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold">Shared options</h3>
          <p className="mt-0.5 text-xs text-[#94a3b8]">
            Store-wide extras like gift wrap or a warranty. For sizes and colours with their own
            stock, use <span className="font-medium text-[#475569]">Variants</span> on the product.
          </p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => (isAdding ? closeForm() : setIsAdding(true))}>
          {isAdding ? 'Cancel' : <><Plus size={14} /> New option</>}
        </button>
      </div>

      {isAdding && (
        <div className="mt-4 rounded-xl border border-[#e2e8f0] bg-[#f8fafc] p-4">
          <h4 className="mb-3 text-sm font-semibold">{editingId ? 'Edit option' : 'New option'}</h4>
          <form onSubmit={handleSave} className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="form-label">Name</label>
                <input
                  type="text" className="form-input" required placeholder="e.g. Gift wrap"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </div>
              <div>
                <label className="form-label">Extra cost ($)</label>
                <input
                  type="number" step="0.01" min="0" className="form-input" placeholder="0.00"
                  value={draft.price}
                  onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                />
              </div>
              <div>
                <label className="form-label">Option group</label>
                <input
                  type="text" className="form-input" required list="option-groups" placeholder="e.g. extras"
                  value={draft.category}
                  onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                />
                <datalist id="option-groups">
                  {[...new Set([...GROUP_SUGGESTIONS, ...Object.keys(grouped)])].map((g) => (
                    <option key={g} value={g} />
                  ))}
                </datalist>
              </div>
              <div>
                <label className="form-label">Shows on</label>
                <select
                  className="form-select"
                  value={draft.product_category}
                  onChange={(e) => setDraft({ ...draft, product_category: e.target.value })}
                >
                  <option value={ALL_PRODUCTS}>All products</option>
                  {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>

            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[#e2e8f0] bg-white p-3">
              <input
                type="checkbox"
                className="mt-0.5 h-[18px] w-[18px] shrink-0 accent-[#dc2626]"
                checked={draft.single_choice}
                onChange={(e) => setDraft({ ...draft, single_choice: e.target.checked })}
              />
              <span>
                <span className="block text-sm font-semibold">Customer picks one from this group</span>
                <span className="mt-0.5 block text-xs text-[#94a3b8]">
                  Off = an optional add-on with a quantity. On = a required single choice (no stock).
                </span>
              </span>
            </label>

            <div className="flex gap-2">
              <button type="submit" className="btn btn-primary btn-sm" disabled={isSaving}>
                {isSaving ? 'Saving…' : 'Save option'}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={closeForm}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {options.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-[#e2e8f0] p-8 text-center">
          <SlidersHorizontal size={26} strokeWidth={1.25} className="mx-auto mb-2 text-[#cbd5e1]" />
          <p className="text-sm text-[#94a3b8]">No shared options yet.</p>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-4">
          {Object.entries(grouped).map(([group, items]) => {
            const pickOne = items.every((o) => o.single_choice);
            return (
              <div key={group}>
                <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-[#94a3b8]">
                  {group}
                  <span className="rounded-full bg-[#f1f5f9] px-1.5 py-0.5 text-[9px] normal-case tracking-normal">
                    {pickOne ? 'pick one' : 'add-ons'}
                  </span>
                </div>
                <div className="overflow-hidden rounded-xl border border-[#e2e8f0] bg-white">
                  {items.map((option, i) => (
                    <div
                      key={option.id}
                      className={`flex items-center gap-3 px-4 py-2.5 ${i < items.length - 1 ? 'border-b border-[#f1f5f9]' : ''}`}
                    >
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{option.name}</span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        option.product_category ? 'bg-[#eff5ff] text-[#2563eb]' : 'bg-[#f1f5f9] text-[#94a3b8]'
                      }`}>
                        {option.product_category || 'All products'}
                      </span>
                      <span className="shrink-0 text-sm font-semibold text-[#475569]">
                        {parseFloat(option.price) > 0 ? `+$${parseFloat(option.price).toFixed(2)}` : 'Free'}
                      </span>
                      <button onClick={() => handleEdit(option)} className="icon-btn p-1.5 text-[#94a3b8] hover:text-[#0f172a]" title="Edit">
                        <Pencil size={14} />
                      </button>
                      <button onClick={() => handleDelete(option)} className="icon-btn p-1.5 text-[#94a3b8] hover:text-[#dc2626]" title="Delete">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
