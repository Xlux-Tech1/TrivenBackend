import catchAsync from '../../utils/catchAsync.js';
import ApiResponse from '../../utils/ApiResponse.js';
import smx from './shipmaxx.service.js';
import { NdrNote } from '../shiprocket/models/ndrNote.model.js';
import { Order } from '../shiprocket/models/order.model.js';
import { Followup } from '../shiprocket/models/followup.model.js';
import { DeliveredOrder } from '../shiprocket/models/deliveredOrder.model.js';
import { InTransitOrder } from '../shiprocket/models/inTransitOrder.model.js';
import { Lead } from '../lead/lead.model.js';
import Task from '../task/task.model.js';
import Verification from '../verification/verification.model.js';
import ReadyToShipment from '../readytoshipment/readytoshipment.model.js';
import { getNextOrderId } from '../shiprocket/counter/counter.model.js';

const DEFAULT_FOLLOWUP_TOTAL = 5;
const DEFAULT_FOLLOWUP_GAP_DAYS = 6;

const setAutoFollowUps = async (orderId, deliveredAt) => {
  const total = DEFAULT_FOLLOWUP_TOTAL;
  const gap   = DEFAULT_FOLLOWUP_GAP_DAYS;
  const base  = new Date(deliveredAt);
  const ops = Array.from({ length: total }, (_, i) => {
    const scheduled_date = new Date(base);
    scheduled_date.setDate(scheduled_date.getDate() + (i + 1) * gap);
    return {
      updateOne: {
        filter: { order_id: orderId, followup_number: i + 1 },
        update: { $setOnInsert: { order_id: orderId, followup_number: i + 1, scheduled_date, status: 'scheduled', completed: false } },
        upsert: true,
      },
    };
  });
  await Followup.bulkWrite(ops);
  await Order.findByIdAndUpdate(orderId, { auto_followups_set: true });
};

// ── Auth ──────────────────────────────────────────────────────────────────────
export const login = catchAsync(async (req, res) => {
  const { email, password, api_key, base_url } = req.body;
  if (base_url) smx.setAuthUrl(base_url);
  if (api_key) smx.setApiKey(api_key);
  if (email && password) smx.setCredentials(email, password);
  
  const token = await smx.login();
  res.json(new ApiResponse(200, { token }, 'ShipMaxx login successful'));
});

export const setPassword = catchAsync(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json(new ApiResponse(400, null, 'email and password are required'));
  smx.setCredentials(email, password);
  res.json(new ApiResponse(200, null, 'ShipMaxx credentials updated successfully'));
});

// ── Orders ────────────────────────────────────────────────────────────────────
export const getOrder = catchAsync(async (req, res) => {
  const data = await smx.getOrder(req.params.order_id);
  res.json(new ApiResponse(200, data, 'Order fetched'));
});

export const createOrder = catchAsync(async (req, res) => {
  const { pickup_address_id, channel_id, payment_method, order_number, customer, products, package: pkg, billing_address, other_charges, total_discount } = req.body;

  const required = ['pickup_address_id', 'channel_id', 'payment_method', 'order_number', 'customer', 'products', 'package'];
  const missing = required.filter((k) => !req.body[k]);
  if (missing.length) return res.json(new ApiResponse(400, null, `Missing: ${missing.join(', ')}`));

  const customerRequired = ['phone', 'name', 'address', 'pincode', 'city', 'state'];
  const missingCustomer = customerRequired.filter((k) => !customer[k]);
  if (missingCustomer.length) return res.json(new ApiResponse(400, null, `Missing customer fields: ${missingCustomer.join(', ')}`));

  const fresh_order_id = await getNextOrderId();

  const payload = {
    pickup_address_id: Number(pickup_address_id),
    channel_id: Number(channel_id),
    payment_method,
    order_number: fresh_order_id,
    customer,
    products: (products || []).map(p => ({
      sku: String(p.sku || ''),
      name: String(p.name || ''),
      price: Number(p.price) || 0,
      quantity: Number(p.quantity) || 1,
    })),
    package: {
      weight: Number(pkg.weight) || 0.5,
      length: Number(pkg.length) || 10,
      width: Number(pkg.width) || 10,
      height: Number(pkg.height) || 10,
    },
    ...(billing_address && { billing_address }),
    ...(other_charges !== undefined && { other_charges: Number(other_charges) || 0 }),
    ...(total_discount !== undefined && { total_discount: Number(total_discount) || 0 }),
  };

  const data = await smx.createOrder(payload);
  const smxRes = data?.data || data || {};
  const oid = smxRes.order_id || smxRes.id || order_number;

  // Log in CRM Order database
  try {
    const subTotal = (products || []).reduce((sum, p) => sum + (Number(p.price) * (Number(p.quantity) || 1)), 0) + (Number(other_charges) || 0) - (Number(total_discount) || 0);
    await Order.create({
      order_id: String(oid),
      status: 'NEW',
      billing_customer_name: customer.name,
      billing_phone: customer.phone,
      billing_address: customer.address,
      billing_city: customer.city,
      billing_state: customer.state,
      billing_pincode: customer.pincode,
      billing_email: customer.email || '',
      payment_method: payment_method,
      sub_total: subTotal,
      order_items: (products || []).map(p => ({ name: p.name, sku: p.sku, units: p.quantity, selling_price: p.price })),
      platform: 'shipmaxx',
      created_by: req.user?._id,
      raw_response: smxRes,
    });
  } catch (err) {
    console.error('[ShipMaxx Create Order Log Error]', err.message);
  }

  res.json(new ApiResponse(200, { ...data, extracted_order_id: oid }, 'Order created'));
});

export const updateOrder = catchAsync(async (req, res) => {
  const { order_id } = req.params;
  if (!order_id) return res.json(new ApiResponse(400, null, 'order_id is required'));
  const data = await smx.updateOrder(order_id, req.body);

  if (req.body.status) {
    try {
      await Order.findOneAndUpdate(
        { order_id: String(order_id), platform: 'shipmaxx' },
        { $set: { status: String(req.body.status).toUpperCase(), status_updated_at: new Date() } }
      );
    } catch (err) {
      console.error('[ShipMaxx Update Order Status Log Error]', err.message);
    }
  }

  res.json(new ApiResponse(200, data, 'Order updated'));
});

// ── Shipping ──────────────────────────────────────────────────────────────────
export const createShipment = catchAsync(async (req, res) => {
  const { order_id, warehouse_id, carrier_variant_id } = req.body;
  if (!order_id) return res.json(new ApiResponse(400, null, 'order_id is required'));
  const payload = {
    order_id: String(order_id),
    ...(warehouse_id && { warehouse_id: Number(warehouse_id) }),
    ...(carrier_variant_id && { carrier_variant_id: Number(carrier_variant_id) }),
  };
  const data = await smx.createShipment(payload);
  const smxRes = data?.data || data || {};
  const awb = smxRes.awb || smxRes.awb_number;

  if (awb) {
    try {
      await Order.findOneAndUpdate(
        { order_id: String(order_id), platform: 'shipmaxx' },
        { $set: { awb_code: awb, status: 'SHIPPED', status_updated_at: new Date() } }
      );
    } catch (err) {
      console.error('[ShipMaxx Create Shipment Log Error]', err.message);
    }
  }

  res.json(new ApiResponse(200, data, 'Shipment created'));
});

export const trackShipment = catchAsync(async (req, res) => {
  const awb = req.params.awb || req.query.awb;
  if (!awb) return res.json(new ApiResponse(400, null, 'awb is required'));
  const data = await smx.trackShipment(awb);
  res.json(new ApiResponse(200, data, 'Tracking info fetched'));
});

export const generateLabel = async (req, res, next) => {
  try {
    const awb = req.params.awb || req.query.awb;
    if (!awb) return res.json(new ApiResponse(400, null, 'awb is required'));

    const dbOrder = await Order.findOne({
      platform: 'shipmaxx',
      $or: [{ awb_code: awb }, { order_id: awb }]
    }).select('label_url order_id awb_code raw_response').lean();

    if (dbOrder?.label_url)
      return res.json(new ApiResponse(200, { label_url: dbOrder.label_url }, 'Label URL from cache'));

    const rawLabelUrl = dbOrder?.raw_response?.label_url || dbOrder?.raw_response?.data?.label_url;
    if (rawLabelUrl)
      return res.json(new ApiResponse(200, { label_url: rawLabelUrl }, 'Label URL from order data'));

    const orderId = dbOrder?.order_id || awb;
    try {
      const data = await smx.generateLabel(awb, orderId);
      const labelUrl = data?.label_url || data?.data?.label_url || data?.url;
      if (labelUrl && dbOrder)
        await Order.findOneAndUpdate({ _id: dbOrder._id }, { $set: { label_url: labelUrl } });
      return res.json(new ApiResponse(200, data, 'Label fetched'));
    } catch {
      return res.json(new ApiResponse(200, {
        label_url: null,
        dashboard_url: 'https://appapi.losung360.com',
        message: 'Label not available via API. Please download from ShipMaxx dashboard.',
      }, 'Label not available via API'));
    }
  } catch (err) { next(err); }
};

export const getManifest = async (req, res, next) => {
  try {
    const { awb } = req.params;
    if (!awb) return res.json(new ApiResponse(400, null, 'awb is required'));

    const dbOrder = await Order.findOne({
      platform: 'shipmaxx',
      $or: [{ awb_code: awb }, { order_id: awb }]
    }).select('order_id raw_response').lean();

    const rawManifestUrl = dbOrder?.raw_response?.manifest_url;
    if (rawManifestUrl)
      return res.json(new ApiResponse(200, { manifest_url: rawManifestUrl }, 'Manifest from order data'));

    const orderId = dbOrder?.order_id || awb;
    try {
      const data = await smx.getManifest(awb, orderId);
      return res.json(new ApiResponse(200, data, 'Manifest fetched'));
    } catch {
      return res.json(new ApiResponse(200, {
        manifest_url: null,
        dashboard_url: 'https://appapi.losung360.com',
        message: 'Manifest not available via API. Please download from ShipMaxx dashboard.',
      }, 'Manifest not available via API'));
    }
  } catch (err) { next(err); }
};

// ── Invoice ───────────────────────────────────────────────────────────────────
export const getInvoice = catchAsync(async (req, res) => {
  const { order_id } = req.params;
  if (!order_id) return res.json(new ApiResponse(400, null, 'order_id is required'));
  const data = await smx.getInvoice(order_id);
  res.json(new ApiResponse(200, data, 'Invoice fetched'));
});

// ── NDR Notes (ShipMaxx) ──────────────────────────────────────────────────────
export const getNdrNotes = catchAsync(async (req, res) => {
  const { date, search } = req.query;
  const match = { source: 'shipmaxx' };
  if (date) {
    match.createdAt = {
      $gte: new Date(date + 'T00:00:00.000+05:30'),
      $lte: new Date(date + 'T23:59:59.999+05:30'),
    };
  }
  if (search) {
    match.$or = [
      { name:         { $regex: search, $options: 'i' } },
      { phone_number: { $regex: search, $options: 'i' } },
      { awb_number:   { $regex: search, $options: 'i' } },
    ];
  }
  const notes = await NdrNote.find(match).sort({ createdAt: -1 }).populate('createdBy', 'name role').lean();
  res.json(new ApiResponse(200, notes, 'ShipMaxx NDR notes fetched'));
});

export const createNdrNote = catchAsync(async (req, res) => {
  const { name, phone_number, reason, awb_number } = req.body;
  if (!name || !phone_number || !reason || !awb_number)
    return res.status(400).json(new ApiResponse(400, null, 'name, phone_number, reason, awb_number required'));
  const note = await NdrNote.create({ name, phone_number, reason, awb_number, source: 'shipmaxx', createdBy: req.user._id });
  res.json(new ApiResponse(200, note, 'NDR note created'));
});

export const updateNdrNote = catchAsync(async (req, res) => {
  const note = await NdrNote.findByIdAndUpdate(
    req.params.id,
    { $set: req.body },
    { new: true }
  ).lean();
  if (!note) return res.status(404).json(new ApiResponse(404, null, 'Note not found'));
  res.json(new ApiResponse(200, note, 'NDR note updated'));
});

export const deleteNdrNote = catchAsync(async (req, res) => {
  await NdrNote.findByIdAndDelete(req.params.id);
  res.json(new ApiResponse(200, null, 'NDR note deleted'));
});

// ── Debug: test raw ShipMaxx response ────────────────────────────────────────
export const debugSync = catchAsync(async (req, res) => {
  const sample = await Order.findOne({ platform: 'shipmaxx', awb_code: { $exists: true, $ne: '' } }).lean();
  if (!sample) return res.json(new ApiResponse(200, null, 'No ShipMaxx order with AWB found'));
  const trackRes = await smx.trackShipment(sample.awb_code);
  res.json(new ApiResponse(200, { awb: sample.awb_code, raw: trackRes }, 'Debug response'));
});


export const getDeliveredStats = catchAsync(async (req, res) => {
  const { from, to } = req.query;
  const match = { platform: 'shipmaxx' };
  
  if (from && to) {
    const dateFilter = {
      $gte: new Date(from + 'T00:00:00.000+05:30'),
      $lte: new Date(to + 'T23:59:59.999+05:30'),
    };
    match.$or = [{ createdAt: dateFilter }, { status_updated_at: dateFilter }];
  }

  const [deliveredCountResult, statusBreakdown] = await Promise.all([
    Order.countDocuments({ status: /^delivered$/i, ...match }),
    Order.aggregate([
      { $match: match },
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]),
  ]);

  const breakdown = statusBreakdown.map(item => ({
    _id: item._id || 'UNKNOWN',
    count: item.count,
  }));

  const delIdx = breakdown.findIndex(b => /^delivered$/i.test(b._id));
  if (delIdx === -1) {
    breakdown.unshift({ _id: 'DELIVERED', count: deliveredCountResult });
  } else {
    breakdown[delIdx].count = deliveredCountResult;
  }

  res.json(new ApiResponse(200, { count: deliveredCountResult, revenue: 0, statusBreakdown: breakdown }, 'Delivered stats'));
});

export const getStatusOrders = catchAsync(async (req, res) => {
  const { status, from, to, limit = 50 } = req.query;
  if (!status) return res.status(400).json(new ApiResponse(400, null, 'Status is required'));

  const match = { platform: 'shipmaxx' };
  const statusVariant = status.replace(/[-_]/g, '[-_ ]');
  if (/^undelivered$/i.test(status)) {
    match.status = { $regex: /^undelivered/i };
  } else {
    match.status = new RegExp(`^${statusVariant}$`, 'i');
  }

  if (from && to) {
    const dateFilter = {
      $gte: new Date(from + 'T00:00:00.000+05:30'),
      $lte: new Date(to + 'T23:59:59.999+05:30'),
    };
    match.$or = [{ createdAt: dateFilter }, { status_updated_at: dateFilter }];
  }

  const orders = await Order.find(match)
    .populate({ path: 'lead_id', select: 'phone email assignedTo', populate: { path: 'assignedTo', select: 'name role' } })
    .populate('comments.createdBy', 'name role')
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(limit) || 50, 200)).lean();

  orders.forEach(o => {
    o.staff_name = o.lead_id?.assignedTo?.name || '';
    o.staff_role = o.lead_id?.assignedTo?.role || '';
  });

  res.json(new ApiResponse(200, { data: orders, total: orders.length }, 'Status orders fetched'));
});

export const saveOrderNote = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { text, type = 'general', section = '' } = req.body;
  if (!text) return res.status(400).json(new ApiResponse(400, null, 'text is required'));

  const comment = {
    text,
    type,
    section,
    createdBy: req.user._id,
    createdAt: new Date()
  };

  const order = await Order.findOneAndUpdate(
    { _id: id, platform: 'shipmaxx' },
    { $push: { comments: comment } },
    { new: true }
  ).populate('comments.createdBy', 'name role').lean();

  if (!order) return res.status(404).json(new ApiResponse(404, null, 'Order not found'));
  res.json(new ApiResponse(200, order.comments || [], 'Order note saved'));
});

export const importOrders = catchAsync(async (req, res) => {
  // ShipMaxx does not provide a list-all-orders API endpoint.
  // Orders are created in CRM via createOrder and tracked via AWB.
  // This endpoint syncs tracking status for all existing CRM orders that have an AWB.
  const activeOrders = await Order.find({
    platform: 'shipmaxx',
    awb_code: { $exists: true, $ne: '' },
    status: { $not: /^(delivered|rto_delivered)/i }
  }).lean();

  let updatedCount = 0;
  for (const o of activeOrders) {
    try {
      const trackRes = await smx.trackShipment(o.awb_code);
      const tracking = trackRes?.data?.data || trackRes?.data || trackRes || {};
      const status = tracking.current_status || tracking.status || tracking.shipment_status || tracking.delivery_status;
      if (status) {
        const update = { status: status.toUpperCase(), status_updated_at: new Date() };
        if (status.toUpperCase() === 'DELIVERED') update.delivered_at = new Date();
        await Order.updateOne({ _id: o._id }, { $set: update });
        updatedCount++;
      }
    } catch (err) {
      console.error(`[ShipMaxx Import] AWB ${o.awb_code} track error:`, err.message);
    }
  }

  res.json(new ApiResponse(200, {
    imported: 0,
    skipped: 0,
    updated: updatedCount,
    total: activeOrders.length,
    note: 'ShipMaxx has no list-orders API. Tracking status updated for existing CRM orders with AWB.'
  }, `Sync complete. Updated ${updatedCount} of ${activeOrders.length} active shipments.`));
});
 
//Import by Order ID list (ShipMaxx has no list endpoint — fetch one by one) ─
export const importByIds = catchAsync(async (req, res) => {
  const { order_ids } = req.body;
  if (!Array.isArray(order_ids) || order_ids.length === 0)
    return res.status(400).json(new ApiResponse(400, null, 'order_ids array is required'));

  const ids = [...new Set(order_ids.map(id => String(id).trim()).filter(Boolean))];
  if (ids.length > 500)
    return res.status(400).json(new ApiResponse(400, null, 'Maximum 500 order IDs per request'));

  let imported = 0, updated = 0, skipped = 0, failed = 0;
  const errors = [];

  for (const order_id of ids) {
    try {
      // Fetch full order details from ShipMaxx
      const raw = await smx.getOrder(order_id);
      const o = raw?.data || raw || {};

      if (!o || !o.order_id && !o.id) {
        skipped++;
        errors.push({ order_id, reason: 'Empty response from ShipMaxx' });
        continue;
      }

      const smxOrderId = String(o.order_id || o.id);
      const customer = o.customer || {};
      const existing = await Order.findOne({ order_id: smxOrderId, platform: 'shipmaxx' }).lean();

      const fields = {
        order_id: smxOrderId,
        status: String(o.status || 'NEW').toUpperCase(),
        billing_customer_name: customer.name || o.billing_customer_name || '',
        billing_phone: customer.phone || o.billing_phone || '',
        billing_address: customer.address || o.billing_address || '',
        billing_city: customer.city || o.billing_city || '',
        billing_state: customer.state || o.billing_state || '',
        billing_pincode: customer.pincode || o.billing_pincode || '',
        billing_email: customer.email || o.billing_email || '',
        payment_method: o.payment_method || '',
        sub_total: Number(o.total_amount || o.sub_total || o.amount) || 0,
        awb_code: o.awb || o.awb_number || o.awb_code || '',
        courier_name: o.carrier_name || o.courier_name || '',
        order_items: (o.products || o.items || []).map(p => ({
          name: p.name, sku: p.sku, units: p.quantity, selling_price: p.price
        })),
        weight: o.package?.weight,
        length: o.package?.length,
        breadth: o.package?.width,
        height: o.package?.height,
        platform: 'shipmaxx',
        status_updated_at: new Date(),
        raw_response: o,
      };

      if (existing) {
        await Order.updateOne({ _id: existing._id }, { $set: fields });
        updated++;
      } else {
        await Order.create(fields);
        imported++;
      }
    } catch (err) {
      console.error(`[ShipMaxx ImportByIds] ID ${order_id}:`, err.message);
      failed++;
      errors.push({ order_id, reason: err.message });
    }
  }

  res.json(new ApiResponse(200, {
    total: ids.length, imported, updated, skipped, failed,
    errors: errors.slice(0, 20),
  }, `Done: ${imported} new, ${updated} updated, ${failed} failed out of ${ids.length} order IDs`));
});

export const syncShipmaxx = catchAsync(async (req, res) => {
  const activeOrders = await Order.find({
    platform: 'shipmaxx',
    awb_code: { $exists: true, $ne: '' },
    status: { $not: /^(delivered|rto_delivered)/i }
  }).lean();

  let updatedCount = 0;
  for (const o of activeOrders) {
    try {
      const trackRes = await smx.trackShipment(o.awb_code);
      const tracking = trackRes?.data?.data || trackRes?.data || trackRes || {};
      const rawStatus = tracking.current_status || tracking.status || tracking.shipment_status || tracking.delivery_status;
      if (rawStatus) {
        const status = rawStatus.toUpperCase();
        const update = { status, status_updated_at: new Date() };
        if (status === 'DELIVERED') {
          update.delivered_at = new Date();
          // Update lead status to follow_up
          if (o.lead_id) await Lead.findByIdAndUpdate(o.lead_id, { status: 'follow_up' }).catch(() => {});
        }
        await Order.updateOne({ _id: o._id }, { $set: update });
        updatedCount++;
      }
    } catch (err) {
      console.error(`[Sync ShipMaxx] AWB ${o.awb_code} track error:`, err.message);
    }
  }

  // Auto set followups for newly delivered orders
  const needsFollowUps = await Order.find({
    platform: 'shipmaxx',
    status: /^delivered$/i,
    auto_followups_set: { $ne: true },
  }).select('_id delivered_at createdAt').lean();
  for (const o of needsFollowUps) {
    await setAutoFollowUps(o._id, o.delivered_at || o.createdAt || new Date());
  }

  // Sync delivered orders into DeliveredOrder collection
  const delivered = await Order.find({ platform: 'shipmaxx', status: /^delivered$/i })
    .select('order_id billing_customer_name billing_phone billing_email billing_address billing_city billing_state billing_pincode awb_code courier_name payment_method sub_total order_items status lead_id delivered_at createdAt').lean();
  for (const o of delivered) {
    await DeliveredOrder.findOneAndUpdate(
      { order_id: o.order_id },
      { $set: { order_id: o.order_id, billing_customer_name: o.billing_customer_name || '', billing_phone: o.billing_phone || '', billing_email: o.billing_email || '', billing_address: o.billing_address || '', billing_city: o.billing_city || '', billing_state: o.billing_state || '', billing_pincode: o.billing_pincode || '', awb_code: o.awb_code || '', courier_name: o.courier_name || '', payment_method: o.payment_method || '', sub_total: o.sub_total || 0, order_items: o.order_items || [], status: o.status, lead_id: o.lead_id || null, delivered_at: o.delivered_at || o.createdAt, order_date: o.createdAt } },
      { upsert: true }
    ).catch(() => {});
  }

  // Sync active orders into InTransitOrder collection
  const active = await Order.find({ platform: 'shipmaxx', status: { $not: /^(delivered|rto)/i } })
    .select('order_id billing_customer_name billing_phone billing_city billing_state billing_pincode awb_code courier_name payment_method sub_total order_items status lead_id status_updated_at createdAt').lean();
  for (const o of active) {
    await InTransitOrder.findOneAndUpdate(
      { order_id: o.order_id },
      { $set: { order_id: o.order_id, billing_customer_name: o.billing_customer_name || '', billing_phone: o.billing_phone || '', billing_city: o.billing_city || '', billing_state: o.billing_state || '', billing_pincode: o.billing_pincode || '', awb_code: o.awb_code || '', courier_name: o.courier_name || '', payment_method: o.payment_method || '', sub_total: o.sub_total || 0, order_items: o.order_items || [], status: o.status, lead_id: o.lead_id || null, status_updated_at: o.status_updated_at || o.createdAt, order_date: o.createdAt } },
      { upsert: true }
    ).catch(() => {});
  }
  await InTransitOrder.deleteMany({ order_id: { $in: delivered.map(o => o.order_id) } }).catch(() => {});

  res.json(new ApiResponse(200, { updatedCount, deliveredSynced: delivered.length, activeSynced: active.length }, `Sync complete. Updated: ${updatedCount} orders.`));
});

export const getOrders = catchAsync(async (req, res) => {
  const { status, from, to, search, page = 1, limit = 50, has_awb } = req.query;
  const match = { platform: 'shipmaxx' };

  if (has_awb === 'true') {
    match.awb_code = { $exists: true, $ne: '' };
  }

  if (status && status !== 'all') {
    const statusVariant = status.replace(/[-_]/g, '[-_ ]');
    if (/^undelivered$/i.test(status)) {
      match.status = { $regex: /^undelivered/i };
    } else {
      match.status = new RegExp(`^${statusVariant}$`, 'i');
    }
  }

  if (from && to) {
    match.createdAt = {
      $gte: new Date(from + 'T00:00:00.000+05:30'),
      $lte: new Date(to + 'T23:59:59.999+05:30'),
    };
  }

  if (search) {
    const q = String(search).trim();
    match.$or = [
      { order_id: { $regex: q, $options: 'i' } },
      { awb_code: { $regex: q, $options: 'i' } },
      { billing_customer_name: { $regex: q, $options: 'i' } },
      { billing_phone: { $regex: q, $options: 'i' } },
    ];
  }

  const pg = Math.max(1, Number(page) || 1);
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));

  const [orders, total] = await Promise.all([
    Order.find(match)
      .populate({ path: 'lead_id', select: 'phone email assignedTo', populate: { path: 'assignedTo', select: 'name role' } })
      .populate('comments.createdBy', 'name role')
      .sort({ createdAt: -1 })
      .skip((pg - 1) * lim)
      .limit(lim)
      .lean(),
    Order.countDocuments(match)
  ]);

  orders.forEach(o => {
    o.staff_name = o.lead_id?.assignedTo?.name || '';
    o.staff_role = o.lead_id?.assignedTo?.role || '';
  });

  res.json(new ApiResponse(200, { data: orders, total }, 'Orders fetched successfully'));
});


// ── Delivered Orders ──────────────────────────────────────────────────────────
export const getDeliveredOrders = catchAsync(async (req, res) => {
  const { search, page = 1, per_page = 50, from, to } = req.query;
  const match = { platform: 'shipmaxx', status: /^delivered$/i };
  if (from || to) {
    match.delivered_at = {};
    if (from) match.delivered_at.$gte = new Date(from + 'T00:00:00.000+05:30');
    if (to)   match.delivered_at.$lte = new Date(to + 'T23:59:59.999+05:30');
  }
  if (search) {
    const q = String(search).trim();
    match.$or = [
      { billing_customer_name: { $regex: q, $options: 'i' } },
      { billing_phone: { $regex: q, $options: 'i' } },
      { order_id: { $regex: q, $options: 'i' } },
      { awb_code: { $regex: q, $options: 'i' } },
    ];
  }
  const skip = (Number(page) - 1) * Number(per_page);
  const [orders, total] = await Promise.all([
    Order.find(match)
      .populate({ path: 'lead_id', select: 'phone email assignedTo', populate: { path: 'assignedTo', select: 'name role' } })
      .sort({ delivered_at: -1, createdAt: -1 })
      .skip(skip).limit(Number(per_page)).lean(),
    Order.countDocuments(match),
  ]);
  orders.forEach(o => {
    o.staff_name = o.lead_id?.assignedTo?.name || '';
    o.staff_role = o.lead_id?.assignedTo?.role || '';
  });
  res.json(new ApiResponse(200, { data: orders, total }, 'Delivered orders fetched'));
});

export const getDeliveredOrdersFromSchema = catchAsync(async (req, res) => {
  const { page = 1, per_page = 50, search, from, to } = req.query;

  // Auto-sync delivered orders from Order collection
  const newDelivered = await Order.find({ platform: 'shipmaxx', status: /^delivered$/i })
    .select('order_id billing_customer_name billing_phone billing_email billing_address billing_city billing_state billing_pincode awb_code courier_name payment_method sub_total order_items status lead_id delivered_at createdAt').lean();
  for (const o of newDelivered) {
    await DeliveredOrder.findOneAndUpdate(
      { order_id: o.order_id },
      { $set: { order_id: o.order_id, billing_customer_name: o.billing_customer_name || '', billing_phone: o.billing_phone || '', billing_email: o.billing_email || '', billing_address: o.billing_address || '', billing_city: o.billing_city || '', billing_state: o.billing_state || '', billing_pincode: o.billing_pincode || '', awb_code: o.awb_code || '', courier_name: o.courier_name || '', payment_method: o.payment_method || '', sub_total: o.sub_total || 0, order_items: o.order_items || [], status: o.status, lead_id: o.lead_id || null, delivered_at: o.delivered_at || o.createdAt, order_date: o.createdAt } },
      { upsert: true }
    ).catch(() => {});
  }

  const skip = (Number(page) - 1) * Number(per_page);
  const matchQ = {};
  if (search) matchQ.$or = [
    { billing_customer_name: { $regex: search, $options: 'i' } },
    { billing_phone: { $regex: search, $options: 'i' } },
    { order_id: { $regex: search, $options: 'i' } },
    { awb_code: { $regex: search, $options: 'i' } },
  ];
  if (from || to) {
    matchQ.delivered_at = {};
    if (from) matchQ.delivered_at.$gte = new Date(from + 'T00:00:00.000+05:30');
    if (to)   matchQ.delivered_at.$lte = new Date(to + 'T23:59:59.999+05:30');
  }
  const [data, total] = await Promise.all([
    DeliveredOrder.find(matchQ).sort({ delivered_at: -1 }).skip(skip).limit(Number(per_page)).lean(),
    DeliveredOrder.countDocuments(matchQ),
  ]);
  res.json(new ApiResponse(200, { data, total }, 'Delivered orders fetched from schema'));
});

export const getInTransitOrdersFromSchema = catchAsync(async (req, res) => {
  const { page = 1, per_page = 50, search, from, to } = req.query;

  // Sync active orders into InTransitOrder
  const activeOrders = await Order.find({ platform: 'shipmaxx', status: { $not: /^(delivered|rto)/i } })
    .select('order_id billing_customer_name billing_phone billing_city billing_state billing_pincode awb_code courier_name payment_method sub_total order_items status lead_id status_updated_at createdAt').lean();
  for (const o of activeOrders) {
    await InTransitOrder.findOneAndUpdate(
      { order_id: o.order_id },
      { $set: { order_id: o.order_id, billing_customer_name: o.billing_customer_name || '', billing_phone: o.billing_phone || '', billing_city: o.billing_city || '', billing_state: o.billing_state || '', billing_pincode: o.billing_pincode || '', awb_code: o.awb_code || '', courier_name: o.courier_name || '', payment_method: o.payment_method || '', sub_total: o.sub_total || 0, order_items: o.order_items || [], status: o.status, lead_id: o.lead_id || null, status_updated_at: o.status_updated_at || o.createdAt, order_date: o.createdAt } },
      { upsert: true }
    ).catch(() => {});
  }
  await InTransitOrder.deleteMany({ status: { $regex: /^(delivered|rto)/i } }).catch(() => {});

  const skip = (Number(page) - 1) * Number(per_page);
  const matchQ = {};
  if (search) matchQ.$or = [
    { billing_customer_name: { $regex: search, $options: 'i' } },
    { billing_phone: { $regex: search, $options: 'i' } },
    { order_id: { $regex: search, $options: 'i' } },
    { awb_code: { $regex: search, $options: 'i' } },
  ];
  if (from || to) {
    matchQ.order_date = {};
    if (from) matchQ.order_date.$gte = new Date(from + 'T00:00:00.000+05:30');
    if (to)   matchQ.order_date.$lte = new Date(to + 'T23:59:59.999+05:30');
  }
  const [data, total] = await Promise.all([
    InTransitOrder.find(matchQ).sort({ status_updated_at: -1 }).skip(skip).limit(Number(per_page)).lean(),
    InTransitOrder.countDocuments(matchQ),
  ]);
  res.json(new ApiResponse(200, { data, total }, 'In-transit orders fetched'));
});

// ── Follow-ups ────────────────────────────────────────────────────────────────
export const getOrdersWithFollowUps = catchAsync(async (req, res) => {
  const query = {
    platform: 'shipmaxx',
    status: /^delivered$/i,
    followup_done: { $ne: true },
    sent_to_verification: { $ne: true },
  };

  const delivered = await Order.find(query)
    .populate({ path: 'lead_id', select: 'assignedTo createdBy status', populate: [{ path: 'assignedTo', select: 'name role' }, { path: 'createdBy', select: 'name role' }] })
    .populate('created_by', 'name role')
    .sort({ delivered_at: -1, createdAt: -1 }).lean();

  // Auto-set followups for orders that don't have them yet
  const needsSetting = delivered.filter(o => !o.auto_followups_set);
  if (needsSetting.length) {
    await Promise.all(needsSetting.map(o => setAutoFollowUps(o._id, o.delivered_at || o.createdAt || new Date())));
  }

  const allFollowups = await Followup.find({ order_id: { $in: delivered.map(o => o._id) } })
    .populate('staff', 'name role').sort({ followup_number: 1 }).lean();

  const fuMap = {};
  for (const fu of allFollowups) {
    const key = String(fu.order_id);
    if (!fuMap[key]) fuMap[key] = [];
    fuMap[key].push(fu);
  }

  const enriched = delivered.map(o => ({ ...o, followups: fuMap[String(o._id)] || [] }));
  res.json(new ApiResponse(200, enriched, 'Orders with follow-ups fetched'));
});

export const completeFollowUp = catchAsync(async (req, res) => {
  const { id } = req.params;
  const total = DEFAULT_FOLLOWUP_TOTAL;
  const gap   = DEFAULT_FOLLOWUP_GAP_DAYS;

  const count = await Followup.countDocuments({ order_id: id });
  if (count === 0) {
    const order = await Order.findById(id).select('delivered_at createdAt platform').lean();
    if (!order || order.platform !== 'shipmaxx') return res.status(404).json(new ApiResponse(404, null, 'Order not found'));
    await setAutoFollowUps(id, order.delivered_at || order.createdAt || new Date());
  }

  const current = await Followup.findOne({ order_id: id, completed: false }).sort({ followup_number: 1 });
  if (!current) {
    await Order.findByIdAndUpdate(id, { followup_done: true });
    return res.json(new ApiResponse(200, { completedCount: total, next_follow_up: null }, 'All follow-ups done'));
  }

  current.completed = true;
  current.status = 'completed';
  current.staff = req.user?._id;
  current.followup_date = new Date();
  current.completed_at = new Date();
  if (req.body?.note) { current.note = req.body.note; current.notes = req.body.note; }
  if (current.followup_number >= total) await Order.findByIdAndUpdate(id, { followup_done: true });
  await current.save();

  // Shift remaining followups
  const remaining = await Followup.find({ order_id: id, completed: false }).sort({ followup_number: 1 });
  let nextDate = null;
  if (remaining.length > 0) {
    let base = new Date();
    for (const fu of remaining) {
      base = new Date(base.getTime() + gap * 24 * 60 * 60 * 1000);
      fu.scheduled_date = new Date(base);
      await fu.save();
    }
    nextDate = remaining[0].scheduled_date;
  }

  await Order.findByIdAndUpdate(id, { next_follow_up: nextDate });
  res.json(new ApiResponse(200, { completedCount: current.followup_number, next_follow_up: nextDate, total_followups: total, followup_gap_days: gap }, 'Follow-up completed'));
});

export const getCompletedFollowUps = catchAsync(async (req, res) => {
  const { search, page = 1, per_page = 20 } = req.query;
  const match = { platform: 'shipmaxx', status: /^delivered$/i, followup_done: true };
  if (search) match.$or = [
    { billing_customer_name: { $regex: search, $options: 'i' } },
    { billing_phone: { $regex: search, $options: 'i' } },
    { order_id: { $regex: search, $options: 'i' } },
    { awb_code: { $regex: search, $options: 'i' } },
  ];

  const skip = (Number(page) - 1) * Number(per_page);
  const [orders, total] = await Promise.all([
    Order.find(match)
      .populate({ path: 'lead_id', select: 'assignedTo createdBy', populate: [{ path: 'assignedTo', select: 'name role' }, { path: 'createdBy', select: 'name role' }] })
      .sort({ delivered_at: -1 }).skip(skip).limit(Number(per_page)).lean(),
    Order.countDocuments(match),
  ]);

  const allFollowups = await Followup.find({ order_id: { $in: orders.map(o => o._id) } })
    .populate('staff', 'name role').sort({ followup_number: 1 }).lean();
  const fuMap = {};
  for (const fu of allFollowups) {
    const key = String(fu.order_id);
    if (!fuMap[key]) fuMap[key] = [];
    fuMap[key].push(fu);
  }
  const enriched = orders.map(o => ({ ...o, followups: fuMap[String(o._id)] || [] }));
  res.json(new ApiResponse(200, { data: enriched, total, page: Number(page), per_page: Number(per_page) }, 'Completed follow-ups fetched'));
});

export const addFollowUp = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { note, next_follow_up, status = 'scheduled' } = req.body;
  const existing = await Followup.countDocuments({ order_id: id });
  await Followup.create({
    order_id: id,
    followup_number: existing + 1,
    scheduled_date: next_follow_up ? new Date(next_follow_up) : new Date(),
    followup_date: status === 'completed' ? new Date() : undefined,
    staff: status === 'completed' ? req.user?._id : undefined,
    status,
    note: note || '',
    notes: note || '',
    completed: status === 'completed',
    completed_at: status === 'completed' ? new Date() : undefined,
  });
  const order = await Order.findByIdAndUpdate(id, { ...(next_follow_up ? { next_follow_up: new Date(next_follow_up) } : {}) }, { new: true }).select('next_follow_up').lean();
  res.json(new ApiResponse(200, order, 'Follow up added'));
});

export const setNextFollowUp = catchAsync(async (req, res) => {
  const order = await Order.findByIdAndUpdate(req.params.id, { next_follow_up: req.body.next_follow_up ? new Date(req.body.next_follow_up) : null }, { new: true }).select('next_follow_up').lean();
  res.json(new ApiResponse(200, order, 'Next follow up set'));
});

export const updateFollowupRelief = catchAsync(async (req, res) => {
  const { followup_number, relief_percentage } = req.body;
  if (!followup_number || relief_percentage === undefined)
    return res.status(400).json(new ApiResponse(400, null, 'followup_number and relief_percentage required'));
  const fu = await Followup.findOneAndUpdate(
    { order_id: req.params.id, followup_number: Number(followup_number) },
    { $set: { relief_percentage: Number(relief_percentage) } },
    { new: true }
  );
  if (!fu) return res.status(404).json(new ApiResponse(404, null, 'Followup not found'));
  res.json(new ApiResponse(200, fu, 'Relief percentage updated'));
});

// ── Order Activity & Contact ──────────────────────────────────────────────────
export const getOrderActivity = catchAsync(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, platform: 'shipmaxx' })
    .select('comments notes order_id billing_customer_name status createdAt')
    .populate('comments.createdBy', 'name role').lean();
  if (!order) return res.status(404).json(new ApiResponse(404, null, 'Order not found'));
  const activity = (order.comments || []).map(c => ({
    _id: c._id,
    type: c.type || 'general',
    title: c.type === 'followup' ? 'Follow-up Note' : 'Note Added',
    description: c.text || '',
    actor: c.createdBy,
    createdAt: c.createdAt,
  }));
  res.json(new ApiResponse(200, activity, 'Activity fetched'));
});

export const updateOrderContact = catchAsync(async (req, res) => {
  const { id } = req.params;
  const allowed = ['billing_phone', 'billing_city', 'billing_state', 'billing_pincode', 'billing_address'];
  const update = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) update[key] = String(req.body[key]).trim();
  }
  if (!Object.keys(update).length) return res.status(400).json(new ApiResponse(400, null, 'No valid fields'));
  const order = await Order.findOneAndUpdate({ _id: id, platform: 'shipmaxx' }, { $set: update }, { new: true })
    .select(allowed.join(' ') + ' lead_id').lean();
  if (!order) return res.status(404).json(new ApiResponse(404, null, 'Order not found'));
  if (order.lead_id) {
    const leadUpdate = {};
    if (update.billing_phone)   leadUpdate.phone       = update.billing_phone;
    if (update.billing_city)    leadUpdate.cityVillage = update.billing_city;
    if (update.billing_state)   leadUpdate.state       = update.billing_state;
    if (update.billing_pincode) leadUpdate.pincode     = update.billing_pincode;
    if (update.billing_address) leadUpdate.address     = update.billing_address;
    if (Object.keys(leadUpdate).length) await Lead.findByIdAndUpdate(order.lead_id, { $set: leadUpdate });
  }
  res.json(new ApiResponse(200, order, 'Contact updated'));
});

// ── Search by phone (for order creation auto-fill) ────────────────────────────
export const searchOrderByPhone = catchAsync(async (req, res) => {
  const { phone } = req.query;
  if (!phone || phone.replace(/\D/g, '').length < 5) return res.json(new ApiResponse(200, null, 'No result'));
  const clean = phone.replace(/\D/g, '');
  const last10 = clean.slice(-10);

  let order = await Order.findOne({
    platform: 'shipmaxx',
    $or: [{ billing_phone: { $regex: last10 } }, { billing_phone: { $regex: clean } }]
  }).sort({ createdAt: -1 }).lean();

  let lead = await Lead.findOne({ phone: { $regex: last10 }, isDeleted: { $ne: true } }).lean();

  if (!order && lead) {
    order = {
      billing_customer_name: lead.name || '',
      billing_phone: lead.phone || '',
      billing_email: lead.email || '',
      billing_address: lead.address || '',
      billing_city: lead.cityVillage || lead.district || '',
      billing_state: lead.state || '',
      billing_pincode: lead.pincode || '',
      sub_total: 0,
      order_items: [],
    };
  }
  if (!order) return res.json(new ApiResponse(200, null, 'Not found'));

  const activeLead = lead;
  if (activeLead) {
    if (!order.billing_customer_name) order.billing_customer_name = activeLead.name || '';
    if (!order.billing_address) order.billing_address = activeLead.address || '';
    if (!order.billing_pincode) order.billing_pincode = activeLead.pincode || '';
    if (!order.billing_city) order.billing_city = activeLead.cityVillage || activeLead.district || '';
    if (!order.billing_state) order.billing_state = activeLead.state || '';
    if (!order.billing_email) order.billing_email = activeLead.email || '';
  }

  res.json(new ApiResponse(200, {
    billing_customer_name: order.billing_customer_name || '',
    billing_phone: order.billing_phone || clean,
    billing_email: order.billing_email || '',
    billing_address: order.billing_address || '',
    billing_city: order.billing_city || '',
    billing_state: order.billing_state || '',
    billing_pincode: String(order.billing_pincode || ''),
    order_items: order.order_items || [],
    sub_total: order.sub_total || 0,
    delivered_at: order.delivered_at || null,
    order_id: order.order_id || '',
    courier_name: order.courier_name || '',
    payment_method: order.payment_method || '',
  }, 'Order found'));
});

// ── Send to Verification ──────────────────────────────────────────────────────
export const sendToVerification = catchAsync(async (req, res) => {
  const { id } = req.params;
  const order = await Order.findOne({ _id: id, platform: 'shipmaxx' }).populate('lead_id');
  if (!order) return res.status(404).json(new ApiResponse(404, null, 'Order not found'));

  let lead = order.lead_id;
  if (!lead) {
    const phone = order.billing_phone;
    if (phone && String(phone).replace(/\D/g, '').length >= 10) {
      lead = await Lead.findOne({ phone, isDeleted: { $ne: true } });
    }
    if (!lead) {
      lead = await Lead.create({
        name: order.billing_customer_name || 'Unknown Customer',
        phone: order.billing_phone || 'N/A',
        address: order.billing_address || '',
        status: 'follow_up',
        createdBy: req.user._id,
      });
      await Order.findByIdAndUpdate(id, { lead_id: lead._id });
    }
  }

  const followups = await Followup.find({ order_id: id }).sort({ followup_number: 1 }).lean();
  const lastRelief = [...followups].reverse().find(f => f.relief_percentage != null)?.relief_percentage ?? null;

  const task = await Task.create({
    title: `Re-Verification for ${lead.name || order.billing_customer_name}`,
    lead: lead._id,
    assignedTo: lead.assignedTo || req.user._id,
    createdBy: req.user._id,
    status: 'verification',
    dueDate: new Date(),
    cityVillage: order.billing_city,
    state: order.billing_state,
    pincode: order.billing_pincode,
    address: order.billing_address,
    phone: order.billing_phone,
    price: order.sub_total,
  });

  await Verification.create({
    task: task._id,
    title: task.title,
    assignedTo: task.assignedTo,
    lead: task.lead,
    dueDate: task.dueDate,
    cityVillage: task.cityVillage,
    state: task.state,
    pincode: task.pincode,
    address: task.address,
    price: task.price,
    relief_percentage: lastRelief,
  });

  await Order.findByIdAndUpdate(id, { followup_done: true, sent_to_verification: true, verified_by: task.assignedTo });
  await Lead.findByIdAndUpdate(lead._id, { $set: { pending_reorder_source: id, pending_reorder_staff: task.assignedTo } });

  res.json(new ApiResponse(200, task, 'Order sent to verification successfully'));
});

// ── Manual Followup ───────────────────────────────────────────────────────────
export const createManualFollowup = catchAsync(async (req, res) => {
  const { name, phone, city, state, medicine, delivered_date, amount, order_id, courier_name, payment_method, pincode, address } = req.body;
  if (!name || !phone || !medicine || !delivered_date)
    return res.status(400).json(new ApiResponse(400, null, 'name, phone, medicine, delivered_date are required'));

  const mockOrderId = order_id ? `${order_id}-M${Date.now()}` : `SMX-MANUAL-${Date.now()}`;
  const d = new Date(delivered_date);

  const newOrder = await Order.create({
    order_id: mockOrderId,
    status: 'DELIVERED',
    delivered_at: d,
    billing_customer_name: name,
    billing_phone: phone,
    billing_city: city || '',
    billing_state: state || '',
    billing_pincode: pincode || '',
    billing_address: address || '',
    sub_total: Number(amount) || 0,
    order_items: [{ name: medicine }],
    courier_name: courier_name || '',
    payment_method: payment_method || '',
    platform: 'shipmaxx',
    created_by: req.user._id,
    auto_followups_set: true,
  });

  const total = DEFAULT_FOLLOWUP_TOTAL;
  const gap   = DEFAULT_FOLLOWUP_GAP_DAYS;
  const followups = [];
  let baseDate = new Date();
  for (let i = 1; i <= total; i++) {
    if (i > 1) baseDate.setDate(baseDate.getDate() + gap);
    followups.push({ order_id: newOrder._id, followup_number: i, scheduled_date: new Date(baseDate), status: 'scheduled', note: '' });
  }
  await Followup.insertMany(followups);

  res.json(new ApiResponse(200, newOrder, 'Manual followup added successfully'));
});
