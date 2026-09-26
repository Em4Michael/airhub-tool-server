const router = require('express').Router();
const { protect } = require('../middleware/auth');
const {
  evaluatePageQuality,
  evaluateNeedsMet,
  evaluateNeedsMetImage,
  evaluateYoutube,
  evaluateImage,
  evaluateImageFull,
  evaluateSxS,
  getMyRatings,
  getRatingById,
  evaluateYoutubeImage,
} = require('../controllers/rating.controller');

router.use(protect);

router.post('/evaluate/page-quality', evaluatePageQuality);
router.post('/evaluate/needs-met', evaluateNeedsMet);
router.post('/evaluate/needs-met-image', evaluateNeedsMetImage);
router.post('/evaluate/youtube', evaluateYoutube);
router.post('/evaluate/image', evaluateImage);
router.post('/evaluate/image-full', evaluateImageFull);
router.post('/evaluate/sxs', evaluateSxS);
router.post('/evaluate/youtube-image', evaluateYoutubeImage);


router.post('/sxs-summary', async (req, res, next) => {
  try {
    const { query, leftResults, rightResults, leftTotal, rightTotal, preference } = req.body;
    const openai = require('../config/openai');

    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'grok-3',
      messages: [
        {
          role: 'system',
          content: 'You are a search quality rater writing concise side-by-side evaluation summaries. Write exactly 3 sentences under 60 words total. Sentence 1: state what the user wants. Sentence 2: state which side is better and name the specific result(s) that caused the difference (e.g. L1, R2) and their rating. Sentence 3: state the reason — better score, diversity, SCRB advantage, or a specific result being FailsM or HM that shifted the balance.',
        },
        {
          role: 'user',
          content: `Query: "${query}"
User intent: ${req.body.dominantIntent || query}
Left side results: ${leftResults} — Total: ${leftTotal}pts
Right side results: ${rightResults} — Total: ${rightTotal}pts
Overall preference: ${preference}

Write exactly 3 sentences under 60 words: (1) what users want, (2) which side is better and which specific result(s) caused it with their rating, (3) the reason for the difference.`,
        },
      ],
      temperature: 0.3,
      max_tokens: 120,
    });

    const comment = response.choices[0].message.content.trim();
    res.json({ success: true, comment });
  } catch (err) {
    next(err);
  }
});

router.get('/', getMyRatings);
router.get('/:id', getRatingById);

module.exports = router;
