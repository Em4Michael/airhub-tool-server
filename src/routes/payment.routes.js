const router = require('express').Router();
const { protect, adminOnly } = require('../middleware/auth');
const pc = require('../controllers/payment.controller');

router.use(protect);

router.get('/me', pc.getMyPayments);
router.get('/leaderboard', pc.getLeaderboard);
router.get('/', adminOnly, pc.getAllPayments);
router.patch('/:id/pay', adminOnly, pc.markAsPaid);
router.patch('/:id/deny', adminOnly, pc.denyPayment);

module.exports = router;
