const Rating = require('../models/Rating');
const ratingService = require('../services/ratingService');
const logger = require('../config/logger');

/**
 * Generic evaluate handler
 */
const evaluate = (taskType, serviceFn, urlField = 'url') => async (req, res, next) => {
  const startTime = Date.now();
  let ratingDoc;

  try {
    const { url, urlB, query } = req.body;

    if (!url) {
      return res.status(400).json({ success: false, message: 'URL is required.' });
    }

    // Create pending rating document
    ratingDoc = await Rating.create({
      user: req.user._id,
      taskType,
      inputUrl: url,
      inputUrlB: urlB || undefined,
      query: query || undefined,
      status: 'pending',
    });

    // Call appropriate AI service
    let result;
    switch (taskType) {
      case 'page_quality':
        result = await ratingService.evaluatePageQuality(url);
        break;
      case 'needs_met':
        if (!query) return res.status(400).json({ success: false, message: 'Query is required for Needs Met.' });
        result = await ratingService.evaluateNeedsMet(query, url);
        break;
      case 'youtube':
        if (!query) return res.status(400).json({ success: false, message: 'Query is required for YouTube.' });
        result = await ratingService.evaluateYoutube(query, url);
        break;
      case 'image':
        if (!query) return res.status(400).json({ success: false, message: 'Query is required for Image.' });
        result = await ratingService.evaluateImage(query, url);
        break;
      case 'side_by_side':
        if (!query || !urlB) return res.status(400).json({ success: false, message: 'Query and second URL (urlB) required for SxS.' });
        result = await ratingService.evaluateSxS(query, url, urlB);
        break;
      default:
        return res.status(400).json({ success: false, message: 'Unknown task type.' });
    }

    // Map result fields to rating document
    const evaluation = {
      rawResponse: JSON.stringify(result),
    };

    if (taskType === 'page_quality') {
      evaluation.step1_scamDetector = result.steps?.step1;
      evaluation.step2_wikipedia = result.steps?.step2;
      evaluation.step3_pagePurpose = result.steps?.step3;
      evaluation.step4_ads = result.steps?.step4;
      evaluation.step5_ymyl = result.steps?.step5;
      evaluation.step6_harmScam = result.steps?.step6;
      evaluation.step7_uniqueAuthority = result.steps?.step7;
      evaluation.questions = result.questions;
      evaluation.finalRating = result.finalRating;
      evaluation.finalComment = result.finalComment;
    } else if (taskType === 'needs_met') {
      evaluation.needsMetRating = result.rating;
      evaluation.youtubePQRating = result.pageQuality;
      evaluation.finalComment = result.comment;
    } else if (taskType === 'youtube') {
      evaluation.needsMetRating = result.needsMetRating;
      evaluation.youtubePQRating = result.pageQualityRating;
      evaluation.finalComment = result.comment;
      evaluation.contentFlags = result.contentFlags || {
        isHarmful: false,
        isDeceptive: false,
        isPorn: false,
        isHateSpeech: false,
        isGraphicViolent: false,
        flagReasons: [],
      };
      // Merge queryType and dominantIntent into raw so the card can display them
      evaluation.rawResponse = JSON.stringify({
        ...result,
        queryType: result.queryType || queryAnalysis?.queryType || 'unknown',
        dominantIntent: result.dominantIntent || queryAnalysis?.dominantIntent || '',
        rating: result.needsMetRating,
        points: result.needsMetPoints,
        pageQuality: result.pageQualityRating,
      });
    } else if (taskType === 'image') {
      evaluation.imageSatisfaction = result.imageSatisfaction;
      evaluation.needsMetRating = result.needsMetRating || result.rating;
      evaluation.youtubePQRating = result.pageQuality || result.lpPageQuality;
      evaluation.finalComment = result.comment;
      evaluation.contentFlags = result.contentFlags || {
        isHarmful: false, isDeceptive: false, isPorn: false,
        isHateSpeech: false, isGraphicViolent: false, flagReasons: [],
      };
      evaluation.rawResponse = JSON.stringify(result);
    } else if (taskType === 'side_by_side') {
      evaluation.sxsPreference = result.preference;
      evaluation.finalComment = result.reasoning;
    }

    const timeTaken = Math.round((Date.now() - startTime) / 1000);

    await Rating.findByIdAndUpdate(ratingDoc._id, {
      evaluation,
      timeTaken,
      status: 'completed',
    });

    logger.info(`Rating completed: ${taskType} for user ${req.user._id} in ${timeTaken}s`);

    res.json({
      success: true,
      data: {
        id: ratingDoc._id,
        taskType,
        evaluation,
        timeTaken,
      },
    });
  } catch (err) {
    logger.error(`Rating error: ${err.message}`);
    if (ratingDoc) {
      await Rating.findByIdAndUpdate(ratingDoc._id, {
        status: 'error',
        errorMessage: err.message,
      });
    }
    next(err);
  }
};

exports.evaluatePageQuality = evaluate('page_quality');
exports.evaluateNeedsMet = evaluate('needs_met');

exports.evaluateNeedsMetImage = async (req, res, next) => {
  let ratingDoc;
  try {
    const { query, url, imageBase64, imageType } = req.body;
    if (!query || !imageBase64) {
      return res.status(400).json({ success: false, message: 'Query and image are required.' });
    }

    ratingDoc = await Rating.create({
      user: req.user._id,
      taskType: 'needs_met',
      inputUrl: url || 'image-scrb',
      query,
      status: 'pending',
    });

    const ratingService = require('../services/ratingService');
    const result = await ratingService.evaluateNeedsMetImage(query, url || '', imageBase64, imageType);

    const evaluation = {
      needsMetRating: result.rating,
      youtubePQRating: result.pageQuality,
      finalComment: result.comment,
      rawResponse: JSON.stringify(result),
    };

    await Rating.findByIdAndUpdate(ratingDoc._id, { evaluation, status: 'completed' });

    res.json({ success: true, data: { id: ratingDoc._id, taskType: 'needs_met', evaluation } });
  } catch (err) {
    if (ratingDoc) await Rating.findByIdAndUpdate(ratingDoc._id, { status: 'error', errorMessage: err.message });
    next(err);
  }
};
exports.evaluateYoutube = evaluate('youtube');
exports.evaluateImage = evaluate('image');

exports.evaluateImageFull = async (req, res, next) => {
  let ratingDoc;
  try {
    const { query, url, queryImageBase64, queryImageMimeType, resultImageBase64, resultImageMimeType } = req.body;

    ratingDoc = await Rating.create({
      user: req.user._id,
      taskType: 'image',
      inputUrl: url || 'image-result',
      query: query || 'image-query',
      status: 'pending',
    });

    const ratingService = require('../services/ratingService');
    const result = await ratingService.evaluateImageFull(
      query, url,
      queryImageBase64, queryImageMimeType,
      resultImageBase64, resultImageMimeType
    );

    const evaluation = {
      needsMetRating: result.needsMetRating || result.rating,
      imageSatisfaction: result.imageSatisfaction,
      youtubePQRating: result.pageQuality,
      finalComment: result.comment,
      contentFlags: result.contentFlags || {
        isHarmful: false, isDeceptive: false, isPorn: false,
        isHateSpeech: false, isGraphicViolent: false, flagReasons: [],
      },
      rawResponse: JSON.stringify(result),
    };

    await Rating.findByIdAndUpdate(ratingDoc._id, { evaluation, status: 'completed' });
    res.json({ success: true, data: { id: ratingDoc._id, taskType: 'image', evaluation } });
  } catch (err) {
    if (ratingDoc) await Rating.findByIdAndUpdate(ratingDoc._id, { status: 'error', errorMessage: err.message });
    next(err);
  }
};
exports.evaluateSxS = evaluate('side_by_side');

// GET /api/ratings — get current user's ratings
exports.getMyRatings = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, taskType } = req.query;
    const filter = { user: req.user._id };
    if (taskType) filter.taskType = taskType;

    const [ratings, total] = await Promise.all([
      Rating.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .select('-evaluation.rawResponse'),
      Rating.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: ratings,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/ratings/:id
exports.getRatingById = async (req, res, next) => {
  try {
    const rating = await Rating.findOne({ _id: req.params.id, user: req.user._id });
    if (!rating) return res.status(404).json({ success: false, message: 'Rating not found.' });
    res.json({ success: true, data: rating });
  } catch (err) {
    next(err);
  }
};
