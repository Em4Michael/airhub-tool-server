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


// ─── GET /api/admin/usage — full usage analytics for all users ────────────────
exports.getUsageAnalytics = async (req, res, next) => {
  try {
    const { days = 30 } = req.query;
    const since = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000);

    const perUser = await Rating.aggregate([
      { $match: { createdAt: { $gte: since }, status: 'completed' } },
      {
        $group: {
          _id: '$user',
          totalRatings: { $sum: 1 },
          totalTimeSec: { $sum: '$timeTaken' },
          avgTimeSec: { $avg: '$timeTaken' },
          byType: { $push: '$taskType' },
          lastActive: { $max: '$createdAt' },
          firstActive: { $min: '$createdAt' },
        },
      },
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
          totalRatings: 1,
          totalTimeSec: 1,
          avgTimeSec: 1,
          byType: 1,
          lastActive: 1,
          firstActive: 1,
          name: { $arrayElemAt: ['$userInfo.name', 0] },
          email: { $arrayElemAt: ['$userInfo.email', 0] },
          hourlyRate: { $arrayElemAt: ['$userInfo.hourlyRate', 0] },
          isActive: { $arrayElemAt: ['$userInfo.isActive', 0] },
        },
      },
      { $sort: { totalRatings: -1 } },
    ]);

    const usersWithBreakdown = perUser.map(u => {
  const typeCounts = {};
  (u.byType || []).forEach(t => { typeCounts[t] = (typeCounts[t] || 0) + 1; });
  const activeDays = u.firstActive && u.lastActive
    ? Math.max(1, Math.ceil((new Date(u.lastActive) - new Date(u.firstActive)) / (1000 * 60 * 60 * 24)) + 1)
    : 1;
  return {
    userId: u._id,
    name: u.name || 'Unknown',
    email: u.email || '',
    totalRatings: u.totalRatings,
    totalTimeSec: u.totalTimeSec || 0,
    totalTimeHrs: parseFloat(((u.totalTimeSec || 0) / 3600).toFixed(2)),
    avgTimeSec: Math.round(u.avgTimeSec || 0),
    ratingsPerDay: parseFloat((u.totalRatings / activeDays).toFixed(1)),
    lastActive: u.lastActive,
    taskBreakdown: typeCounts,
    hourlyRate: u.hourlyRate || 0,
    estimatedEarnings: parseFloat((((u.totalTimeSec || 0) / 3600) * (u.hourlyRate || 0)).toFixed(2)),
  };
});

    const dailyTrend = await Rating.aggregate([
      { $match: { createdAt: { $gte: since }, status: 'completed' } },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            user: '$user',
          },
          count: { $sum: 1 },
          timeSec: { $sum: '$timeTaken' },
        },
      },
      {
        $group: {
          _id: '$_id.date',
          totalRatings: { $sum: '$count' },
          uniqueUsers: { $sum: 1 },
          totalTimeSec: { $sum: '$timeSec' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const userDailyTrend = await Rating.aggregate([
      { $match: { createdAt: { $gte: since }, status: 'completed' } },
      {
        $lookup: {
          from: 'users',
          localField: 'user',
          foreignField: '_id',
          as: 'userInfo',
        },
      },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            userId: '$user',
            userName: { $arrayElemAt: ['$userInfo.name', 0] },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.date': 1 } },
    ]);

    const globalTypeBreakdown = await Rating.aggregate([
      { $match: { createdAt: { $gte: since }, status: 'completed' } },
      { $group: { _id: '$taskType', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    const hourlyDist = await Rating.aggregate([
      { $match: { createdAt: { $gte: since }, status: 'completed' } },
      {
        $group: {
          _id: { $hour: '$createdAt' },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const topByRatings = [...usersWithBreakdown].sort((a, b) => b.totalRatings - a.totalRatings).slice(0, 5);
    const topByTime = [...usersWithBreakdown].sort((a, b) => b.totalTimeHrs - a.totalTimeHrs).slice(0, 5);
    const topByRate = [...usersWithBreakdown].sort((a, b) => b.ratingsPerDay - a.ratingsPerDay).slice(0, 5);

    res.json({
      success: true,
      data: {
        period: { days: parseInt(days), since },
        users: usersWithBreakdown,
        dailyTrend,
        userDailyTrend,
        globalTypeBreakdown,
        hourlyDist,
        topPerformers: { byRatings: topByRatings, byTime: topByTime, byRate: topByRate },
        totals: {
          totalRatings: usersWithBreakdown.reduce((s, u) => s + u.totalRatings, 0),
          totalTimeHrs: parseFloat(usersWithBreakdown.reduce((s, u) => s + u.totalTimeHrs, 0).toFixed(2)),
          activeUsers: usersWithBreakdown.length,
          avgRatingsPerUser: usersWithBreakdown.length
            ? parseFloat((usersWithBreakdown.reduce((s, u) => s + u.totalRatings, 0) / usersWithBreakdown.length).toFixed(1))
            : 0,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/admin/usage/:userId — single user deep dive
exports.getUserUsageDetail = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { days = 30 } = req.query;
    const since = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000);

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const mongoose = require('mongoose');
    const uid = new mongoose.Types.ObjectId(userId);

    const daily = await Rating.aggregate([
      { $match: { user: uid, createdAt: { $gte: since }, status: 'completed' } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
          timeSec: { $sum: '$timeTaken' },
          types: { $push: '$taskType' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const hourly = await Rating.aggregate([
      { $match: { user: uid, createdAt: { $gte: since }, status: 'completed' } },
      { $group: { _id: { $hour: '$createdAt' }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    const typeBreakdown = await Rating.aggregate([
      { $match: { user: uid, createdAt: { $gte: since }, status: 'completed' } },
      { $group: { _id: '$taskType', count: { $sum: 1 }, totalTime: { $sum: '$timeTaken' } } },
      { $sort: { count: -1 } },
    ]);

    const recent = await Rating.find({ user: uid, status: 'completed' })
      .sort({ createdAt: -1 })
      .limit(20)
      .select('taskType inputUrl query timeTaken createdAt evaluation.finalRating evaluation.needsMetRating');

    res.json({
      success: true,
      data: {
        user: { name: user.name, email: user.email, hourlyRate: user.hourlyRate },
        daily,
        hourly,
        typeBreakdown,
        recent,
      },
    });
  } catch (err) {
    next(err);
  }
};