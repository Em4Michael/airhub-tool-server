const Timesheet = require('../models/Timesheet');
const Payment = require('../models/Payment');
const User = require('../models/User');
const logger = require('../config/logger');

// Get current biweek period (Sunday → Saturday)
function getCurrentBiweekPeriod() {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sunday
  const start = new Date(now);
  start.setDate(now.getDate() - dayOfWeek);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

// POST /api/timesheets — submit hours
exports.submitTimesheet = async (req, res, next) => {
  try {
    const { hoursWorked, userNotes } = req.body;
    if (!hoursWorked || hoursWorked <= 0) {
      return res.status(400).json({ success: false, message: 'Valid hours worked is required.' });
    }

    const { start, end } = getCurrentBiweekPeriod();

    // Check if already submitted for this period
    const existing = await Timesheet.findOne({
      user: req.user._id,
      periodStart: start,
    });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Timesheet already submitted for this period.' });
    }

    // Count ratings this period
    const Rating = require('../models/Rating');
    const ratingsCompleted = await Rating.countDocuments({
      user: req.user._id,
      createdAt: { $gte: start, $lte: end },
      status: 'completed',
    });

    const timesheet = await Timesheet.create({
      user: req.user._id,
      periodStart: start,
      periodEnd: end,
      hoursWorked,
      ratingsCompleted,
      hourlyRate: req.user.hourlyRate || parseInt(process.env.DEFAULT_HOURLY_RATE) || 2000,
      userNotes,
    });

    res.status(201).json({ success: true, data: timesheet });
  } catch (err) {
    next(err);
  }
};

// GET /api/timesheets/me — my timesheets
exports.getMyTimesheets = async (req, res, next) => {
  try {
    const timesheets = await Timesheet.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .limit(20);
    res.json({ success: true, data: timesheets });
  } catch (err) {
    next(err);
  }
};

// GET /api/timesheets (admin) — all pending timesheets
exports.getAllTimesheets = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const timesheets = await Timesheet.find(filter)
      .populate('user', 'name email bankAccount hourlyRate')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    res.json({ success: true, data: timesheets });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/timesheets/:id/approve (admin)
exports.approveTimesheet = async (req, res, next) => {
  try {
    const ts = await Timesheet.findById(req.params.id).populate('user');
    if (!ts) return res.status(404).json({ success: false, message: 'Timesheet not found.' });

    ts.status = 'approved';
    ts.approvedBy = req.user._id;
    ts.approvedAt = new Date();
    ts.adminNotes = req.body.adminNotes || '';
    await ts.save();

    // Create payment record
    await Payment.create({
      user: ts.user._id,
      timesheet: ts._id,
      amount: ts.grossAmount,
      bankAccount: ts.user.bankAccount,
      periodStart: ts.periodStart,
      periodEnd: ts.periodEnd,
    });

    logger.info(`Timesheet ${ts._id} approved by admin ${req.user._id}`);
    res.json({ success: true, data: ts });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/timesheets/:id/reject (admin)
exports.rejectTimesheet = async (req, res, next) => {
  try {
    const ts = await Timesheet.findByIdAndUpdate(
      req.params.id,
      { status: 'rejected', adminNotes: req.body.adminNotes, approvedBy: req.user._id },
      { new: true }
    );
    if (!ts) return res.status(404).json({ success: false, message: 'Timesheet not found.' });
    res.json({ success: true, data: ts });
  } catch (err) {
    next(err);
  }
};
