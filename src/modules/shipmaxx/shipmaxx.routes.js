import express from 'express';
import auth from '../../middleware/auth.js';
import * as c from './shipmaxx.controller.js';

const router = express.Router();

// ── Debug ─────────────────────────────────────────────────────────────────────
router.get('/debug/sync', auth(), c.debugSync);

// ── Auth ──────────────────────────────────────────────────────────────────────
router.post('/auth/login', auth(), c.login);
router.post('/auth/set-password', auth(), c.setPassword);

// ── Orders (specific routes BEFORE parameterized) ─────────────────────────────
router.get('/orders', auth(), c.getOrders);
router.get('/orders/stats', auth(), c.getDeliveredStats);
router.get('/orders/status', auth(), c.getStatusOrders);
router.get('/orders/delivered', auth(), c.getDeliveredOrders);
router.get('/orders/delivered-schema', auth(), c.getDeliveredOrdersFromSchema);
router.get('/orders/in-transit-schema', auth(), c.getInTransitOrdersFromSchema);
router.get('/orders/with-followups', auth(), c.getOrdersWithFollowUps);
router.get('/orders/completed-followups', auth(), c.getCompletedFollowUps);
router.get('/orders/search-by-phone', auth(), c.searchOrderByPhone);
router.post('/orders/create', auth(), c.createOrder);
router.post('/orders/sync', auth(), c.syncShipmaxx);
router.post('/orders/import', auth(), c.importOrders);
router.post('/orders/import-by-ids', auth(), c.importByIds);
router.post('/orders/manual-followup', auth(), c.createManualFollowup);

router.get('/orders/:order_id', auth(), c.getOrder);
router.put('/orders/:order_id', auth(), c.updateOrder);

// ── Per-order actions ─────────────────────────────────────────────────────────
router.post('/orders/:id/notes', auth(), c.saveOrderNote);
router.post('/orders/:id/follow-up', auth(), c.addFollowUp);
router.patch('/orders/:id/next-follow-up', auth(), c.setNextFollowUp);
router.post('/orders/:id/complete-followup', auth(), c.completeFollowUp);
router.patch('/orders/:id/followup-relief', auth(), c.updateFollowupRelief);
router.patch('/orders/:id/contact', auth(), c.updateOrderContact);
router.get('/orders/:id/activity', auth(), c.getOrderActivity);
router.post('/orders/:id/send-to-verification', auth(), c.sendToVerification);

// ── Shipping ──────────────────────────────────────────────────────────────────
router.post('/shipping/create-shipment', auth(), c.createShipment);
router.get('/shipping/track-shipment', auth(), c.trackShipment);
router.get('/shipping/track-shipment/:awb', auth(), c.trackShipment);
router.get('/shipping/generate-label', auth(), c.generateLabel);
router.get('/shipping/generate-label/:awb', auth(), c.generateLabel);
router.get('/shipping/manifest/:awb', auth(), c.getManifest);

// ── Invoice ───────────────────────────────────────────────────────────────────
router.get('/invoice/:order_id', auth(), c.getInvoice);

// ── NDR Notes ─────────────────────────────────────────────────────────────────
router.get('/ndr/notes', auth(), c.getNdrNotes);
router.post('/ndr/notes', auth(), c.createNdrNote);
router.put('/ndr/notes/:id', auth(), c.updateNdrNote);
router.delete('/ndr/notes/:id', auth(), c.deleteNdrNote);

export default router;
