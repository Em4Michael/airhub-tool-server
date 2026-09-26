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

    // ── 1. Rating counts per user ─────────────────────────────────────────
    const perUser = await Rating.aggregate([
      { $match: { createdAt: { $gte: since }, status: 'completed' } },
      {
        $group: {
          _id: '$user',
          totalRatings: { $sum: 1 },
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
          byType: 1,
          lastActive: 1,
          firstActive: 1,
          name: { $arrayElemAt: ['$userInfo.name', 0] },
          email: { $arrayElemAt: ['$userInfo.email', 0] },
          hourlyRate: { $arrayElemAt: ['$userInfo.hourlyRate', 0] },
        },
      },
      { $sort: { totalRatings: -1 } },
    ]);

    // ── 2. Hours from submitted timesheets in the period ─────────────────
    // Timesheets are submitted weekly — sum hoursWorked for timesheets
    // whose periodStart falls within the requested window.
    // We use any status except 'rejected' so pending/approved/paid all count.
    const timesheetHours = await Timesheet.aggregate([
      {
        $match: {
          periodStart: { $gte: since },
          status: { $in: ['pending', 'approved', 'paid'] },
        },
      },
      {
        $group: {
          _id: '$user',
          totalHours: { $sum: '$hoursWorked' },
          timesheetCount: { $sum: 1 },
          // Collect weekly submissions so we can show breakdown
          weeks: {
            $push: {
              periodStart: '$periodStart',
              periodEnd: '$periodEnd',
              hours: '$hoursWorked',
              status: '$status',
            },
          },
        },
      },
    ]);

    // Build a lookup map: userId -> { totalHours, weeks }
    const hoursMap = {};
    timesheetHours.forEach(t => {
      hoursMap[t._id.toString()] = {
        totalHours: t.totalHours,
        timesheetCount: t.timesheetCount,
        weeks: t.weeks.sort((a, b) => new Date(a.periodStart) - new Date(b.periodStart)),
      };
    });

    // ── 3. Combine rating counts + timesheet hours per user ───────────────
    const usersWithBreakdown = perUser.map(u => {
      const typeCounts = {};
      (u.byType || []).forEach(t => { typeCounts[t] = (typeCounts[t] || 0) + 1; });

      const activeDays = u.firstActive && u.lastActive
        ? Math.max(1, Math.ceil((new Date(u.lastActive) - new Date(u.firstActive)) / (1000 * 60 * 60 * 24)) + 1)
        : 1;

      const uid = u._id.toString();
      const tsData = hoursMap[uid] || null;
      const totalHours = tsData ? tsData.totalHours : null;
      const estimatedEarnings = (totalHours !== null && u.hourlyRate)
        ? parseFloat((totalHours * u.hourlyRate).toFixed(2))
        : null;

      return {
        userId: u._id,
        name: u.name || 'Unknown',
        email: u.email || '',
        totalRatings: u.totalRatings,
        // Hours come from submitted timesheets only — never assumed
        totalHours,
        timesheetCount: tsData ? tsData.timesheetCount : 0,
        weeklyBreakdown: tsData ? tsData.weeks : [],
        hasTimeData: totalHours !== null && totalHours > 0,
        ratingsPerDay: parseFloat((u.totalRatings / activeDays).toFixed(1)),
        lastActive: u.lastActive,
        taskBreakdown: typeCounts,
        hourlyRate: u.hourlyRate || 0,
        estimatedEarnings,
      };
    });

    // ── 4. Daily rating trend ─────────────────────────────────────────────
    const dailyTrend = await Rating.aggregate([
      { $match: { createdAt: { $gte: since }, status: 'completed' } },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            user: '$user',
          },
          count: { $sum: 1 },
        },
      },
      {
        $group: {
          _id: '$_id.date',
          totalRatings: { $sum: '$count' },
          uniqueUsers: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // ── 5. Weekly hours trend (from timesheets) ───────────────────────────
    const weeklyHoursTrend = await Timesheet.aggregate([
      {
        $match: {
          periodStart: { $gte: since },
          status: { $in: ['pending', 'approved', 'paid'] },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$periodStart' } },
          totalHours: { $sum: '$hoursWorked' },
          usersCount: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const globalTypeBreakdown = await Rating.aggregate([
      { $match: { createdAt: { $gte: since }, status: 'completed' } },
      { $group: { _id: '$taskType', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    const hourlyDist = await Rating.aggregate([
      { $match: { createdAt: { $gte: since }, status: 'completed' } },
      { $group: { _id: { $hour: '$createdAt' }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    const topByRatings = [...usersWithBreakdown].sort((a, b) => b.totalRatings - a.totalRatings).slice(0, 5);
    const topByHours = [...usersWithBreakdown].filter(u => u.hasTimeData).sort((a, b) => b.totalHours - a.totalHours).slice(0, 5);
    const topByRate = [...usersWithBreakdown].sort((a, b) => b.ratingsPerDay - a.ratingsPerDay).slice(0, 5);

    // Totals
    const usersWithTime = usersWithBreakdown.filter(u => u.hasTimeData);
    const totalHoursAll = usersWithTime.length > 0
      ? parseFloat(usersWithTime.reduce((s, u) => s + u.totalHours, 0).toFixed(2))
      : null;

    res.json({
      success: true,
      data: {
        period: { days: parseInt(days), since },
        users: usersWithBreakdown,
        dailyTrend,
        weeklyHoursTrend,
        globalTypeBreakdown,
        hourlyDist,
        topPerformers: { byRatings: topByRatings, byHours: topByHours, byRate: topByRate },
        totals: {
          totalRatings: usersWithBreakdown.reduce((s, u) => s + u.totalRatings, 0),
          totalHours: totalHoursAll,
          hasTimeData: totalHoursAll !== null,
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

    // Daily rating counts
    const daily = await Rating.aggregate([
      { $match: { user: uid, createdAt: { $gte: since }, status: 'completed' } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
          types: { $push: '$taskType' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Hourly pattern
    const hourly = await Rating.aggregate([
      { $match: { user: uid, createdAt: { $gte: since }, status: 'completed' } },
      { $group: { _id: { $hour: '$createdAt' }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    // Task type breakdown
    const typeBreakdown = await Rating.aggregate([
      { $match: { user: uid, createdAt: { $gte: since }, status: 'completed' } },
      { $group: { _id: '$taskType', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    // Timesheets — each weekly submission with hours
    const timesheets = await Timesheet.find({
      user: uid,
      periodStart: { $gte: since },
      status: { $in: ['pending', 'approved', 'paid'] },
    }).sort({ periodStart: 1 }).select('periodStart periodEnd hoursWorked status grossAmount ratingsCompleted');

    const totalHours = timesheets.reduce((s, t) => s + (t.hoursWorked || 0), 0);
    const hasTimeData = totalHours > 0;

    // Recent ratings
    const recent = await Rating.find({ user: uid, status: 'completed' })
      .sort({ createdAt: -1 })
      .limit(20)
      .select('taskType inputUrl query createdAt evaluation.finalRating evaluation.needsMetRating');

    res.json({
      success: true,
      data: {
        user: { name: user.name, email: user.email, hourlyRate: user.hourlyRate },
        daily,
        hourly,
        typeBreakdown,
        timesheets,
        totalHours: hasTimeData ? totalHours : null,
        hasTimeData,
        recent,
      },
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/admin/dashboard — rich dashboard with period breakdown
exports.getDashboardAnalytics = async (req, res, next) => {
  try {
    const now = new Date();

    // Period boundaries
    const periods = {
      week:     new Date(now - 7  * 86400000),
      biweekly: new Date(now - 14 * 86400000),
      month:    new Date(now - 30 * 86400000),
      allTime:  new Date(0),
    };

    // Core counts
    const [totalUsers, pendingApproval, totalRatings, pendingTimesheets, pendingPayments] = await Promise.all([
      User.countDocuments({ role: 'rater' }),
      User.countDocuments({ isApproved: false, role: 'rater' }),
      Rating.countDocuments({ status: 'completed' }),
      Timesheet.countDocuments({ status: 'pending' }),
      Payment.countDocuments({ status: 'pending' }),
    ]);

    // Earnings + hours per period from timesheets
    const earningsAndHours = async (since) => {
      const rows = await Timesheet.aggregate([
        { $match: { periodStart: { $gte: since }, status: { $in: ['approved', 'paid'] } } },
        { $group: { _id: null, totalEarnings: { $sum: '$grossAmount' }, totalHours: { $sum: '$hoursWorked' } } },
      ]);
      return rows[0] || { totalEarnings: 0, totalHours: 0 };
    };

    // Ratings per period
    const ratingCount = async (since) =>
      Rating.countDocuments({ createdAt: { $gte: since }, status: 'completed' });

    // Active users per period (submitted at least one rating)
    const activeUsers = async (since) => {
      const rows = await Rating.aggregate([
        { $match: { createdAt: { $gte: since }, status: 'completed' } },
        { $group: { _id: '$user' } },
        { $count: 'count' },
      ]);
      return rows[0]?.count || 0;
    };

    const [
      w_eh, bw_eh, m_eh, at_eh,
      w_r, bw_r, m_r, at_r,
      w_u, bw_u, m_u, at_u,
    ] = await Promise.all([
      earningsAndHours(periods.week),
      earningsAndHours(periods.biweekly),
      earningsAndHours(periods.month),
      earningsAndHours(periods.allTime),
      ratingCount(periods.week),
      ratingCount(periods.biweekly),
      ratingCount(periods.month),
      ratingCount(periods.allTime),
      activeUsers(periods.week),
      activeUsers(periods.biweekly),
      activeUsers(periods.month),
      activeUsers(periods.allTime),
    ]);

    const byPeriod = {
      week:     { earnings: w_eh.totalEarnings,  hours: w_eh.totalHours,  ratings: w_r,  activeUsers: w_u  },
      biweekly: { earnings: bw_eh.totalEarnings, hours: bw_eh.totalHours, ratings: bw_r, activeUsers: bw_u },
      month:    { earnings: m_eh.totalEarnings,  hours: m_eh.totalHours,  ratings: m_r,  activeUsers: m_u  },
      allTime:  { earnings: at_eh.totalEarnings, hours: at_eh.totalHours, ratings: at_r, activeUsers: at_u },
    };

    // Daily ratings trend last 30 days
    const dailyTrend = await Rating.aggregate([
      { $match: { createdAt: { $gte: periods.month }, status: 'completed' } },
      { $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
          users: { $addToSet: '$user' },
      }},
      { $project: { _id: 1, count: 1, uniqueUsers: { $size: '$users' } } },
      { $sort: { _id: 1 } },
    ]);

    // Weekly earnings trend last 3 months
    const earningsTrend = await Timesheet.aggregate([
      { $match: { periodStart: { $gte: new Date(now - 90 * 86400000) }, status: { $in: ['approved', 'paid'] } } },
      { $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$periodStart' } },
          earnings: { $sum: '$grossAmount' },
          hours: { $sum: '$hoursWorked' },
          users: { $sum: 1 },
      }},
      { $sort: { _id: 1 } },
    ]);

    // Task type breakdown all time
    const taskBreakdown = await Rating.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: '$taskType', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    // Top earners all time
    const topEarners = await Timesheet.aggregate([
      { $match: { status: { $in: ['approved', 'paid'] } } },
      { $group: { _id: '$user', totalEarnings: { $sum: '$grossAmount' }, totalHours: { $sum: '$hoursWorked' } } },
      { $sort: { totalEarnings: -1 } },
      { $limit: 5 },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
      { $project: { totalEarnings: 1, totalHours: 1, name: { $arrayElemAt: ['$u.name', 0] }, email: { $arrayElemAt: ['$u.email', 0] } } },
    ]);

    // Most active raters (by rating count, all time)
    const topRaters = await Rating.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: '$user', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
      { $project: { count: 1, name: { $arrayElemAt: ['$u.name', 0] }, email: { $arrayElemAt: ['$u.email', 0] } } },
    ]);

    res.json({
      success: true,
      data: {
        totals: { totalUsers, pendingApproval, totalRatings, pendingTimesheets, pendingPayments },
        byPeriod,
        dailyTrend,
        earningsTrend,
        taskBreakdown,
        topEarners,
        topRaters,
      },
    });
  } catch (err) { next(err); }
};

// GET /api/admin/users/:id/stats — individual user stats with period breakdown
exports.getUserStats = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const mongoose = require('mongoose');
    const uid = new mongoose.Types.ObjectId(req.params.id);
    const now = new Date();

    const periods = {
      week:     new Date(now - 7  * 86400000),
      biweekly: new Date(now - 14 * 86400000),
      month:    new Date(now - 30 * 86400000),
      allTime:  new Date(0),
    };

    // Ratings per period
    const ratingsPer = async (since) =>
      Rating.countDocuments({ user: uid, createdAt: { $gte: since }, status: 'completed' });

    // Timesheet hours + earnings per period
    const tsPer = async (since) => {
      const rows = await Timesheet.aggregate([
        { $match: { user: uid, periodStart: { $gte: since }, status: { $in: ['pending','approved','paid'] } } },
        { $group: { _id: null, hours: { $sum: '$hoursWorked' }, earnings: { $sum: '$grossAmount' }, count: { $sum: 1 } } },
      ]);
      return rows[0] || { hours: 0, earnings: 0, count: 0 };
    };

    const [w_r, bw_r, m_r, at_r, w_t, bw_t, m_t, at_t] = await Promise.all([
      ratingsPer(periods.week), ratingsPer(periods.biweekly),
      ratingsPer(periods.month), ratingsPer(periods.allTime),
      tsPer(periods.week), tsPer(periods.biweekly),
      tsPer(periods.month), tsPer(periods.allTime),
    ]);

    const byPeriod = {
      week:     { ratings: w_r,  hours: w_t.hours,  earnings: w_t.earnings,  timesheets: w_t.count  },
      biweekly: { ratings: bw_r, hours: bw_t.hours, earnings: bw_t.earnings, timesheets: bw_t.count },
      month:    { ratings: m_r,  hours: m_t.hours,  earnings: m_t.earnings,  timesheets: m_t.count  },
      allTime:  { ratings: at_r, hours: at_t.hours, earnings: at_t.earnings, timesheets: at_t.count },
    };

    // Daily rating activity last 30 days
    const dailyActivity = await Rating.aggregate([
      { $match: { user: uid, createdAt: { $gte: periods.month }, status: 'completed' } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    // Task breakdown all time
    const taskBreakdown = await Rating.aggregate([
      { $match: { user: uid, status: 'completed' } },
      { $group: { _id: '$taskType', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    // All timesheets
    const timesheets = await Timesheet.find({ user: uid })
      .sort({ periodStart: -1 })
      .limit(20)
      .select('periodStart periodEnd hoursWorked grossAmount status ratingsCompleted');

    // Recent ratings
    const recentRatings = await Rating.find({ user: uid, status: 'completed' })
      .sort({ createdAt: -1 })
      .limit(10)
      .select('taskType inputUrl query createdAt evaluation.finalRating evaluation.needsMetRating');

    res.json({
      success: true,
      data: {
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          bankAccount: user.bankAccount,
          hourlyRate: user.hourlyRate,
          isApproved: user.isApproved,
          isActive: user.isActive,
          createdAt: user.createdAt,
          lastLogin: user.lastLogin,
        },
        byPeriod,
        dailyActivity,
        taskBreakdown,
        timesheets,
        recentRatings,
      },
    });
  } catch (err) { next(err); }
};