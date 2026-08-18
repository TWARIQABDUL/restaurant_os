import { useState, useEffect } from 'react';
import api from '../services/api';

export default function AddonsManagement() {
  const [addOns, setAddOns] = useState([]);
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [newAddOn, setNewAddOn] = useState({ name: '', price: '', category: 'extras' });
  const [isSaving, setIsSaving] = useState(false);

  const fetchAddOns = async () => {
    try {
      const { data } = await api.get('/addons');
      setAddOns(data.addOns || []);
    } catch (err) {
      console.error('Failed to fetch add-ons', err);
    }
  };

  useEffect(() => {
    fetchAddOns();
  }, []);

  const handleSave = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      if (editingId) {
        await api.put(`/addons/${editingId}`, newAddOn);
      } else {
        await api.post('/addons', newAddOn);
      }
      setNewAddOn({ name: '', price: '', category: 'extras' });
      setIsAdding(false);
      setEditingId(null);
      fetchAddOns();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to save add-on');
    } finally {
      setIsSaving(false);
    }
  };

  const handleEdit = (addon) => {
    setEditingId(addon.id);
    setNewAddOn({ name: addon.name, price: addon.price, category: addon.category });
    setIsAdding(true);
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Are you sure you want to delete this add-on?')) return;
    try {
      await api.delete(`/addons/${id}`);
      fetchAddOns();
    } catch (err) {
      alert('Failed to delete add-on');
    }
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-6 mt-8">
        <h3>Global Add-ons</h3>
        <button 
          className="btn btn-secondary" 
          onClick={() => {
            if (isAdding) {
              setIsAdding(false);
              setEditingId(null);
            } else {
              setNewAddOn({ name: '', price: '', category: 'extras' });
              setEditingId(null);
              setIsAdding(true);
            }
          }}
        >
          {isAdding ? 'Cancel' : '+ New Add-on'}
        </button>
      </div>

      <p className="text-sm text-secondary mb-4">
        Create add-ons (like Extra Cheese, Coke, Fries) here, then edit a Menu Item above to attach them!
      </p>

      {isAdding && (
        <div className="card mb-6 bg-gray-50 border-gray-200">
          <h4 className="mb-4">{editingId ? 'Edit Add-on' : 'New Add-on'}</h4>
          <form onSubmit={handleSave}>
            <div className="grid grid-3 gap-4 mb-4">
              <div className="form-group mb-0">
                <label className="form-label">Name</label>
                <input type="text" className="form-input" required value={newAddOn.name} onChange={e => setNewAddOn({...newAddOn, name: e.target.value})} />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Category</label>
                <select className="form-select" value={newAddOn.category} onChange={e => setNewAddOn({...newAddOn, category: e.target.value})}>
                  <option value="extras">Extras</option>
                  <option value="sides">Sides</option>
                  <option value="drinks">Drinks</option>
                  <option value="sauces">Sauces</option>
                </select>
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Price ($)</label>
                <input type="number" step="0.01" min="0" className="form-input" required value={newAddOn.price} onChange={e => setNewAddOn({...newAddOn, price: e.target.value})} />
              </div>
            </div>
            <button type="submit" className="btn btn-primary" disabled={isSaving}>
              {isSaving ? 'Saving...' : 'Save Add-on'}
            </button>
          </form>
        </div>
      )}

      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Category</th>
              <th>Price</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {addOns.map(addon => (
              <tr key={addon.id}>
                <td style={{ fontWeight: 500 }}>{addon.name}</td>
                <td style={{ textTransform: 'capitalize' }}>{addon.category}</td>
                <td>${parseFloat(addon.price).toFixed(2)}</td>
                <td className="text-right">
                  <div className="flex gap-2 justify-end">
                    <button className="btn btn-sm btn-secondary" onClick={() => handleEdit(addon)}>Edit</button>
                    <button className="btn btn-sm btn-danger" onClick={() => handleDelete(addon.id)}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
            {addOns.length === 0 && (
              <tr>
                <td colSpan="4" className="text-center text-secondary py-4">No add-ons found. Create one to attach to menu items.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
