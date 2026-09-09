import { useState } from 'react';
import api from '../services/api';
import toast from 'react-hot-toast';
import { Plus, Pencil, Trash2, Check, X, Tag } from 'lucide-react';

/**
 * Compact category manager, shown at the top of the Products tab.
 * `onChange` fires after any create / rename / delete so the parent can
 * refresh its own category-dependent lists.
 */
export default function CategoriesManagement({ categories, onChange }) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async (e) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await api.post('/categories', { name });
      setNewName('');
      setAdding(false);
      toast.success('Category added');
      onChange();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to add category');
    } finally {
      setBusy(false);
    }
  };

  const rename = async (cat) => {
    const name = editName.trim();
    if (!name || name === cat.name) { setEditingId(null); return; }
    setBusy(true);
    try {
      await api.put(`/categories/${cat.id}`, { name });
      setEditingId(null);
      toast.success('Category renamed');
      onChange();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to rename');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (cat) => {
    setBusy(true);
    try {
      await api.delete(`/categories/${cat.id}`);
      toast.success('Category deleted');
      onChange();
    } catch (err) {
      const count = err.response?.data?.productCount;
      if (count && window.confirm(
        `${count} product${count === 1 ? '' : 's'} still use "${cat.name}". Delete anyway? Those products become uncategorised and their scoped options fall back to "all products".`,
      )) {
        try {
          await api.delete(`/categories/${cat.id}?force=1`);
          toast.success('Category deleted');
          onChange();
        } catch {
          toast.error('Failed to delete category');
        }
      } else if (!count) {
        toast.error(err.response?.data?.error || 'Failed to delete category');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-[#e2e8f0] bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Tag size={15} className="text-[#94a3b8]" />
          <h3 className="text-[15px] font-semibold">Categories</h3>
          <span className="rounded-full bg-[#f1f5f9] px-2 py-0.5 text-xs font-semibold text-[#475569]">
            {categories.length}
          </span>
        </div>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => { setAdding((v) => !v); setNewName(''); }}
        >
          {adding ? 'Cancel' : <><Plus size={14} /> New category</>}
        </button>
      </div>

      <p className="mb-3 text-xs text-[#94a3b8]">
        Group your products, and decide which options each group shows at checkout.
      </p>

      {adding && (
        <form onSubmit={create} className="mb-3 flex gap-2">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Apparel"
            className="form-input flex-1 !py-1.5 text-sm"
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Add</button>
        </form>
      )}

      {categories.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[#e2e8f0] p-4 text-center text-sm text-[#94a3b8]">
          No categories yet. Add one before creating products.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {categories.map((cat) => (
            <div
              key={cat.id}
              className="flex items-center gap-1.5 rounded-lg border border-[#e2e8f0] bg-[#f8fafc] py-1 pl-3 pr-1.5 text-sm"
            >
              {editingId === cat.id ? (
                <>
                  <input
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && rename(cat)}
                    className="w-28 rounded border border-[#e2e8f0] bg-white px-1.5 py-0.5 text-sm outline-none focus:border-[#dc2626]"
                  />
                  <button onClick={() => rename(cat)} className="icon-btn p-1 text-[#16a34a]" aria-label="Save">
                    <Check size={13} />
                  </button>
                  <button onClick={() => setEditingId(null)} className="icon-btn p-1 text-[#94a3b8]" aria-label="Cancel">
                    <X size={13} />
                  </button>
                </>
              ) : (
                <>
                  <span className="font-medium">{cat.name}</span>
                  <button
                    onClick={() => { setEditingId(cat.id); setEditName(cat.name); }}
                    className="icon-btn p-1 text-[#94a3b8] hover:text-[#0f172a]"
                    aria-label={`Rename ${cat.name}`}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    onClick={() => remove(cat)}
                    className="icon-btn p-1 text-[#94a3b8] hover:text-[#dc2626]"
                    aria-label={`Delete ${cat.name}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
