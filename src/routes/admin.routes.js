const router = require('express').Router();
const { protect, adminOnly } = require('../middleware/auth');
const admin = require('../controllers/admin.controller');

router.use(protect, adminOnly);

router.get('/stats', admin.getDashboardStats);
router.get('/analytics', admin.getDashboardAnalytics);
router.get('/users', admin.getAllUsers);
router.get('/users/:id/stats', admin.getUserStats);
router.get('/ratings', admin.getAllRatings);
router.get('/usage', admin.getUsageAnalytics);
router.get('/usage/:userId', admin.getUserUsageDetail);
router.patch('/users/:id/approve', admin.approveUser);
router.patch('/users/:id/revoke', admin.revokeUser);
router.patch('/users/:id/profile', admin.updateUserProfile);
router.patch('/users/:id/toggle-active', admin.toggleUserActive);

module.exports = router;