import { useState, useEffect } from 'react';
import api from '../services/api';
import toast from 'react-hot-toast';

export default function ComplaintsManagement() {
  const [complaints, setComplaints] = useState([]);
  const [loading, setLoading] = useState(true);
  
  const [resolvingId, setResolvingId] = useState(null);
  const [resolutionNotes, setResolutionNotes] = useState('');

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
                  <tr key={complaint.id}>
                    <td className="text-sm">{new Date(complaint.created_at).toLocaleString()}</td>
                    <td className="font-medium">{complaint.orders?.tracking_code}</td>
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
                          onClick={() => setResolvingId(complaint.id)}
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
                          ></textarea>
                          <div className="flex gap-2">
                            <button 
                              className="btn btn-secondary btn-sm flex-1"
                              onClick={() => {
                                setResolvingId(null);
                                setResolutionNotes('');
                              }}
                            >
                              Cancel
                            </button>
                            <button 
                              className="btn btn-primary btn-sm flex-1"
                              onClick={() => handleResolve(complaint.id)}
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
