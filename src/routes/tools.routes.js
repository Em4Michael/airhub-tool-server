const router = require('express').Router();
const { protect } = require('../middleware/auth');
const openai = require('../config/openai');
const logger = require('../config/logger');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const MODEL = process.env.OPENAI_MODEL || 'grok-3';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.use(protect);

// ─── Helper: call Grok with optional web search ──────────────────────────────
async function callGrokJSON(systemPrompt, userContent, useWebSearch = true) {
  const isGrok = MODEL.toLowerCase().includes('grok');

  if (isGrok && useWebSearch) {
    try {
      const axios = require('axios');
      const body = {
        model: MODEL,
        input: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        tools: [{ type: 'web_search' }],
        temperature: 0.2,
        max_output_tokens: 4000,
        text: { format: { type: 'json_object' } },
      };
      const response = await axios.post('https://api.x.ai/v1/responses', body, {
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 120000,
      });
      const output = response.data?.output || [];
      let text = '';
      for (const item of output) {
        if (item.type === 'message') {
          for (const part of item.content || []) {
            if (part.type === 'output_text') text += part.text;
          }
        }
      }
      if (text) { logger.info('Grok Responses API succeeded'); return text; }
    } catch (err) {
      logger.warn(`Responses API failed, falling back: ${err.message}`);
    }
  }

  // Fallback: Chat Completions
  const messages = [{ role: 'system', content: systemPrompt }];
  if (typeof userContent === 'string') {
    messages.push({ role: 'user', content: userContent });
  } else {
    messages.push({ role: 'user', content: userContent });
  }
  const response = await openai.chat.completions.create({
    model: MODEL,
    messages,
    temperature: 0.2,
    max_tokens: 4000,
    response_format: { type: 'json_object' },
  });
  return response.choices[0].message.content;
}

// ─── POST /api/tools/annotate — text annotation ───────────────────────────────
router.post('/annotate', async (req, res, next) => {
  try {
    const { system_prompt, user_message } = req.body;
    if (!system_prompt || !user_message) {
      return res.status(400).json({ success: false, message: 'system_prompt and user_message are required' });
    }
    const text = await callGrokJSON(system_prompt, user_message, true);
    res.json({ success: true, text });
  } catch (err) {
    logger.error(`Annotate error: ${err.message}`);
    next(err);
  }
});

// ─── POST /api/tools/transcribe — audio transcription via Whisper ─────────────
router.post('/transcribe', upload.single('audio'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No audio file provided' });

    const { Readable } = require('stream');
    const audioStream = Readable.from(req.file.buffer);
    audioStream.path = 'recording.wav';

    logger.info(`Transcribing audio: ${req.file.size} bytes`);

    const transcription = await openai.audio.transcriptions.create({
      file: audioStream,
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });

    res.json({
      success: true,
      transcription: transcription.text || '',
      language: transcription.language || 'en',
      duration: transcription.duration || 0,
      segments: (transcription.segments || []).map(s => ({
        start: s.start,
        end: s.end,
        text: s.text,
      })),
    });
  } catch (err) {
    logger.error(`Transcribe error: ${err.message}`);
    // If Whisper not available on this model, return helpful error
    if (err.message?.includes('whisper') || err.message?.includes('audio')) {
      return res.status(422).json({ success: false, message: 'Audio transcription requires OpenAI API key with Whisper access. Using xAI key — transcription not supported. Paste transcript manually.' });
    }
    next(err);
  }
});

// ─── POST /api/tools/analyze-image — image analysis with vision ───────────────
router.post('/analyze-image', upload.fields([
  { name: 'leftImages', maxCount: 5 },
  { name: 'rightImages', maxCount: 5 },
]), async (req, res, next) => {
  try {
    const { query, system_prompt } = req.body;
    const leftFiles = req.files?.leftImages || [];
    const rightFiles = req.files?.rightImages || [];

    if (!leftFiles.length && !rightFiles.length) {
      return res.status(400).json({ success: false, message: 'No images provided' });
    }

    // Build multimodal content parts
    const contentParts = [];

    let promptText = `QUERY: ${query || 'No query provided'}\n\n`;

    if (leftFiles.length) {
      promptText += `LEFT SIDE: ${leftFiles.length} image(s)\n`;
    }
    if (rightFiles.length) {
      promptText += `RIGHT SIDE: ${rightFiles.length} image(s)\n`;
    }
    promptText += `\nRate each image for satisfaction, check near duplicates within each side, evaluate host pages, then determine OPR preference.`;

    contentParts.push({ type: 'text', text: promptText });

    // Add left images
    for (let i = 0; i < leftFiles.length; i++) {
      const f = leftFiles[i];
      const b64 = f.buffer.toString('base64');
      const mime = f.mimetype || 'image/jpeg';
      contentParts.push({ type: 'text', text: `[LEFT IMAGE L${i + 1}]` });
      contentParts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } });
    }

    // Add right images
    for (let i = 0; i < rightFiles.length; i++) {
      const f = rightFiles[i];
      const b64 = f.buffer.toString('base64');
      const mime = f.mimetype || 'image/jpeg';
      contentParts.push({ type: 'text', text: `[RIGHT IMAGE R${i + 1}]` });
      contentParts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } });
    }

    // Use chat completions for vision (multimodal)
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: system_prompt },
        { role: 'user', content: contentParts },
      ],
      temperature: 0.2,
      max_tokens: 3000,
      response_format: { type: 'json_object' },
    });

    const text = response.choices[0].message.content;
    res.json({ success: true, text });
  } catch (err) {
    logger.error(`Image analysis error: ${err.message}`);
    next(err);
  }
});

module.exports = router;