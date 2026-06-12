import express from 'express';
import interaktController from './interakt.controller.js';
import { debugTasks } from './interakt.debug.js';

const router = express.Router();

// Route to handle webhooks sent from Interakt
router.post('/webhook', interaktController.handleWebhook);
router.get('/webhook', (req, res) => res.status(200).send('OK'));
router.get('/debug-tasks', debugTasks);
router.get('/latest-leads', interaktController.latestLeads);

export default router;
