import { useState, useEffect } from 'react';
import { useSearchParams, Link, useNavigate, useParams } from 'react-router-dom';
import api from '../services/api';
import { getSocket } from '../services/socket';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';

import { useMoney } from '../context/TenantContext';
export default function TrackOrder() {
  const { money } = useMoney();

  const { tenantSlug } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialCode = searchParams.get('code') || '';
  
  const [trackingCode, setTrackingCode] = useState(initialCode);
  const [phone, setPhone] = useState('');
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [requireLogin, setRequireLogin] = useState(false);
  
  // Complaint State
  const [showComplaintForm, setShowComplaintForm] = useState(false);
  const [complaintType, setComplaintType] = useState('missing_item');
  const [complaintDesc, setComplaintDesc] = useState('');
  const [submittingComplaint, setSubmittingComplaint] = useState(false);

  const fetchOrder = async (code) => {
    if (!code) return;
    setLoading(true);
    setError(null);
    setRequireLogin(false);
    try {
      const { data } = await api.get(`/orders/track/${code}`, {
        params: { phone }
      });
      setOrder(data.order);
      
      // Join tracking room via socket
      const socket = getSocket();
      if (socket) {
        socket.emit('trackOrder', code);
      }
    } catch (err) {
      if (err.response?.data?.requireLogin) {
        setRequireLogin(true);
        setError(err.response.data.error);
      } else {
        setError(err.response?.data?.error || 'Order not found. Please check your tracking code.');
      }
      setOrder(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initialCode) {
      fetchOrder(initialCode);
    }
    
    const socket = getSocket();
    if (!socket) return;

    const handlers = {
      orderApproved: () => {
        toast.success('Your order has been approved!');
        fetchOrder(trackingCode);
      },
      orderRejected: () => {
        toast.error('Unfortunately, your order was rejected.');
        fetchOrder(trackingCode);
      },
      deliveryAssigned: () => {
        toast.success('A driver has been assigned to your order!');
        fetchOrder(trackingCode);
      },
      orderDelivered: () => {
        toast.success('Your order has been delivered!');
        fetchOrder(trackingCode);
      },
    };

    Object.entries(handlers).forEach(([event, handler]) => {
      socket.on(event, handler);
    });

    return () => {
      Object.entries(handlers).forEach(([event, handler]) => {
        socket.off(event, handler);
      });
    };
  }, [initialCode]);

  const handleSubmit = (e) => {
    e.preventDefault();
    fetchOrder(trackingCode);
  };

  const getStatusBadge = (status) => {
    const map = {
      'pending': 'badge-pending',
      'approved': 'badge-approved',
      'preparing': 'badge-preparing',
      'ready': 'badge-ready',
      'assigned': 'badge-assigned',
      'delivered': 'badge-delivered',
      'rejected': 'badge-rejected'
    };
    return `badge ${map[status] || ''}`;
  };

  const submitComplaint = async (e) => {
    e.preventDefault();
    if (!complaintDesc.trim()) return toast.error('Please provide a description');
    
    setSubmittingComplaint(true);
    try {
      await api.post('/complaints', {
        tracking_code: order.tracking_code,
        issue_type: complaintType,
        description: complaintDesc
      });
      toast.success('Your issue has been reported. We will contact you soon.');
      setShowComplaintForm(false);
      setComplaintDesc('');
      fetchOrder(trackingCode);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to submit complaint');
    } finally {
      setSubmittingComplaint(false);
    }
  };

  const handleReopen = async (complaintId) => {
    try {
      await api.patch(`/complaints/${complaintId}/reopen`);
      toast.success('Complaint reopened successfully.');
      fetchOrder(trackingCode);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to reopen complaint');
    }
  };

  const canComplain = order && ['delivered', 'ready', 'assigned'].includes(order.status);

  return (
    <div className="page mx-auto max-w-xl px-4">
      <h1 className="mb-6 text-center text-2xl font-bold">Track your order</h1>

      <form onSubmit={handleSubmit} className="mb-8 rounded-xl border border-[#e2e8f0] bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="flex flex-col gap-4">
          <div>
            <label className="form-label">Tracking Code</label>
            <input 
              type="text" 
              className="form-input w-full" 
              placeholder="e.g. ORD-12345" 
              value={trackingCode}
              onChange={(e) => setTrackingCode(e.target.value)}
              required
            />
          </div>
          
          {!user && (
            <div>
              <label className="form-label">Phone Number <span className="text-muted text-xs font-normal">(Used for verification)</span></label>
              <input 
                type="tel" 
                className="form-input w-full" 
                placeholder="e.g. 078XXXXXXX" 
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
          )}

          <button type="submit" className="btn btn-primary w-full" disabled={loading}>
            {loading ? 'Searching...' : 'Track Order'}
          </button>
        </div>
      </form>

      {error && (
        <div className="form-error text-center p-4 bg-red-50 text-red-700 rounded mb-6 flex flex-col items-center gap-3">
          <p>{error}</p>
          {requireLogin && (
            <Link to={`/login?redirect=/${tenantSlug}/track?code=${trackingCode}`} className="btn btn-primary">
              Log In to Track Order
            </Link>
          )}
        </div>
      )}

      {order && (
        <div className="card">
          <div className="mb-6 flex items-center justify-between border-b border-[#e2e8f0] pb-4">
            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-[#94a3b8]">Order number</div>
              <div className="font-heading text-xl font-bold">{order.tracking_code}</div>
            </div>
            <div className={getStatusBadge(order.status)}>
              {order.status}
            </div>
          </div>

          <div className="grid grid-2 gap-4 mb-6">
            <div>
              <div className="text-xs text-secondary uppercase mb-1">Date</div>
              <div style={{ fontWeight: 500 }}>{new Date(order.created_at).toLocaleString()}</div>
            </div>
            <div>
              <div className="text-xs text-secondary uppercase mb-1">Payment Status</div>
              <div className={`badge ${order.payment_status === 'paid' ? 'badge-paid' : 'badge-unpaid'}`}>
                {order.payment_status}
              </div>
            </div>
          </div>

          {order.status === 'assigned' && order.delivery_person && order.delivery_type === 'internal' && (
            <div className="mb-6 p-4 rounded-lg bg-blue-50 border border-blue-100">
              <h4 className="mb-2 text-blue-800">Your Delivery is on the way!</h4>
              <p className="text-sm mb-1"><strong>Driver:</strong> {order.delivery_person.name}</p>
              <p className="text-sm mb-1"><strong>Phone:</strong> {order.delivery_person.phone}</p>
              <p className="text-sm text-blue-600"><strong>Plate:</strong> {order.delivery_person.plate_number}</p>
            </div>
          )}
          
          {order.status === 'assigned' && order.delivery_type === 'external' && order.external_rider_info && (
            <div className="mb-6 p-4 rounded-lg bg-blue-50 border border-blue-100">
              <h4 className="mb-2 text-blue-800">Your Delivery is on the way! (External Partner)</h4>
              <p className="text-sm mb-1"><strong>Driver:</strong> {order.external_rider_info.name}</p>
              <p className="text-sm mb-1"><strong>Phone:</strong> {order.external_rider_info.phone}</p>
              {order.external_rider_info.plateNumber && <p className="text-sm text-blue-600"><strong>Plate:</strong> {order.external_rider_info.plateNumber}</p>}
            </div>
          )}

          <h4 className="mb-3">Order Details</h4>
          <div className="mb-4">
            {order.order_items?.map((item, idx) => (
              <div key={idx} className="flex justify-between text-sm mb-2">
                <div>
                  {item.quantity}x {item.menu_item?.name}
                  {item.order_item_addons?.map(ao => (
                    <div key={ao.id} className="text-xs text-secondary pl-3">
                      + {ao.quantity}x {ao.add_on?.name}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          
          <div className="mb-6 flex items-center justify-between border-t border-[#e2e8f0] pt-4">
            <span className="font-semibold">Total</span>
            <span className="font-heading font-bold">{money(order.total_amount)}</span>
          </div>

          {canComplain && (
            <div className="pt-4 border-t">
              {!user ? (
                <div className="p-4 bg-orange-50 rounded-lg border border-orange-100 text-center">
                  <p className="text-orange-800 mb-3 text-sm">You must be a registered user to report an issue with this order.</p>
                  <Link 
                    to={`/register?phone=${order.guest_phone || ''}`} 
                    className="btn btn-primary"
                  >
                    Register to Report an Issue
                  </Link>
                </div>
              ) : !showComplaintForm ? (
                <button
                  className="btn btn-secondary w-full border-[#fecaca] text-[#dc2626] hover:border-[#dc2626]"
                  onClick={() => setShowComplaintForm(true)}
                >
                  Report an issue with this order
                </button>
              ) : (
                <form onSubmit={submitComplaint} className="p-4 bg-red-50 rounded-lg border border-red-100">
                  <h4 className="text-red-800 mb-3">Report an Issue</h4>
                  <div className="mb-3">
                    <label className="form-label text-red-900">Issue Type</label>
                    <select 
                      className="form-select" 
                      value={complaintType}
                      onChange={(e) => setComplaintType(e.target.value)}
                    >
                      <option value="missing_item">Missing item</option>
                      <option value="wrong_item">Wrong item received</option>
                      <option value="late_delivery">Delivery is too late</option>
                      <option value="quality_issue">Quality issue</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  <div className="mb-3">
                    <label className="form-label text-red-900">Description</label>
                    <textarea 
                      className="form-input" 
                      rows="3"
                      value={complaintDesc}
                      onChange={(e) => setComplaintDesc(e.target.value)}
                      placeholder="Please describe the issue..."
                      required
                    ></textarea>
                  </div>
                  <div className="flex gap-2 justify-end">
                    <button 
                      type="button" 
                      className="btn btn-secondary btn-sm"
                      onClick={() => setShowComplaintForm(false)}
                      disabled={submittingComplaint}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="btn btn-danger btn-sm"
                      disabled={submittingComplaint}
                    >
                      {submittingComplaint ? 'Submitting…' : 'Submit issue'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
          
          {/* List existing complaints */}
          {order.complaints && order.complaints.length > 0 && (
            <div className="mt-6 pt-6 border-t">
              <h4 className="mb-4">Your Reported Issues</h4>
              <div className="flex flex-col gap-3">
                {order.complaints.map(complaint => (
                  <div key={complaint.id} className="p-4 bg-gray-50 rounded-lg border">
                    <div className="flex justify-between items-start mb-2">
                      <span className="font-medium text-sm capitalize">{complaint.issue_type.replace('_', ' ')}</span>
                      <span className={`badge ${complaint.status === 'resolved' ? 'badge-delivered' : (complaint.status === 'rejected' ? 'badge-rejected' : 'badge-pending')}`}>
                        {complaint.status}
                      </span>
                    </div>
                    <p className="text-sm text-secondary mb-3">{complaint.description}</p>
                    
                    {complaint.status === 'rejected' && complaint.refunded_amount === 0 && (
                      <div className="bg-red-50 p-3 rounded mt-2 border border-red-100">
                        <p className="text-xs text-red-800 mb-2"><strong>Decision:</strong> {complaint.resolution_notes || 'Rejected by management.'}</p>
                        <button 
                          onClick={() => handleReopen(complaint.id)}
                          className="btn btn-sm btn-primary bg-red-600 hover:bg-red-700 border-red-600"
                        >
                          I disagree, Reopen Complaint
                        </button>
                      </div>
                    )}
                    
                    {complaint.status === 'resolved' && (
                      <div className="bg-green-50 p-3 rounded mt-2 border border-green-100">
                        <p className="text-xs text-green-800">
                          <strong>Resolved:</strong> {complaint.resolution_notes}
                        </p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
