const mongoose = require('mongoose');

const ratingSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  taskType: {
    type: String,
    enum: ['page_quality', 'needs_met', 'youtube', 'image', 'side_by_side'],
    required: true,
  },
  inputUrl: { type: String, required: true, trim: true },
  inputUrlB: { type: String, trim: true }, // For SxS
  query: { type: String, trim: true },     // For NM / YouTube / Image

  // Full AI evaluation result
  evaluation: {
    // Page Quality specific
    step1_scamDetector: {
      score: Number,
      link: String,
      startingRating: String,
    },
    step2_wikipedia: {
      link: String,
      summary: String,
      siteAge: String,
      updatedRating: String,
      isFinal: Boolean,
    },
    step3_pagePurpose: {
      purpose: String,
      achieved: String,
      reason: String,
      updatedRating: String,
    },
    step4_ads: {
      count: Number,
      exceptionApplied: Boolean,
      updatedRating: String,
    },
    step5_ymyl: {
      isYmyl: Boolean,
      contactInfo: String,
      exceptionApplied: Boolean,
      updatedRating: String,
    },
    step6_harmScam: {
      finding: String,
      link: String,
      reason: String,
      updatedRating: String,
      isFinal: Boolean,
    },
    step7_uniqueAuthority: {
      isUnique: Boolean,
      reason: String,
      finalRating: String,
    },
    // 15 Questions answers
    questions: {
      type: Map,
      of: String,
    },
    // Final rating
    finalRating: {
      type: String,
      enum: ['Lowest', 'Low', 'Medium', 'High', 'Highest', 'N/A'],
    },
    finalComment: String,
    // For other task types
    needsMetRating: String,
    youtubePQRating: String,
    imageSatisfaction: String,
    sxsPreference: String,
    rawResponse: String,
  },

  // Time taken in seconds
  timeTaken: { type: Number, default: 0 },

  // Status
  status: {
    type: String,
    enum: ['pending', 'completed', 'error'],
    default: 'pending',
  },
  errorMessage: { type: String },

}, { timestamps: true });

ratingSchema.index({ user: 1, createdAt: -1 });
ratingSchema.index({ taskType: 1 });

module.exports = mongoose.model('Rating', ratingSchema);
