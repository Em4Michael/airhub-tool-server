const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  timesheet: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Timesheet',
    required: true,
  },
  amount: { type: Number, required: true },
  status: {
    type: String,
    enum: ['pending', 'paid', 'denied'],
    default: 'pending',
  },
  paidBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  paidAt: { type: Date },
  deniedAt: { type: Date },
  denialReason: { type: String },
  bankAccount: { type: String },
  periodStart: { type: Date },
  periodEnd: { type: Date },
}, { timestamps: true });

paymentSchema.index({ user: 1, status: 1 });

module.exports = mongoose.model('Payment', paymentSchema);
