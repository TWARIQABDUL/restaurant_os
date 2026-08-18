import { useState, useEffect } from 'react';
import api from '../services/api';
import { uploadImage } from '../services/supabase';
import AddonsManagement from './AddonsManagement';

export default function MenuManagement() {
  const [menuItems, setMenuItems] = useState([]);
  const [isAddingMenu, setIsAddingMenu] = useState(false);
  const [editingItemId, setEditingItemId] = useState(null);
  const [newMenu, setNewMenu] = useState({ name: '', description: '', price: '', category: '', image_url: '' });
  const [imageFile, setImageFile] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  
  // Addons state
  const [allAddOns, setAllAddOns] = useState([]);
  const [selectedAddOnIds, setSelectedAddOnIds] = useState([]);

  const fetchMenuAndAddons = async () => {
    try {
      const [{ data: menuData }, { data: addonsData }] = await Promise.all([
        api.get('/menu'),
        api.get('/addons')
      ]);
      setMenuItems(menuData.items || []);
      setAllAddOns(addonsData.addOns || []);
    } catch (err) {
      console.error('Failed to fetch data', err);
    }
  };

  useEffect(() => {
    fetchMenuAndAddons();
  }, []);

  const handleSaveMenu = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      let finalImageUrl = newMenu.image_url;
      
      // Upload image to Supabase if a file was selected
      if (imageFile) {
        finalImageUrl = await uploadImage(imageFile, 'blog-images');
      }

      const payload = { ...newMenu, image_url: finalImageUrl };

      let savedMenuItemId = editingItemId;

      if (editingItemId) {
        await api.put(`/menu/${editingItemId}`, payload);
      } else {
        const { data } = await api.post('/menu', payload);
        savedMenuItemId = data.item.id;
      }

      // Save add-ons links if any
      if (selectedAddOnIds.length > 0) {
        await api.post(`/addons/menu/${savedMenuItemId}/link`, { add_on_ids: selectedAddOnIds });
      }

      setNewMenu({ name: '', description: '', price: '', category: '', image_url: '' });
      setImageFile(null);
      setIsAddingMenu(false);
      setEditingItemId(null);
      setSelectedAddOnIds([]);
      fetchMenuAndAddons();
    } catch (err) {
      alert(err.message || err.response?.data?.error || 'Failed to save menu item');
    } finally {
      setIsSaving(false);
    }
  };

  const handleEditMenu = (item) => {
    setEditingItemId(item.id);
    setNewMenu({ 
      name: item.name, 
      description: item.description || '', 
      price: item.price, 
      category: item.category, 
      image_url: item.image_url || '' 
    });
    setImageFile(null);
    setSelectedAddOnIds(item.add_ons?.map(a => a.add_on_id) || []);
    setIsAddingMenu(true);
  };

  const handleDeleteMenu = async (id) => {
    if (!window.confirm('Are you sure you want to delete this item?')) return;
    try {
      await api.delete(`/menu/${id}`);
      fetchMenuAndAddons();
    } catch (err) {
      alert('Failed to delete menu item');
    }
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h3>Menu Items</h3>
        <button 
          className="btn btn-primary" 
          onClick={() => {
            if (isAddingMenu) {
              setIsAddingMenu(false);
              setEditingItemId(null);
            } else {
              setNewMenu({ name: '', description: '', price: '', category: '', image_url: '' });
              setImageFile(null);
              setEditingItemId(null);
              setSelectedAddOnIds([]);
              setIsAddingMenu(true);
            }
          }}
        >
          {isAddingMenu ? 'Cancel' : '+ Add Item'}
        </button>
      </div>

      {isAddingMenu && (
        <div className="card mb-6 bg-gray-50 border-gray-200">
          <h4 className="mb-4">{editingItemId ? 'Edit Menu Item' : 'New Menu Item'}</h4>
          <form onSubmit={handleSaveMenu}>
            <div className="grid grid-2 gap-4 mb-4">
              <div className="form-group mb-0">
                <label className="form-label">Item Name</label>
                <input type="text" className="form-input" required value={newMenu.name} onChange={e => setNewMenu({...newMenu, name: e.target.value})} />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Category</label>
                <input type="text" className="form-input" required placeholder="e.g. Mains" value={newMenu.category} onChange={e => setNewMenu({...newMenu, category: e.target.value})} />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Price ($)</label>
                <input type="number" step="0.01" min="0" className="form-input" required value={newMenu.price} onChange={e => setNewMenu({...newMenu, price: e.target.value})} />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Image Upload</label>
                <input 
                  type="file" 
                  accept="image/*"
                  className="form-input" 
                  onChange={e => {
                    if (e.target.files && e.target.files[0]) {
                      setImageFile(e.target.files[0]);
                    }
                  }} 
                  style={{ padding: '6px' }}
                />
                {(newMenu.image_url || imageFile) && (
                  <p className="text-xs text-secondary mt-1">
                    {imageFile ? `Selected: ${imageFile.name}` : 'Current image will be kept if no new file is chosen'}
                  </p>
                )}
              </div>
            </div>
            <div className="form-group mb-4">
              <label className="form-label">Description (Optional)</label>
              <textarea className="form-textarea" rows="2" value={newMenu.description} onChange={e => setNewMenu({...newMenu, description: e.target.value})}></textarea>
            </div>
            
            <div className="form-group mb-6">
              <label className="form-label">Linked Add-ons (Optional)</label>
              <div className="flex flex-wrap gap-2">
                {allAddOns.map(addon => {
                  const isSelected = selectedAddOnIds.includes(addon.id);
                  return (
                    <div 
                      key={addon.id}
                      onClick={() => {
                        if (isSelected) {
                          setSelectedAddOnIds(selectedAddOnIds.filter(id => id !== addon.id));
                        } else {
                          setSelectedAddOnIds([...selectedAddOnIds, addon.id]);
                        }
                      }}
                      style={{
                        padding: '4px 12px',
                        border: `1px solid ${isSelected ? 'var(--color-primary)' : 'var(--color-border)'}`,
                        borderRadius: '999px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        backgroundColor: isSelected ? 'var(--color-primary)' : 'white',
                        color: isSelected ? 'white' : 'var(--color-text)',
                        fontWeight: isSelected ? 600 : 400
                      }}
                    >
                      {addon.name} (+${addon.price})
                    </div>
                  );
                })}
                {allAddOns.length === 0 && <span className="text-sm text-secondary">No add-ons created yet.</span>}
              </div>
            </div>

            <button type="submit" className="btn btn-primary" disabled={isSaving}>
              {isSaving ? 'Saving...' : 'Save Item'}
            </button>
          </form>
        </div>
      )}

      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Image</th>
              <th>Name</th>
              <th>Category</th>
              <th>Price</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {menuItems.map(item => (
              <tr key={item.id}>
                <td>
                  {item.image_url ? (
                    <img src={item.image_url} alt={item.name} style={{ width: '40px', height: '40px', objectFit: 'cover', borderRadius: '4px' }} />
                  ) : (
                    <div style={{ width: '40px', height: '40px', background: '#eee', borderRadius: '4px' }}></div>
                  )}
                </td>
                <td style={{ fontWeight: 500 }}>{item.name}</td>
                <td>{item.category}</td>
                <td>${parseFloat(item.price).toFixed(2)}</td>
                <td className="text-right">
                  <div className="flex gap-2 justify-end">
                    <button className="btn btn-sm btn-secondary" onClick={() => handleEditMenu(item)}>Edit</button>
                    <button className="btn btn-sm btn-danger" onClick={() => handleDeleteMenu(item.id)}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
            {menuItems.length === 0 && (
              <tr>
                <td colSpan="5" className="text-center text-secondary py-4">No menu items found.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <hr style={{ margin: 'var(--space-8) 0', border: 'none', borderTop: '1px solid var(--color-border)' }} />
      
      <AddonsManagement />
    </div>
  );
}
