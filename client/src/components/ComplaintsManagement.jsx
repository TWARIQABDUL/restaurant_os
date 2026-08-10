import React, { useState, useEffect } from 'react';
import api from '../services/api';
import toast from 'react-hot-toast';

export default function ComplaintsManagement() {
  const [complaints, setComplaints] = useState([]);
  const [loading, setLoading] = useState(true);
  
  const [resolvingId, setResolvingId] = useState(null);
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    fetchComplaints();
  }, []);

  const fetchComplaints = async () => {
    setLoading(true);
    try {
      const res = await api.get('/complaints');
      setComplaints(res.data.complaints || []);
    } catch (err) {
      console.error('Failed to load complaints:', err);
      toast.error('Failed to load complaints');
    } finally {
      setLoading(false);
    }
  };

  const handleResolve = async (id) => {
    try {
      await api.patch(`/complaints/${id}/resolve`, {
        resolution_notes: resolutionNotes
      });
      toast.success('Complaint marked as resolved');
      setResolvingId(null);
      setResolutionNotes('');
      fetchComplaints();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to resolve complaint');
    }
  };

  if (loading && complaints.length === 0) {
    return <div className="text-center p-8">Loading complaints...</div>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-between items-center">
        <h2>Order Complaints</h2>
        <button className="btn btn-secondary" onClick={fetchComplaints}>Refresh</button>
      </div>

      <div className="card">
        {complaints.length === 0 ? (
          <div className="text-center p-8 text-secondary">No complaints found. Great job!</div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Order Code</th>
                  <th>Issue Type</th>
                  <th>Description</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {complaints.map((complaint) => (
                  <React.Fragment key={complaint.id}>
                    <tr style={{ background: expandedId === complaint.id ? 'var(--color-bg-alt)' : 'transparent', cursor: 'pointer' }} onClick={(e) => {
                      if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'TEXTAREA') {
                        setExpandedId(expandedId === complaint.id ? null : complaint.id);
                      }
                    }}>
                      <td className="text-sm">{new Date(complaint.created_at).toLocaleString()}</td>
                      <td className="font-medium">
                        {complaint.orders?.tracking_code}
                        <div className="text-xs text-secondary mt-1">Click to view details</div>
                      </td>
                      <td style={{ textTransform: 'capitalize' }}>
                        {complaint.issue_type.replace(/_/g, ' ')}
                      </td>
                      <td className="text-sm" style={{ maxWidth: '300px' }}>
                        {complaint.description}
                        {complaint.resolution_notes && (
                          <div className="mt-2 text-xs text-secondary p-2 bg-gray-50 rounded border">
                            <strong>Notes:</strong> {complaint.resolution_notes}
                          </div>
                        )}
                      </td>
                      <td>
                        <span className={`badge ${complaint.status === 'resolved' ? 'badge-delivered' : 'badge-rejected'}`}>
                          {complaint.status}
                        </span>
                      </td>
                      <td>
                        {complaint.status === 'open' && resolvingId !== complaint.id && (
                          <button 
                            className="btn btn-primary btn-sm"
                            onClick={(e) => { e.stopPropagation(); setResolvingId(complaint.id); }}
                          >
                            Resolve
                          </button>
                        )}
                        
                        {resolvingId === complaint.id && (
                          <div className="flex flex-col gap-2 mt-2" style={{ minWidth: '200px' }}>
                            <textarea
                              className="form-input form-input-sm"
                              rows="2"
                              placeholder="Resolution notes..."
                              value={resolutionNotes}
                              onChange={(e) => setResolutionNotes(e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                            ></textarea>
                            <div className="flex gap-2">
                              <button 
                                className="btn btn-secondary btn-sm flex-1"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setResolvingId(null);
                                  setResolutionNotes('');
                                }}
                              >
                                Cancel
                              </button>
                              <button 
                                className="btn btn-primary btn-sm flex-1"
                                onClick={(e) => { e.stopPropagation(); handleResolve(complaint.id); }}
                              >
                                Save
                              </button>
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                    
                    {expandedId === complaint.id && (
                      <tr style={{ background: 'var(--color-bg-alt)' }}>
                        <td colSpan="6" style={{ padding: '0' }}>
                          <div className="p-4 border-t border-b" style={{ borderColor: 'var(--color-border)' }}>
                            <h4 className="mb-4">Complaint & Order Details</h4>
                            <div className="grid grid-2 gap-8">
                              <div>
                                <h5 className="mb-2 text-secondary">Order Summary</h5>
                                <div className="bg-white p-4 rounded border text-sm">
                                  <div className="flex justify-between mb-2">
                                    <span className="text-secondary">Tracking Code:</span>
                                    <span className="font-medium">{complaint.orders?.tracking_code}</span>
                                  </div>
                                  <div className="flex justify-between mb-2">
                                    <span className="text-secondary">Customer Name:</span>
                                    <span>{complaint.orders?.guest_name || 'Anonymous Guest'}</span>
                                  </div>
                                  <div className="flex justify-between mb-2">
                                    <span className="text-secondary">Customer Phone:</span>
                                    <span>{complaint.orders?.guest_phone || complaint.orders?.customer?.phone || 'N/A'}</span>
                                  </div>
                                  <div className="flex justify-between mb-2">
                                    <span className="text-secondary">Order Status:</span>
                                    <span style={{ textTransform: 'capitalize' }}>{complaint.orders?.status}</span>
                                  </div>
                                  <div className="flex justify-between mb-2">
                                    <span className="text-secondary">Placed On:</span>
                                    <span>{new Date(complaint.orders?.created_at).toLocaleString()}</span>
                                  </div>
                                </div>

                                {(complaint.orders?.status === 'assigned' || complaint.orders?.status === 'delivered') && (() => {
                                  let externalRider = complaint.orders?.external_rider_info;
                                  if (typeof externalRider === 'string') {
                                    try { externalRider = JSON.parse(externalRider); } catch(e) {}
                                  }
                                  
                                  return (
                                    <>
                                      <h5 className="mb-2 mt-4 text-secondary">Delivery Information</h5>
                                      <div className="bg-white p-4 rounded border text-sm">
                                        <div className="flex justify-between mb-2">
                                          <span className="text-secondary">Type:</span>
                                          <span style={{ textTransform: 'capitalize' }}>{complaint.orders?.delivery_type || 'Internal'}</span>
                                        </div>
                                        <div className="flex justify-between mb-2">
                                          <span className="text-secondary">Driver Name:</span>
                                          <span>
                                            {complaint.orders?.delivery_type === 'external' 
                                              ? externalRider?.name || 'N/A'
                                              : complaint.orders?.delivery_person?.name || 'N/A'}
                                          </span>
                                        </div>
                                        <div className="flex justify-between mb-2">
                                          <span className="text-secondary">Driver Phone:</span>
                                          <span>
                                            {complaint.orders?.delivery_type === 'external' 
                                              ? externalRider?.phone || 'N/A'
                                              : complaint.orders?.delivery_person?.phone || 'N/A'}
                                          </span>
                                        </div>
                                        {complaint.orders?.delivery_type === 'external' && externalRider?.plateNumber && (
                                          <div className="flex justify-between mb-2">
                                            <span className="text-secondary">Plate Number:</span>
                                            <span>{externalRider.plateNumber}</span>
                                          </div>
                                        )}
                                      </div>
                                    </>
                                  );
                                })()}

                                <h5 className="mb-2 mt-4 text-secondary">Payment Information</h5>
                                <div className="bg-white p-4 rounded border text-sm">
                                  <div className="flex justify-between mb-2">
                                    <span className="text-secondary">Method:</span>
                                    <span style={{ textTransform: 'capitalize' }}>{complaint.orders?.payment_method ? complaint.orders.payment_method.replace(/_/g, ' ') : 'N/A'}</span>
                                  </div>
                                  <div className="flex justify-between mb-2">
                                    <span className="text-secondary">Status:</span>
                                    <span className={`badge ${complaint.orders?.payment_status === 'paid' ? 'badge-delivered' : 'badge-rejected'}`}>
                                      {complaint.orders?.payment_status}
                                    </span>
                                  </div>
                                  <div className="flex justify-between pt-2 mt-2 border-t font-bold">
                                    <span>Total Amount:</span>
                                    <span>${parseFloat(complaint.orders?.total_amount || 0).toFixed(2)}</span>
                                  </div>
                                </div>
                              </div>

                              <div>
                                <h5 className="mb-2 text-secondary">Ordered Items</h5>
                                <div className="bg-white p-4 rounded border text-sm">
                                  {complaint.orders?.order_items?.map((item, idx) => (
                                    <div key={idx} className="mb-3 pb-3 border-b last:border-0 last:mb-0 last:pb-0">
                                      <div className="flex justify-between font-medium">
                                        <span>{item.quantity}x {item.menu_item?.name}</span>
                                        <span>${(item.quantity * parseFloat(item.unit_price)).toFixed(2)}</span>
                                      </div>
                                      {item.order_item_addons?.length > 0 && (
                                        <div className="text-secondary text-xs mt-1 pl-2 border-l-2 border-gray-200">
                                          {item.order_item_addons.map(a => `${a.quantity}x ${a.add_on?.name}`).join(', ')}
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                                
                                <h5 className="mb-2 mt-4 text-secondary">Complaint Timeline</h5>
                                <div className="bg-white p-4 rounded border text-sm">
                                  <div className="flex items-start gap-3 mb-4">
                                    <div className="w-2 h-2 rounded-full bg-red-500 mt-1.5 flex-shrink-0"></div>
                                    <div>
                                      <div className="text-secondary text-xs mb-1">{new Date(complaint.created_at).toLocaleString()}</div>
                                      <div className="font-medium text-red-700 mb-1">Issue Reported: {complaint.issue_type.replace(/_/g, ' ')}</div>
                                      <div className="italic">"{complaint.description}"</div>
                                    </div>
                                  </div>
                                  
                                  {complaint.status === 'resolved' && (
                                    <div className="flex items-start gap-3">
                                      <div className="w-2 h-2 rounded-full bg-green-500 mt-1.5 flex-shrink-0"></div>
                                      <div>
                                        <div className="text-secondary text-xs mb-1">{new Date(complaint.updated_at).toLocaleString()}</div>
                                        <div className="font-medium text-green-700 mb-1">Resolved</div>
                                        {complaint.resolution_notes && (
                                          <div className="text-gray-700 bg-gray-50 p-2 rounded border mt-1">
                                            {complaint.resolution_notes}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
