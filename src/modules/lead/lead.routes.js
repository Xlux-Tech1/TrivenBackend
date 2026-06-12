import express from 'express';
import auth from '../../middleware/auth.js';
import requireCheckedIn from '../../middleware/requireCheckedIn.js';
import validate from '../../middleware/validate.js';
import departmentFilter from '../../middleware/departmentFilter.js';
import * as leadValidation from './lead.validation.js';
import leadController from './lead.controller.js';

const router = express.Router();

// Public route — no token required (website inquiry form)
router.post('/submit', validate(leadValidation.createLead), leadController.submitLead);

// Public route — department-specific (piles / migraine website forms)
router.post('/submit/:department', validate(leadValidation.createLead), leadController.submitLeadForDepartment);



router.get('/test-verifications', async (req, res) => {
  try {
    const Verification = (await import('../../modules/verification/verification.model.js')).default;
    const records = await Verification.find().sort({ createdAt: -1 }).limit(5).lean();
    res.json(records);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router
  .route('/')
  .post(auth('admin', 'manager', 'sales', 'support'), departmentFilter, requireCheckedIn, validate(leadValidation.createLead), leadController.createLead)
  .get(auth('admin', 'manager', 'sales', 'support'), departmentFilter, validate(leadValidation.getLeads), leadController.getLeads);

router.patch('/:leadId/assign', auth('admin', 'manager'), departmentFilter, validate(leadValidation.assignLead), leadController.assignLead);
router.patch('/:leadId/cnp', auth('admin', 'manager', 'sales', 'support'), departmentFilter, requireCheckedIn, leadController.markCNP);
router.patch('/:leadId/uncnp', auth('admin', 'manager', 'sales', 'support'), departmentFilter, requireCheckedIn, leadController.unmarkCNP);
router.post('/:leadId/notes', auth('admin', 'manager', 'sales', 'support'), departmentFilter, requireCheckedIn, leadController.addNote);
router.post('/:leadId/follow-up', auth('admin', 'manager', 'sales', 'support'), departmentFilter, requireCheckedIn, leadController.addFollowUp);
router.patch('/:leadId/next-follow-up', auth('admin', 'manager', 'sales', 'support'), departmentFilter, requireCheckedIn, leadController.setNextFollowUp);
router.get('/export', auth('admin', 'manager'), departmentFilter, leadController.exportLeads);
router.post('/distribute-unassigned', auth('admin', 'manager'), leadController.distributeUnassigned);
router.get('/search-phone', auth('admin', 'manager', 'sales', 'support'), departmentFilter, leadController.searchByPhone);
router.get('/follow-up/list', auth('admin', 'manager', 'sales', 'support'), departmentFilter, leadController.getFollowUpLeads);

router
  .route('/:leadId')
  .get(auth('admin', 'manager', 'sales', 'support'), departmentFilter, validate(leadValidation.getLead), leadController.getLead)
  .patch(auth('admin', 'manager', 'sales', 'support'), departmentFilter, requireCheckedIn, validate(leadValidation.updateLead), leadController.updateLead)
  .delete(auth('admin', 'manager'), departmentFilter, validate(leadValidation.deleteLead), leadController.deleteLead);

export default router;
