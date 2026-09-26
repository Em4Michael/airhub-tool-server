const router = require('express').Router();
const { protect, adminOnly } = require('../middleware/auth');
const ts = require('../controllers/timesheet.controller');

router.use(protect);

router.post('/', ts.submitTimesheet);
router.get('/me', ts.getMyTimesheets);
router.get('/', adminOnly, ts.getAllTimesheets);
router.patch('/:id/approve', adminOnly, ts.approveTimesheet);
router.patch('/:id/reject', adminOnly, ts.rejectTimesheet);

module.exports = router;
