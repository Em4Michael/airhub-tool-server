const Payment = require('../models/Payment');
const User = require('../models/User');
const Timesheet = require('../models/Timesheet');
const logger = require('../config/logger');

// GET /api/payments/me
exports.getMyPayments = async (req, res, next) => {
  try {
    const payments = await Payment.find({ user: req.user._id })
      .populate('timesheet', 'hoursWorked periodStart periodEnd')
      .sort({ createdAt: -1 });
    res.json({ success: true, data: payments });
  } catch (err) {
    next(err);
  }
};

// GET /api/payments (admin)
exports.getAllPayments = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const payments = await Payment.find(filter)
      .populate('user', 'name email bankAccount')
      .populate('timesheet', 'hoursWorked periodStart periodEnd')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    res.json({ success: true, data: payments });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/payments/:id/pay (admin)
exports.markAsPaid = async (req, res, next) => {
  try {
    const payment = await Payment.findById(req.params.id).populate('user');
    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found.' });

    payment.status = 'paid';
    payment.paidBy = req.user._id;
    payment.paidAt = new Date();
    await payment.save();

    // Update timesheet status
    await Timesheet.findByIdAndUpdate(payment.timesheet, { status: 'paid', paidAt: new Date() });

    // Update user lifetime earnings
    await User.findByIdAndUpdate(payment.user._id, {
      $inc: { totalEarnings: payment.amount, currentBiweekEarnings: 0 },
    });

    logger.info(`Payment ${payment._id} marked as paid by admin ${req.user._id}`);
    res.json({ success: true, data: payment });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/payments/:id/deny (admin)
exports.denyPayment = async (req, res, next) => {
  try {
    const payment = await Payment.findByIdAndUpdate(
      req.params.id,
      {
        status: 'denied',
        paidBy: req.user._id,
        deniedAt: new Date(),
        denialReason: req.body.reason || '',
      },
      { new: true }
    );
    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found.' });
    res.json({ success: true, data: payment });
  } catch (err) {
    next(err);
  }
};

// GET /api/payments/leaderboard — top earners
exports.getLeaderboard = async (req, res, next) => {
  try {
    const leaderboard = await Payment.aggregate([
      { $match: { status: 'paid' } },
      {
        $group: {
          _id: '$user',
          totalEarnings: { $sum: '$amount' },
          paymentCount: { $sum: 1 },
        },
      },
      { $sort: { totalEarnings: -1 } },
      { $limit: 20 },
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
          paymentCount: 1,
          name: { $arrayElemAt: ['$userInfo.name', 0] },
          email: { $arrayElemAt: ['$userInfo.email', 0] },
        },
      },
    ]);
    res.json({ success: true, data: leaderboard });
  } catch (err) {
    next(err);
  }
};
