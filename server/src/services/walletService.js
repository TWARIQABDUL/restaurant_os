const supabase = require('../config/supabase');
const momoClient = require('./momoClient');
const momoConfig = require('../config/momo');

async function recordMomoTransaction({ referenceId, type, purpose, tenantId, orderId, withdrawalRequestId, refundRequestId, phoneNumber, amount }) {
  const { data, error } = await supabase
    .from('momo_transactions')
    .insert({
      reference_id: referenceId,
      type,
      purpose,
      tenant_id: tenantId || null,
      order_id: orderId || null,
      withdrawal_request_id: withdrawalRequestId || null,
      refund_request_id: refundRequestId || null,
      phone_number: momoClient.normalizePhone(phoneNumber),
      amount,
      currency: momoConfig.currency,
      status: 'pending',
    })
    .select('*')
    .single();

  if (error) {
    console.error(`[DEBUG] Failed to record momo_transaction:`, error.message);
    throw new Error(`Failed to record momo_transaction: ${error.message}`);
  }
  console.log(`[DEBUG] Recorded MoMo transaction ${data.id} for order ${orderId} (Ref: ${referenceId})`);
  return data;
}

async function updateMomoTransactionResult(id, { status, momoStatusRaw, financialTransactionId, failureReason }) {
  await supabase
    .from('momo_transactions')
    .update({
      status,
      momo_status_raw: momoStatusRaw || null,
      financial_transaction_id: financialTransactionId || null,
      failure_reason: failureReason || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
}

/** Called for every order that reaches a terminal MoMo collection result. */
async function handleCollectionResult(txn, result) {
  if (result.status === 'SUCCESSFUL') {
    await updateMomoTransactionResult(txn.id, {
      status: 'successful',
      momoStatusRaw: result.status,
      financialTransactionId: result.financialTransactionId,
    });
    await supabase
      .from('orders')
      .update({ payment_status: 'paid', paid_at: new Date().toISOString() })
      .eq('id', txn.order_id);
    // credit_wallet_pending is idempotent — safe even if the reconciliation
    // sweep and the immediate poll both land here for the same order.
    await supabase.rpc('credit_wallet_pending', {
      p_tenant_id: txn.tenant_id,
      p_order_id: txn.order_id,
      p_amount: txn.amount,
    });
    console.log(`[DEBUG] Order ${txn.order_id} marked as PAID and wallet credited`);
  } else if (result.status === 'FAILED') {
    console.log(`[DEBUG] handleCollectionResult: FAILED for order ${txn.order_id}`, result);
    await updateMomoTransactionResult(txn.id, {
      status: 'failed',
      momoStatusRaw: result.status,
      failureReason: result.reason ? JSON.stringify(result.reason) : 'Payment failed or was declined',
    });
  }
  // PENDING: leave momo_transactions as-is; reconcilePendingCollections will keep checking.
}

/** Called for every disbursement (withdrawal OR refund) that reaches a terminal result. */
async function handleDisbursementResult({ txn, withdrawalId, refundRequestId, result }) {
  if (result.status === 'SUCCESSFUL') {
    await updateMomoTransactionResult(txn.id, {
      status: 'successful',
      momoStatusRaw: result.status,
      financialTransactionId: result.financialTransactionId,
    });
    if (withdrawalId) {
      await supabase.from('withdrawal_requests')
        .update({ status: 'completed', processed_at: new Date().toISOString() })
        .eq('id', withdrawalId);
    }
    if (refundRequestId) {
      await supabase.from('refund_requests').update({ status: 'completed' }).eq('id', refundRequestId);
    }
  } else if (result.status === 'FAILED') {
    const reason = result.reason ? JSON.stringify(result.reason) : 'Transfer failed';
    await updateMomoTransactionResult(txn.id, { status: 'failed', momoStatusRaw: result.status, failureReason: reason });

    if (withdrawalId) {
      // Give the money back — the withdrawal never actually reached the tenant.
      await supabase.rpc('reverse_failed_withdrawal', { p_withdrawal_id: withdrawalId });
      await supabase.from('withdrawal_requests')
        .update({ status: 'failed', failure_reason: reason, processed_at: new Date().toISOString() })
        .eq('id', withdrawalId);
    }
    // Deliberately NOT auto-reversed for refunds: staff already approved
    // the refund and the money has left the tenant's balance. A failed
    // payout to the customer (e.g. wrong number) needs a human to retry
    // with a corrected number, not a silent un-approval.
  }
}

/** Kick off a MoMo collection for a freshly-created mobile_money order. */
async function initiateOrderPayment(order) {
  const phone = order.guest_phone;
  const referenceId = momoClient.generateReferenceId();

  const txn = await recordMomoTransaction({
    referenceId,
    type: 'collection',
    purpose: 'order_payment',
    tenantId: order.tenant_id,
    orderId: order.id,
    phoneNumber: phone,
    amount: order.total_amount,
  });

  console.log(`[DEBUG] initiateOrderPayment: Attempting requestToPay for order ${order.id} with phone ${phone} and amount ${order.total_amount}`);

  try {
    await momoClient.requestToPay({
      amount: order.total_amount,
      phone,
      referenceId,
      payerMessage: `Order ${order.tracking_code}`,
      payeeNote: `Payment for order ${order.tracking_code}`,
      callbackUrl: momoConfig.callbackUrlBase ? `${momoConfig.callbackUrlBase}/api/momo/callback/collection/${referenceId}` : undefined,
    });
    console.log(`[DEBUG] initiateOrderPayment: requestToPay accepted by MTN for order ${order.id}`);
  } catch (err) {
    console.error(`[DEBUG] initiateOrderPayment: requestToPay threw error:`, err.message);
    await updateMomoTransactionResult(txn.id, { status: 'failed', failureReason: err.message });
    return { status: 'FAILED', reason: err.message, momoTransactionId: txn.id };
  }

  console.log(`[DEBUG] initiateOrderPayment: Polling for result...`);
  const result = await momoClient.pollUntilResolved(() => momoClient.getRequestToPayStatus(referenceId));
  console.log(`[DEBUG] initiateOrderPayment: Polling finished with status: ${result.status}`);
  
  await handleCollectionResult(txn, result);
  return { status: result.status, momoTransactionId: txn.id, referenceId };
}

/** Safety net: re-check any collection still PENDING after its initial poll window. */
async function reconcilePendingCollections() {
  const { data: pending } = await supabase
    .from('momo_transactions')
    .select('*')
    .eq('type', 'collection')
    .eq('status', 'pending')
    .lt('created_at', new Date(Date.now() - 15000).toISOString())
    .limit(50);

  for (const txn of pending || []) {
    try {
      const result = await momoClient.getRequestToPayStatus(txn.reference_id);
      if (result.status === 'SUCCESSFUL' || result.status === 'FAILED') {
        await handleCollectionResult(txn, result);
      } else {
        await supabase.from('momo_transactions')
          .update({ poll_attempts: (txn.poll_attempts || 0) + 1, updated_at: new Date().toISOString() })
          .eq('id', txn.id);
      }
    } catch (err) {
      console.error(`Reconcile collection ${txn.reference_id} failed:`, err.message);
    }
  }
}

/** Safety net: re-check any disbursement (withdrawal or refund) still PENDING. */
async function reconcilePendingDisbursements() {
  const { data: pending } = await supabase
    .from('momo_transactions')
    .select('*')
    .eq('type', 'disbursement')
    .eq('status', 'pending')
    .lt('created_at', new Date(Date.now() - 15000).toISOString())
    .limit(50);

  for (const txn of pending || []) {
    try {
      const result = await momoClient.getTransferStatus(txn.reference_id);
      if (result.status === 'SUCCESSFUL' || result.status === 'FAILED') {
        await handleDisbursementResult({
          txn,
          withdrawalId: txn.withdrawal_request_id,
          refundRequestId: txn.refund_request_id,
          result,
        });
      } else {
        await supabase.from('momo_transactions')
          .update({ poll_attempts: (txn.poll_attempts || 0) + 1, updated_at: new Date().toISOString() })
          .eq('id', txn.id);
      }
    } catch (err) {
      console.error(`Reconcile disbursement ${txn.reference_id} failed:`, err.message);
    }
  }
}

/** Move any order past its hold window (with no pending refund request) into available_balance. */
async function releaseEligibleOrders() {
  const { data, error } = await supabase.rpc('release_eligible_orders', {
    p_hold_minutes: momoConfig.holdMinutes,
  });
  if (error) {
    console.error('release_eligible_orders failed:', error.message);
    return [];
  }
  return data || [];
}

/** Admin-initiated (or system-initiated, for auto mode) withdrawal. Reserves funds atomically, then attempts the MoMo transfer. */
async function requestWithdrawal({ tenantId, userId, amount, phone, initiatedBy = 'manual' }) {
  const { data: withdrawalId, error } = await supabase.rpc('request_withdrawal', {
    p_tenant_id: tenantId,
    p_user_id: userId,
    p_amount: amount,
    p_phone: phone,
    p_initiated_by: initiatedBy,
  });

  if (error) {
    throw new Error(error.message); // e.g. "Insufficient available balance"
  }

  const referenceId = momoClient.generateReferenceId();
  const txn = await recordMomoTransaction({
    referenceId,
    type: 'disbursement',
    purpose: 'withdrawal',
    tenantId,
    withdrawalRequestId: withdrawalId,
    phoneNumber: phone,
    amount,
  });

  await supabase.from('withdrawal_requests').update({ momo_transaction_id: txn.id }).eq('id', withdrawalId);

  try {
    await momoClient.transfer({
      amount,
      phone,
      referenceId,
      payerMessage: 'Restaurant OS payout',
      payeeNote: 'Wallet withdrawal',
      callbackUrl: momoConfig.callbackUrlBase ? `${momoConfig.callbackUrlBase}/api/momo/callback/disbursement/${referenceId}` : undefined,
    });
  } catch (err) {
    await updateMomoTransactionResult(txn.id, { status: 'failed', failureReason: err.message });
    await supabase.rpc('reverse_failed_withdrawal', { p_withdrawal_id: withdrawalId });
    await supabase.from('withdrawal_requests')
      .update({ status: 'failed', failure_reason: err.message, processed_at: new Date().toISOString() })
      .eq('id', withdrawalId);
    throw err;
  }

  const result = await momoClient.pollUntilResolved(() => momoClient.getTransferStatus(referenceId));
  await handleDisbursementResult({ txn, withdrawalId, result });
  return { withdrawalId, status: result.status };
}

/** For tenants with settings.payments.settlementMode === 'auto', pay out newly-released balance immediately. */
async function maybeAutoPayout(tenantId) {
  const { data: tenant } = await supabase.from('tenants').select('id, settings').eq('id', tenantId).single();
  if (!tenant) return;

  const paymentSettings = tenant.settings?.payments || {};
  if (paymentSettings.settlementMode !== 'auto') return;

  const payoutPhone = paymentSettings.payoutPhone;
  if (!payoutPhone) {
    console.warn(`Tenant ${tenantId}: auto settlement is on but no payoutPhone is set — skipping auto payout.`);
    return;
  }

  const { data: wallet } = await supabase.from('wallets').select('available_balance').eq('tenant_id', tenantId).single();
  if (!wallet || Number(wallet.available_balance) <= 0) return;

  const { data: admin } = await supabase
    .from('users')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('role', 'admin')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!admin) {
    console.warn(`Tenant ${tenantId}: auto settlement is on but no admin user exists to attribute the payout to — skipping.`);
    return;
  }

  try {
    await requestWithdrawal({
      tenantId,
      userId: admin.id,
      amount: wallet.available_balance,
      phone: payoutPhone,
      initiatedBy: 'auto',
    });
  } catch (err) {
    console.error(`Auto payout failed for tenant ${tenantId}:`, err.message);
  }
}

/** Send a refund payout to the customer after staff approval has already deducted the tenant's wallet. */
async function processRefundDisbursement({ refundRequestId, tenantId, orderId, phone, amount }) {
  const referenceId = momoClient.generateReferenceId();
  const txn = await recordMomoTransaction({
    referenceId,
    type: 'disbursement',
    purpose: 'refund',
    tenantId,
    orderId,
    refundRequestId,
    phoneNumber: phone,
    amount,
  });

  await supabase.from('refund_requests').update({ momo_transaction_id: txn.id }).eq('id', refundRequestId);

  try {
    await momoClient.transfer({
      amount,
      phone,
      referenceId,
      payerMessage: 'Order refund',
      payeeNote: 'Refund',
      callbackUrl: momoConfig.callbackUrlBase ? `${momoConfig.callbackUrlBase}/api/momo/callback/disbursement/${referenceId}` : undefined,
    });
  } catch (err) {
    await updateMomoTransactionResult(txn.id, { status: 'failed', failureReason: err.message });
    throw err;
  }

  const result = await momoClient.pollUntilResolved(() => momoClient.getTransferStatus(referenceId));
  await handleDisbursementResult({ txn, refundRequestId, result });
  return { status: result.status };
}

/** Approve a pending refund request: deduct the tenant wallet (atomic), then pay the customer. */
async function approveRefund({ refundRequestId, reviewerUserId }) {
  const { data: refundRequest, error: fetchErr } = await supabase
    .from('refund_requests')
    .select('*, order:orders(id, tenant_id, guest_phone, customer_id, total_amount)')
    .eq('id', refundRequestId)
    .single();

  if (fetchErr || !refundRequest) throw new Error('Refund request not found');
  if (refundRequest.status !== 'pending') throw new Error(`Refund request is already ${refundRequest.status}`);

  // Atomic, raises on insufficient tenant balance (e.g. already withdrawn).
  const { data: amount, error: deductErr } = await supabase.rpc('approve_refund_deduct_wallet', {
    p_refund_request_id: refundRequestId,
  });
  if (deductErr) throw new Error(deductErr.message);

  await supabase
    .from('refund_requests')
    .update({ status: 'approved', reviewed_by: reviewerUserId, reviewed_at: new Date().toISOString() })
    .eq('id', refundRequestId);

  let phone = refundRequest.order.guest_phone;
  if (!phone && refundRequest.order.customer_id) {
    const { data: customer } = await supabase.from('users').select('phone').eq('id', refundRequest.order.customer_id).single();
    phone = customer?.phone;
  }

  if (!phone) {
    // Wallet is already safely deducted; status stays 'approved' (not
    // 'completed') so this surfaces for manual follow-up.
    throw new Error('Refund deducted from tenant balance, but no phone number is on file — send it manually and mark complete.');
  }

  await processRefundDisbursement({
    refundRequestId,
    tenantId: refundRequest.order.tenant_id,
    orderId: refundRequest.order.id,
    phone,
    amount,
  });

  return { amount };
}

async function rejectRefund({ refundRequestId, reviewerUserId }) {
  const { data, error } = await supabase
    .from('refund_requests')
    .update({ status: 'rejected', reviewed_by: reviewerUserId, reviewed_at: new Date().toISOString() })
    .eq('id', refundRequestId)
    .eq('status', 'pending')
    .select('*')
    .single();

  if (error || !data) throw new Error('Refund request not found or already reviewed');
  return data;
}

/** Called by the webhook route — re-checks ONE transaction by reference id via the authoritative status GET, never trusting the callback body itself. */
async function recheckCollection(referenceId) {
  const { data: txn } = await supabase.from('momo_transactions').select('*').eq('reference_id', referenceId).eq('type', 'collection').single();
  if (!txn || txn.status !== 'pending') return; // unknown or already resolved
  const result = await momoClient.getRequestToPayStatus(referenceId);
  if (result.status === 'SUCCESSFUL' || result.status === 'FAILED') {
    await handleCollectionResult(txn, result);
  }
}

async function recheckDisbursement(referenceId) {
  const { data: txn } = await supabase.from('momo_transactions').select('*').eq('reference_id', referenceId).eq('type', 'disbursement').single();
  if (!txn || txn.status !== 'pending') return;
  const result = await momoClient.getTransferStatus(referenceId);
  if (result.status === 'SUCCESSFUL' || result.status === 'FAILED') {
    await handleDisbursementResult({ txn, withdrawalId: txn.withdrawal_request_id, refundRequestId: txn.refund_request_id, result });
  }
}

async function getWallet(tenantId) {
  const { data } = await supabase.from('wallets').select('*').eq('tenant_id', tenantId).single();
  return data || { tenant_id: tenantId, available_balance: 0, pending_balance: 0, currency: momoConfig.currency };
}

async function getLedger(tenantId, limit = 50) {
  const { data } = await supabase
    .from('wallet_ledger')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return data || [];
}

async function getWithdrawals(tenantId, limit = 50) {
  const { data } = await supabase
    .from('withdrawal_requests')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('requested_at', { ascending: false })
    .limit(limit);
  return data || [];
}

module.exports = {
  initiateOrderPayment,
  reconcilePendingCollections,
  reconcilePendingDisbursements,
  releaseEligibleOrders,
  requestWithdrawal,
  maybeAutoPayout,
  approveRefund,
  rejectRefund,
  recheckCollection,
  recheckDisbursement,
  getWallet,
  getLedger,
  getWithdrawals,
};