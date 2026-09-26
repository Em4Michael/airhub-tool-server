const User = require('../models/User');
const Rating = require('../models/Rating');
const Timesheet = require('../models/Timesheet');
const Payment = require('../models/Payment');
const logger = require('../config/logger');

// GET /api/admin/users — list all users
exports.getAllUsers = async (req, res, next) => {
  try {
    const { approved, role, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (approved !== undefined) filter.isApproved = approved === 'true';
    if (role) filter.role = role;

    const [users, total] = await Promise.all([
      User.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit)),
      User.countDocuments(filter),
    ]);

    res.json({ success: true, data: users, pagination: { page: parseInt(page), total, limit: parseInt(limit) } });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/admin/users/:id/approve
exports.approveUser = async (req, res, next) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { isApproved: true },
      { new: true }
    );
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    logger.info(`Admin ${req.user._id} approved user ${user._id}`);
    res.json({ success: true, message: 'User approved.', data: user });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/admin/users/:id/revoke
exports.revokeUser = async (req, res, next) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { isApproved: false },
      { new: true }
    );
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    res.json({ success: true, message: 'User access revoked.', data: user });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/admin/users/:id/profile
exports.updateUserProfile = async (req, res, next) => {
  try {
    const { hourlyRate, bankAccount, phone } = req.body;
    const update = {};
    if (hourlyRate !== undefined) update.hourlyRate = hourlyRate;
    if (bankAccount !== undefined) update.bankAccount = bankAccount;
    if (phone !== undefined) update.phone = phone;
    update.profileSetupByAdmin = true;

    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    res.json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/admin/users/:id/toggle-active
exports.toggleUserActive = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    user.isActive = !user.isActive;
    await user.save();
    res.json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
};

// GET /api/admin/stats — dashboard stats
exports.getDashboardStats = async (req, res, next) => {
  try {
    const [
      totalUsers,
      pendingApproval,
      totalRatings,
      pendingTimesheets,
      pendingPayments,
    ] = await Promise.all([
      User.countDocuments({ role: 'rater' }),
      User.countDocuments({ isApproved: false, role: 'rater' }),
      Rating.countDocuments(),
      Timesheet.countDocuments({ status: 'pending' }),
      Payment.countDocuments({ status: 'pending' }),
    ]);

    // Ratings by type breakdown
    const ratingsByType = await Rating.aggregate([
      { $group: { _id: '$taskType', count: { $sum: 1 } } },
    ]);

    // Top earners this biweek
    const topEarners = await Timesheet.aggregate([
      { $match: { status: { $in: ['approved', 'paid'] } } },
      {
        $group: {
          _id: '$user',
          totalEarnings: { $sum: '$grossAmount' },
          totalHours: { $sum: '$hoursWorked' },
        },
      },
      { $sort: { totalEarnings: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'userInfo',
        },
      },
      {
        $project: {
          totalEarnings: 1,
          totalHours: 1,
          name: { $arrayElemAt: ['$userInfo.name', 0] },
          email: { $arrayElemAt: ['$userInfo.email', 0] },
        },
      },
    ]);

    res.json({
      success: true,
      data: {
        totalUsers,
        pendingApproval,
        totalRatings,
        pendingTimesheets,
        pendingPayments,
        ratingsByType,
        topEarners,
      },
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/admin/ratings — all ratings
exports.getAllRatings = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, userId, taskType } = req.query;
    const filter = {};
    if (userId) filter.user = userId;
    if (taskType) filter.taskType = taskType;

    const [ratings, total] = await Promise.all([
      Rating.find(filter)
        .populate('user', 'name email')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .select('-evaluation.rawResponse'),
      Rating.countDocuments(filter),
    ]);

    res.json({ success: true, data: ratings, pagination: { page: parseInt(page), total } });
  } catch (err) {
    next(err);
  }
};
