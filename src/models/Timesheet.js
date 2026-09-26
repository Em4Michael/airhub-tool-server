const mongoose = require('mongoose');

const timesheetSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  // Bi-week period: Sunday to Saturday
  periodStart: { type: Date, required: true }, // Sunday
  periodEnd: { type: Date, required: true },   // Saturday
  hoursWorked: {
    type: Number,
    required: [true, 'Hours worked is required'],
    min: [0, 'Hours cannot be negative'],
    max: [168, 'Hours cannot exceed 168 per week'],
  },
  ratingsCompleted: { type: Number, default: 0 },
  hourlyRate: { type: Number, required: true },
  grossAmount: { type: Number }, // hoursWorked * hourlyRate

  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'paid'],
    default: 'pending',
  },
  adminNotes: { type: String },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  approvedAt: { type: Date },
  paidAt: { type: Date },

  userNotes: { type: String },
}, { timestamps: true });

// Calculate gross before save
timesheetSchema.pre('save', function (next) {
  if (this.isModified('hoursWorked') || this.isModified('hourlyRate')) {
    this.grossAmount = parseFloat((this.hoursWorked * this.hourlyRate).toFixed(2));
  }
  next();
});

timesheetSchema.index({ user: 1, periodStart: -1 });
timesheetSchema.index({ status: 1 });

module.exports = mongoose.model('Timesheet', timesheetSchema);
