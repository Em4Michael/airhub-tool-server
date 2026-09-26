const openai = require('../config/openai');
const logger = require('../config/logger');
const axios = require('axios');

async function fetchWithStrategy(url, headers) {
  const res = await axios.get(url, {
    timeout: 15000,
    headers,
    maxContentLength: 1000000,
    validateStatus: () => true,
  });
  const rawText = String(res.data || '');
  const strippedText = rawText
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { statusCode: res.status, text: strippedText };
}

async function fetchGoogleSnippet(url) {
  try {
    const parsedUrl = new URL(url);
    // Search for the specific page and also the domain generally to get context
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(parsedUrl.hostname + ' ' + parsedUrl.pathname.replace(/\//g, ' '))}&num=5`;
    const res = await axios.get(searchUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      validateStatus: () => true,
      maxContentLength: 500000,
    });
    const raw = String(res.data || '');

    const isCaptcha = raw.toLowerCase().includes('captcha') ||
      raw.toLowerCase().includes('unusual traffic') ||
      raw.toLowerCase().includes('verify you are human');

    if (isCaptcha) {
      logger.warn(`Google snippet also returned CAPTCHA for: ${url}`);
      return null;
    }

    const text = raw
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 5000);
    return text.length > 200 ? text : null;
  } catch {
    return null;
  }
}

async function fetchGoogleCache(url) {
  try {
    const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
    const res = await axios.get(cacheUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
      validateStatus: () => true,
      maxContentLength: 500000,
    });
    const text = String(res.data || '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 15000);
    return text.length > 500 ? text : null;
  } catch {
    return null;
  }
}

async function fetchPageHTML(url) {
  const STRATEGIES = [
    // Strategy 1: standard Chrome browser headers
    {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Cache-Control': 'max-age=0',
    },
    // Strategy 2: Googlebot — some sites allow crawlers when they block browsers
    {
      'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    // Strategy 3: simple curl-like request — some WAFs allow simple agents
    {
      'User-Agent': 'curl/7.88.1',
      'Accept': '*/*',
    },
  ];

  let statusCode = null;

  for (const headers of STRATEGIES) {
    try {
      const { statusCode: code, text } = await fetchWithStrategy(url, headers);
      statusCode = code;

      const isBlocked = text.toLowerCase().includes('cloudflare') ||
        text.toLowerCase().includes('access denied') ||
        text.toLowerCase().includes('403 forbidden') ||
        text.toLowerCase().includes('please enable javascript') ||
        text.toLowerCase().includes('checking your browser') ||
        text.toLowerCase().includes('ddos protection') ||
        text.toLowerCase().includes('ray id');

      const isShell = text.length < 500;

      if (!isShell && !isBlocked) {
        logger.info(`Page fetched successfully with strategy for: ${url} (${text.length} chars)`);
        return { statusCode, html: text.slice(0, 15000), jsRendered: false };
      }

      logger.warn(`Strategy failed for ${url}: blocked=${isBlocked}, shell=${isShell}`);
    } catch (err) {
      logger.warn(`Fetch strategy failed for ${url}: ${err.message}`);
    }
  }

  // All direct strategies failed — try Google Cache
  logger.info(`Trying Google Cache for: ${url}`);
  const cached = await fetchGoogleCache(url);
  if (cached) {
    const isCaptcha = cached.toLowerCase().includes('captcha') ||
      cached.toLowerCase().includes('recaptcha') ||
      cached.toLowerCase().includes('i am not a robot') ||
      cached.toLowerCase().includes('verify you are human') ||
      cached.toLowerCase().includes('unusual traffic') ||
      cached.toLowerCase().includes('before you continue') ||
      cached.toLowerCase().includes('please verify');

    if (!isCaptcha) {
      logger.info(`Google Cache succeeded for: ${url}`);
      return { statusCode, html: cached, jsRendered: false, source: 'google_cache' };
    }
    logger.warn(`Google Cache returned CAPTCHA for: ${url}, trying next fallback`);
  }

  // Try Google search snippets as last resort
  logger.info(`Trying Google search snippets for: ${url}`);
  const snippet = await fetchGoogleSnippet(url);
  if (snippet) {
    logger.info(`Google snippet succeeded for: ${url}`);
    return { statusCode, html: `[Content sourced from Google search snippets — direct fetch was blocked]\n\n${snippet}`, jsRendered: false, source: 'google_snippet' };
  }

  // Everything failed — signal AI to use its own knowledge
  logger.warn(`All fetch strategies failed for: ${url}`);
  return { statusCode, html: null, jsRendered: true, allFailed: true };
}

const {
  PAGE_QUALITY_SYSTEM_PROMPT,
  NEEDS_MET_SYSTEM_PROMPT,
  YOUTUBE_SYSTEM_PROMPT,
  IMAGE_SYSTEM_PROMPT,
  SXS_SYSTEM_PROMPT,
  buildPageQualityUserMessage,
  buildNeedsMetUserMessage,
  buildYoutubeUserMessage,
  buildImageUserMessage,
  buildSxSUserMessage,
} = require('./promptBuilder');

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

/**
 * Generic OpenAI completion call
 */
async function callOpenAI(systemPrompt, userMessage) {
  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.2, // Low temp for consistent, structured ratings
    max_tokens: 3000,
    response_format: { type: 'json_object' },
  });

  const content = response.choices[0].message.content;
  logger.debug('OpenAI raw response received', { tokens: response.usage });

  try {
    return JSON.parse(content);
  } catch (e) {
    logger.error('Failed to parse OpenAI response as JSON', { content });
    throw new Error('AI returned invalid JSON. Please try again.');
  }
}

/**
 * Call xAI Responses API with web search enabled
 * This is separate from callOpenAI because it uses /v1/responses not /v1/chat/completions
 */
async function callGrokWithSearch(systemPrompt, userContent) {
  const isGrok = MODEL.toLowerCase().includes('grok');
  if (!isGrok) {
    // Fall back to standard call for non-Grok models
    const msg = typeof userContent === 'string' ? userContent : userContent.find(p => p.type === 'text')?.text || '';
    return callOpenAI(systemPrompt, msg);
  }

  const axios = require('axios');
  const apiKey = process.env.OPENAI_API_KEY;

  // Build input array for Responses API
  const input = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  const body = {
    model: MODEL,
    input,
    tools: [{ type: 'web_search' }],
    temperature: 0.2,
    max_output_tokens: 3000,
    text: { format: { type: 'json_object' } },
  };

  try {
    const response = await axios.post('https://api.x.ai/v1/responses', body, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 120000,
    });

    // Extract text from Responses API output
    const output = response.data?.output || [];
    let text = '';
    for (const item of output) {
      if (item.type === 'message') {
        for (const part of item.content || []) {
          if (part.type === 'output_text') text += part.text;
        }
      }
    }

    if (!text) throw new Error('No text in Responses API output');

    return JSON.parse(text);
  } catch (err) {
    logger.warn(`Grok Responses API failed, falling back to Chat Completions: ${err.message}`);
    const msg = typeof userContent === 'string' ? userContent : userContent.find(p => p.type === 'text')?.text || '';
    return callOpenAI(systemPrompt, msg);
  }
}

/**
 * Evaluate page quality (7-step process)
 */
async function evaluatePageQuality(url) {
  logger.info(`Evaluating page quality for: ${url}`);

  // Content creator platform URLs get the creator-specific page quality evaluator
  if (isContentCreatorUrl(url)) {
    logger.info(`Page Quality: Content creator URL detected (${new URL(url).hostname}), routing through creator PQ pipeline`);
    const creatorMeta = await fetchCreatorMetadata(url);
    const result = await getCreatorPageQuality(url, creatorMeta);

    // Result already matches standard page quality format — return directly
    return {
      steps: result.steps || null,
      questions: result.questions || null,
      finalRating: result.finalRating || 'N/A',
      finalComment: result.finalComment || 'Content creator page evaluated using platform-specific quality framework.',
    };
  }

  // YouTube URLs get the YouTube-specific page quality evaluator
  if (isYoutubeUrl(url)) {
    logger.info(`Page Quality: YouTube URL detected, routing through YouTube PQ pipeline`);
const isCommunityPost = isYoutubeCommunityPostUrl(url);
const metadata = isCommunityPost
  ? await fetchYoutubeCommunityPostMetadata(url)
  : await fetchYoutubeMetadata(url);
const pq = isCommunityPost
  ? await (async () => {
      const creatorMeta = await fetchCreatorMetadata(url);
      const result = await getCreatorPageQuality(url, creatorMeta);
      return { rating: result.finalRating || 'N/A', steps: result.steps || null };
    })()
  : await getYoutubePageQualityForUrl(url, metadata);

    // Convert YouTube PQ result to standard page quality format
    return {
      steps: {
        step1: pq.steps?.step1 ? {
          score: null,
          link: null,
          startingRating: pq.steps.step1.startingRating,
          finding: pq.steps.step1.finding,
        } : null,
        step2: pq.steps?.step2 ? {
          link: null,
          summary: pq.steps.step2.finding,
          siteAge: metadata?.uploadDate || 'N/A',
          updatedRating: pq.steps.step2.updatedRating,
          isFinal: pq.steps.step2.isFinal || false,
        } : null,
        step3: pq.steps?.step3 ? {
          purpose: `Video titled: ${metadata?.title || 'N/A'}`,
          achieved: pq.steps.step3.titleMatches ? 'Yes' : 'No',
          mcVolume: pq.steps.step3.mcVolume || 'N/A',
          mcVolumeReason: pq.steps.step3.reason || 'N/A',
          mediaCheck: metadata?.isUnavailable ? 'Video is unavailable or restricted' : 'Video appears available',
          reason: pq.steps.step3.reason || 'N/A',
          updatedRating: pq.steps.step3.updatedRating,
        } : null,
        step4: pq.steps?.step4 ? {
          count: pq.steps.step4.adCount || 0,
          exceptionApplied: false,
          updatedRating: pq.steps.step4.updatedRating,
        } : null,
        step5: pq.steps?.step5 ? {
          isYmyl: pq.steps.step5.isYmyl || false,
          eatCheck: pq.steps.step5.eatCheck || 'N/A',
          eatReason: pq.steps.step5.eatReason || 'N/A',
          contactInfo: 'N/A',
          exceptionApplied: false,
          updatedRating: pq.steps.step5.updatedRating,
        } : null,
        step6: pq.steps?.step6 ? {
          finding: pq.steps.step6.finding || 'N/A',
          link: null,
          reason: pq.steps.step6.finding || 'N/A',
          updatedRating: pq.steps.step6.updatedRating,
          isFinal: pq.steps.step6.isFinal || false,
        } : null,
        step7: pq.steps?.step7 ? {
          isUnique: pq.steps.step7.isUnique || false,
          reason: pq.steps.step7.reason || 'N/A',
          finalRating: pq.steps.step7.finalRating,
        } : null,
      },
      questions: {
        q1: `Video: ${metadata?.title || 'N/A'} by channel: ${metadata?.channelName || 'N/A'}`,
        q2: pq.steps?.step2?.finding || 'N/A',
        q3: metadata?.uploadDate || 'N/A',
        q4: pq.steps?.step3?.titleMatches ? 'Yes — title matches content' : 'No — title does not match content',
        q5: pq.steps?.step6?.finding || 'No credible reports found',
        q6: pq.steps?.step7?.isUnique ? 'Yes — ' + (pq.steps.step7.reason || '') : 'No — ' + (pq.steps?.step7?.reason || ''),
        q7: pq.steps?.step6?.finding || 'No harmful or deceptive content found',
        q8: 'No',
        q9: pq.steps?.step5?.isYmyl ? 'Yes — ' + (pq.steps.step5.eatReason || '') : 'No',
        q10: pq.finalRating || 'N/A',
        q11: pq.steps?.step3?.titleMatches ? 'Yes — title matches' : 'No — title mismatch',
        q12: 'Yes — primary content is video',
        q13: `youtube.com/watch?v=${metadata?.videoId || 'N/A'}`,
        q14: 'No — YouTube is not a government site',
        q15: pq.finalComment || 'YouTube video evaluated using channel-specific quality framework.',
      },
      finalRating: pq.rating || 'N/A',
      finalComment: pq.finalComment || 'YouTube video quality evaluated using channel-specific framework.',
    };
  }

  // Standard web page quality evaluation
  const { statusCode, html } = await fetchPageHTML(url);
  const userMessage = buildPageQualityUserMessage(url, html, statusCode);
  return callOpenAI(PAGE_QUALITY_SYSTEM_PROMPT, userMessage);
}

/**
 * Evaluate needs met rating
 */
// Cache to store query analysis so the same query is only analysed once per batch
const queryAnalysisCache = new Map();

async function analyseQueryOnce(query) {
  if (queryAnalysisCache.has(query)) {
    return queryAnalysisCache.get(query);
  }

  // Run a lightweight call just to analyse the query with no URL
  const analysisPrompt = `Analyse this search query alone — do not evaluate any result URL.

Query: "${query}"

Research every word and phrase in the query independently. Then return ONLY a valid JSON object with:
{
  "queryType": "<specific|website_search|dual_intent|broad_single|broad_multiple|visit_in_person>",
  "dominantIntent": "<what most users want when typing this exact query>",
  "conditions": "<list each independent condition in the query separated by commas>"
}

Do not include anything else. No result URL is provided — base your analysis entirely on the query.`;

  const response = await callOpenAI(NEEDS_MET_SYSTEM_PROMPT, analysisPrompt);
  queryAnalysisCache.set(query, response);
  // Clear cache after 10 minutes to avoid stale data
  setTimeout(() => queryAnalysisCache.delete(query), 10 * 60 * 1000);
  return response;
}

// Pending promise map — prevents multiple simultaneous calls for the same query
const queryAnalysisPending = new Map();

async function analyseQueryOnceSafe(query) {
  // If already cached, return immediately
  if (queryAnalysisCache.has(query)) {
    return queryAnalysisCache.get(query);
  }
  // If a request is already in flight for this query, wait for it
  if (queryAnalysisPending.has(query)) {
    return queryAnalysisPending.get(query);
  }
  // Start the analysis and store the promise so parallel calls wait for it
  const promise = analyseQueryOnce(query);
  queryAnalysisPending.set(query, promise);
  try {
    const result = await promise;
    queryAnalysisPending.delete(query);
    return result;
  } catch (err) {
    queryAnalysisPending.delete(query);
    throw err;
  }
}

function isYoutubeUrl(url) {
  try {
    const hostname = new URL(url).hostname.replace('www.', '');
    return hostname === 'youtube.com' || hostname === 'youtu.be';
  } catch {
    return false;
  }
}

function isYoutubeCommunityPostUrl(url) {
  try {
    const u = new URL(url);
    const hostname = u.hostname.replace('www.', '');
    return hostname === 'youtube.com' && u.pathname.includes('/post/');
  } catch {
    return false;
  }
}

function isContentCreatorUrl(url) {
  try {
    const hostname = new URL(url).hostname.replace('www.', '');
    const CONTENT_CREATOR_PLATFORMS = [
      'tiktok.com',
      'instagram.com',
      'facebook.com',
      'fb.com',
      'twitter.com',
      'x.com',
      'linkedin.com',
      'twitch.tv',
      'vimeo.com',
      'dailymotion.com',
      'rumble.com',
      'bitchute.com',
      'odysee.com',
      'lbry.tv',
      'pinterest.com',
      'snapchat.com',
      'threads.net',
      'tumblr.com',
      'medium.com',
      'substack.com',
    ];
    return CONTENT_CREATOR_PLATFORMS.some((platform) => hostname === platform || hostname.endsWith('.' + platform));
  } catch {
    return false;
  }
}

function parseCreatorUrlStructure(url) {
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.replace('www.', '');
    const pathname = parsedUrl.pathname;
    const segments = pathname.split('/').filter(Boolean);

    // Extract meaningful parts from the URL structure itself
    // Different platforms have different URL patterns
    let accountName = null;
    let contentId = null;
    let contentType = null;
    let section = null;

    // TikTok: /@username/video/123456
    if (hostname === 'tiktok.com') {
      const userSegment = segments.find((s) => s.startsWith('@'));
      accountName = userSegment ? userSegment.replace('@', '') : segments[0] || null;
      const videoIndex = segments.indexOf('video');
      contentId = videoIndex !== -1 ? segments[videoIndex + 1] : null;
      contentType = contentId ? 'video' : 'profile';
    }
    // Instagram: /username/ or /p/postid/ or /reel/reelid/
    else if (hostname === 'instagram.com') {
      if (segments[0] === 'p') { contentType = 'post'; contentId = segments[1]; }
      else if (segments[0] === 'reel') { contentType = 'reel'; contentId = segments[1]; }
      else if (segments[0] === 'stories') { contentType = 'story'; accountName = segments[1]; }
      else { accountName = segments[0]; contentType = segments[1] || 'profile'; }
    }
    // Twitter/X: /username/status/tweetid
    else if (hostname === 'twitter.com' || hostname === 'x.com') {
      accountName = segments[0];
      if (segments[1] === 'status') { contentType = 'tweet'; contentId = segments[2]; }
      else { contentType = segments[1] || 'profile'; }
    }
    // Facebook: /pagename/ or /pagename/posts/postid
    else if (hostname === 'facebook.com' || hostname === 'fb.com') {
      accountName = segments[0];
      contentType = segments[1] || 'page';
      contentId = segments[2] || null;
    }
    // LinkedIn: /in/username/ or /company/name/ or /posts/
    else if (hostname === 'linkedin.com') {
      contentType = segments[0];
      accountName = segments[1] || null;
      contentId = segments[2] || null;
    }
    // Twitch: /channelname
    else if (hostname === 'twitch.tv') {
      accountName = segments[0];
      contentType = segments[1] || 'channel';
    }
    // Vimeo: /videoId or /username/videoId
    else if (hostname === 'vimeo.com') {
      if (/^\d+$/.test(segments[0])) { contentType = 'video'; contentId = segments[0]; }
      else { accountName = segments[0]; contentType = 'profile'; contentId = segments[1] || null; }
    }
    // Rumble: /v/videoid or /c/channelname
    else if (hostname === 'rumble.com') {
      contentType = segments[0];
      accountName = segments[1] || null;
    }
    // YouTube community post: /post/postId or /channel/UCxxxx/community
else if (hostname === 'youtube.com') {
  contentType = 'community_post';
  const postMatch = pathname.match(/\/post\/([a-zA-Z0-9_-]+)/);
  contentId = postMatch ? postMatch[1] : null;
  const channelMatch = pathname.match(/\/channel\/([a-zA-Z0-9_-]+)/);
  accountName = channelMatch ? channelMatch[1] : null;
}
    // Generic fallback
    else {
      accountName = segments[0] || null;
      contentType = segments[1] || 'page';
      section = segments[2] || null;
    }

    return {
      hostname,
      pathname,
      segments,
      accountName,
      contentId,
      contentType,
      section,
    };
  } catch {
    return {
      hostname: 'unknown',
      pathname: '/',
      segments: [],
      accountName: null,
      contentId: null,
      contentType: 'page',
      section: null,
    };
  }
}

async function fetchCreatorMetadata(url) {
  const parsedStruct = parseCreatorUrlStructure(url);
  const { hostname, pathname, accountName, contentId, contentType } = parsedStruct;

  // Base metadata from URL structure — always available even if fetch fails
  const baseMeta = {
    platform: hostname,
    pathname,
    url,
    accountName,
    contentId,
    contentType,
    pageTitle: 'Not available',
    description: 'Not available',
    siteName: hostname,
    rawHtmlLength: 0,
    fetchedContent: null,
    fetchBlocked: false,
    urlStructure: parsedStruct,
  };

  try {
    // Try to fetch with all strategies
    const { html } = await fetchPageHTML(url);

    if (!html || html.length < 200) {
      logger.warn(`Creator page fetch returned empty/blocked content for: ${url}`);
      return { ...baseMeta, fetchBlocked: true };
    }

    // Extract Open Graph and meta tags
    const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1] ||
      html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:title"/i)?.[1] || null;
    const ogDescription = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)?.[1] ||
      html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:description"/i)?.[1] || null;
    const ogSiteName = html.match(/<meta[^>]+property="og:site_name"[^>]+content="([^"]+)"/i)?.[1] ||
      html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:site_name"/i)?.[1] || null;
    const pageTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || null;
    const twitterTitle = html.match(/<meta[^>]+name="twitter:title"[^>]+content="([^"]+)"/i)?.[1] || null;
    const twitterDesc = html.match(/<meta[^>]+name="twitter:description"[^>]+content="([^"]+)"/i)?.[1] || null;

    const resolvedTitle = pageTitle || ogTitle || twitterTitle || 'Not available';
    const resolvedDesc = ogDescription || twitterDesc || 'Not available';

    // Check if what we got is just a generic platform page rather than actual content
    const isGenericPage = resolvedTitle.toLowerCase() === hostname.split('.')[0] ||
      resolvedTitle.toLowerCase().includes('log in') ||
      resolvedTitle.toLowerCase().includes('sign in') ||
      resolvedTitle.toLowerCase().includes('create account') ||
      resolvedDesc.toLowerCase().includes('log in') ||
      html.toLowerCase().includes('please enable javascript');

    if (isGenericPage) {
      logger.warn(`Creator page returned generic/login page for: ${url}`);
      return { ...baseMeta, fetchBlocked: true };
    }

    return {
      ...baseMeta,
      pageTitle: resolvedTitle,
      description: resolvedDesc,
      siteName: ogSiteName || hostname,
      rawHtmlLength: html.length,
      fetchedContent: html.slice(0, 3000),
      fetchBlocked: false,
    };
  } catch (err) {
    logger.warn(`Could not fetch creator metadata for ${url}: ${err.message}`);
    return { ...baseMeta, fetchBlocked: true };
  }
}

async function getCreatorPageQuality(url, creatorMeta) {
  const { PAGE_QUALITY_SYSTEM_PROMPT } = require('./promptBuilder');

  const urlStructureInfo = `
URL STRUCTURE ANALYSIS:
- Platform: ${creatorMeta.platform}
- Account/Creator name from URL: ${creatorMeta.accountName || 'not identifiable from URL'}
- Content type from URL: ${creatorMeta.contentType || 'unknown'}
- Content ID from URL: ${creatorMeta.contentId || 'none'}
- Full URL: ${url}
`;

  const contentInfo = creatorMeta.fetchBlocked
    ? `
CONTENT FETCH STATUS: The page could not be fetched — this platform blocks automated access (common for TikTok, Instagram, and similar platforms). This is normal and does not indicate low quality.

IMPORTANT INSTRUCTIONS FOR BLOCKED PAGES:
1. A blocked server-side fetch means the platform actively prevents automated access — this is standard behaviour for TikTok, Instagram, and similar platforms. The page works perfectly in a browser. This is NOT a quality signal.
2. Use your training knowledge about the account name "${creatorMeta.accountName || 'unknown'}" on ${creatorMeta.platform} — what do you know about this creator or brand? What content do they make? What is their reputation?
3. The URL structure tells you exactly what type of content this is (profile, video, reel, post, etc.)
4. Evaluate based on what you know about this account — reputation, content category, follower size if known, any notable facts
5. NEVER reduce any step's rating solely because the page was blocked server-side. The fetch block has zero bearing on page quality.
6. If you have no specific knowledge of this account, treat it as a standard creator page for an unknown individual on that platform — rate based on what a typical creator page on this platform would score
7. Step 3 in particular must NOT be reduced for blocked content — assume the content achieves its purpose unless you have specific evidence otherwise`
    : `
FETCHED CONTENT:
Title: ${creatorMeta.pageTitle}
Description: ${creatorMeta.description}
${creatorMeta.fetchedContent ? `\nPage content snippet:\n${creatorMeta.fetchedContent}` : ''}
`;

  const prompt = `You are a social media and content creator page quality evaluator. Evaluate the quality of this content creator page using the 7-step framework adapted for social media and content creator platforms.

${urlStructureInfo}
${contentInfo}

You are evaluating a page on ${creatorMeta.platform}. The standard web page quality steps apply but adapted for content creator platforms:

STEP 1 — Platform and Creator Reputation (replaces Scam Detector):
Research the creator or account at this URL. Who is the account owner? Is this an official brand, a known creator, a public figure, or an unknown account?
- Official verified brand or institution → High starting rating
- Known reputable creator or public figure → High starting rating  
- Unknown or unverified individual account → Medium starting rating
- Account known for misinformation or harmful content → Low starting rating

STEP 2 — Wikipedia/External Reputation Check:
Search for the creator, brand, or account owner. Is this person or organisation positively covered by credible external sources? Apply the same rules as standard Step 2.
- Government/official institutional account → Highest (final)
- Positively covered, 6+ years established → High
- No external coverage, 10+ years established → maintain High
- Known for harmful content → Lowest (final)

STEP 3 — Content Purpose and Quality:
What is the purpose of this page or post? Use whatever information is available — fetched content, URL structure, account name, or your training knowledge about this specific account and content.

CRITICAL: If the page was blocked by the platform, this is NOT a quality issue with the page itself — it is a technical access limitation on the server side. The page works fine in a browser. You must NOT reduce the rating in Step 3 simply because content could not be fetched server-side.

When content cannot be fetched:
- Use your training knowledge about the account name and platform to determine what type of content this creator makes
- Research the specific account if you know it — what is their content about, what is their reputation?
- If the account is unknown to you, assume it is a standard creator page of the content type shown in the URL
- Never reduce the rating in Step 3 solely because of a server-side fetch block
- Only reduce if you have actual evidence the content is thin, mismatched, or low quality

When content IS available:
- Clear beneficial purpose with substantive content → maintain rating
- Thin, vague, or unclear content → reduce by 1
- Title or description does not match actual content → reduce by 2

STEP 4 — Ads and Distractions:
Are there excessive promotional or distracting elements? Apply same rules as standard Step 4.

STEP 5 — YMYL Assessment:
Does this content cover health, finance, safety, or other high-stakes topics?
- Health/medical advice from unqualified creator → reduce by 1
- Financial/legal advice from unqualified creator → reduce by 1
- Qualified expert or institutional source → no reduction
- Entertainment/lifestyle content → not YMYL, no reduction

STEP 6 — Harmful or Deceptive Content:
Research whether this account or content is known for spreading misinformation, hate speech, or harmful content.
- Confirmed harmful or deceptive content → Lowest (final)
- No credible harmful content found → maintain rating

STEP 7 — Unique Authority:
Does this creator or account OWN the content they are posting about?
- Official brand posting about their own products or services they created or manufacture → unique authority
- Government or institutional account posting their own official information → unique authority
- Individual creator posting general content, reviews, commentary, or topics they do not own → NOT unique authority

CRITICAL: Highest is ONLY possible when unique authority is confirmed. A site or account with high reputation, large following, or long history but no unique authority has a maximum rating of High, not Highest. Unique authority + High rating after all steps → upgrade to Highest. Any other situation → maximum is High.

Apply:
- Unique authority + High → Highest
- Unique authority + Medium → High
- No unique authority → maximum rating is High, never Highest

Return ONLY a valid JSON object:
{
  "steps": {
    "step1": { "finding": "<creator/account reputation finding>", "startingRating": "<rating>" },
    "step2": { "finding": "<external reputation finding>", "updatedRating": "<rating>", "isFinal": <bool> },
    "step3": { "purpose": "<what this page/post is about>", "achieved": "<Yes|No|Sometimes>", "mcVolume": "<High|Low>", "mcVolumeReason": "<reason>", "mediaCheck": "<content availability>", "reason": "<reason>", "updatedRating": "<rating>" },
    "step4": { "count": <number>, "exceptionApplied": <bool>, "updatedRating": "<rating>" },
    "step5": { "isYmyl": <bool>, "eatCheck": "<High|Low>", "eatReason": "<reason>", "contactInfo": "N/A", "exceptionApplied": <bool>, "updatedRating": "<rating>" },
    "step6": { "finding": "<harmful/deceptive finding>", "link": null, "reason": "<reason>", "updatedRating": "<rating>", "isFinal": <bool> },
    "step7": { "isUnique": <bool>, "reason": "<reason>", "finalRating": "<rating>" }
  },
  "questions": {
    "q1": "<page/post purpose>",
    "q2": "<external reputation finding>",
    "q3": "<account/creator age or establishment date>",
    "q4": "<Yes|No|Sometimes — did content achieve purpose>",
    "q5": "<Yes|No — credible scam or harm reports>",
    "q6": "<Yes|No — unique authority>",
    "q7": "<Yes|No|Sometimes — harmful, deceptive, or spammy>",
    "q8": "<Yes|No — money without value>",
    "q9": "<Yes|No — YMYL>",
    "q10": "<Lowest|Low|Medium|High|Highest — MC quality>",
    "q11": "<Yes|No — title matches content>",
    "q12": "<Yes|No — rich media MC>",
    "q13": "<domain URL>",
    "q14": "<Yes|No — government site>",
    "q15": "<30 words on purpose, 30 words on rating reasons. End with: Final Rating: [rating]>"
  },
  "finalRating": "<Lowest|Low|Medium|High|Highest|N/A>",
  "finalComment": "<short reason for final rating>"
}`;

  try {
    const result = await callOpenAI(PAGE_QUALITY_SYSTEM_PROMPT, prompt);
    return result;
  } catch (err) {
    logger.warn(`Creator PQ evaluation failed for ${url}: ${err.message}`);
    return { finalRating: 'N/A', steps: null, questions: null, finalComment: 'Could not evaluate' };
  }
}

async function evaluateNeedsMet(query, url) {
  logger.info(`Evaluating needs met: query="${query}" url="${url}"`);

  // If the URL is a YouTube link, route through the full YouTube evaluation pipeline
  // which fetches real metadata, verifies claims, and checks flags properly
  if (isYoutubeUrl(url)) {
    logger.info(`Needs Met: YouTube URL detected, routing through YouTube evaluation pipeline`);
    const queryAnalysis = await analyseQueryOnceSafe(query);
    const metadata = await fetchYoutubeMetadata(url);
    const pq = await getYoutubePageQualityForUrl(url, metadata);

const metadataText = isCommunityPost
  ? (metadata?.fetchBlocked
      ? `
COMMUNITY POST: This URL is a YouTube Community Post (text/image post), not a video, at ${url}.
The post content could not be fetched server-side — this is a technical/JS-rendering limitation,
NOT evidence the post is unavailable or removed. Do NOT check "Didn't Load" for this reason alone.
Only mark Didn't Load / FailsM if you have actual specific evidence of removal or breakage (e.g.
a "post not found" or "this content isn't available" message). Otherwise evaluate using the
channel identity (from the URL) and general knowledge of that channel to judge relevance.
Treat "Video Available", subscriber-based page-quality calibration, and any other video-only
fields as not applicable to this content type.
`
      : `
COMMUNITY POST CONTENT EXTRACTED:
- Title/Text: ${metadata.title}
- Description: ${metadata.description}
- Channel Name: ${metadata.channelName || 'Not available'}
- Channel ID/Handle: ${metadata.channelId || 'Not available'}

This is a YouTube Community Post (text/image post), not a video. Use this content as the
primary source of truth about what this post says. Judge relevance to the query based on
this text.

CRITICAL — creatorReputation: Do NOT default to "Not able to assess" simply because this
is a post rather than a video. A channel name or handle IS available above — search for it,
read its about page, look through its typical thumbnails/titles, and check for reviews,
news coverage, or expert commentary on that channel, exactly as instructed in the
reputation research step. Only use "Not able to assess" if the channel name itself is
genuinely unresolvable (i.e. "Not available" above) or your research turns up nothing at
all — not merely because this content type is a post.

Treat "Video Available", subscriber-based page-quality calibration, and any other
video-only fields as not applicable to this content type.
`)
  : (metadata ? `
VIDEO METADATA EXTRACTED FROM YOUTUBE:
- Title: ${metadata.title}
- Channel: ${metadata.channelName} (${metadata.channelUrl})
- Description: ${metadata.description}
- Views: ${metadata.viewCount}
- Likes: ${metadata.likeCount}
- Subscribers: ${metadata.subscriberCount}
- Upload Date: ${metadata.uploadDate}
- Category: ${metadata.category}
- Tags: ${metadata.tags}
- Video Available: ${metadata.isUnavailable ? 'NO — video is unavailable or restricted' : 'YES'}

Use this metadata as the primary source of truth about what this video contains. The title, description, tags and channel name tell you exactly what the video is about. Judge relevance to the query based on this metadata.
` : `
VIDEO METADATA: Could not be fetched server-side — this is a technical limitation (bot
protection, JS rendering, rate limiting), NOT evidence the video didn't load or is unavailable.
Do NOT check "Didn't Load" for this reason alone. Use your own knowledge of this specific
YouTube URL, channel, and title (if inferable from the URL) to evaluate. Only mark Didn't Load
if you have specific evidence of removal or breakage.
`);

    const queryContext = queryAnalysis ? `
QUERY ALREADY ANALYSED — USE THESE VALUES EXACTLY. Do not change these.
QueryType: ${queryAnalysis.queryType}
DominantIntent: ${queryAnalysis.dominantIntent}
Conditions: ${queryAnalysis.conditions || 'N/A'}

IMPORTANT: Never return "youtube" as the queryType. Use the queryType value above exactly.
` : `Analyse the query: "${query}" — classify as one of: specific, website_search, dual_intent, broad_single, broad_multiple, visit_in_person. Never use "youtube" as queryType.`;

    const pqContext = `
PAGE QUALITY — already computed using the YouTube-specific 7-step evaluation. DO NOT re-evaluate. DO NOT change the final rating.
Step 1 Channel Reputation: ${pq.steps?.step1 ? JSON.stringify(pq.steps.step1) : 'N/A'}
Step 2 Wikipedia/Reputation: ${pq.steps?.step2 ? JSON.stringify(pq.steps.step2) : 'N/A'}
Step 3 Title Match & MC Volume: ${pq.steps?.step3 ? JSON.stringify(pq.steps.step3) : 'N/A'}
Step 4 Ads: ${pq.steps?.step4 ? JSON.stringify(pq.steps.step4) : 'N/A'}
Step 5 YMYL: ${pq.steps?.step5 ? JSON.stringify(pq.steps.step5) : 'N/A'}
Step 6 Harmful/Deceptive: ${pq.steps?.step6 ? JSON.stringify(pq.steps.step6) : 'N/A'}
Step 7 Unique Authority: ${pq.steps?.step7 ? JSON.stringify(pq.steps.step7) : 'N/A'}
FINAL PAGE QUALITY RATING: ${pq.rating}
The pageQuality field in your JSON output MUST be exactly "${pq.rating}".`;

    const userMessage = `Rate this YouTube video result for the given search query using the full Needs Met framework.

${queryContext}

Result URL: ${url}
${metadataText}

${pqContext}

EVALUATION INSTRUCTIONS — FOLLOW IN THIS EXACT ORDER:

STEP 1 — RESEARCH THE VIDEO INDEPENDENTLY
Search for the video title and channel name to find what this video is actually about. Determine who the channel owner is, their reputation, and what type of content they produce.

STEP 2 — VERIFY ALL CLAIMS
For every claim in the title or description, verify against independent credible sources:
- Is the claim supported by credible independent news sources or expert consensus?
- Is it sensational or presented as fact without evidence?
- Does the channel have a known reputation for producing unverified or misleading content?
- Does the title match the actual content described?

Key signals to check:
- Sensational claims on important topics with no verified sourcing
- Unsubstantiated fraud, crime, or conspiracy claims presented as established fact
- Claims contradicting what major credible outlets report on the same topic
- Title using alarming language not supported by the actual content

STEP 3 — CHECK RELEVANCE
Does this video match the query's dominantIntent? Quote specific words from the title or description. If the topic is completely different → FailsM.

STEP 4 — APPLY CONTENT FLAGS WITH EVIDENCE
- isDeceptive: true if claims are unverified, contradict credible sources, or are sensationally overstated on an important topic without evidence
- isHarmful: true if content promotes harm, dangerous advice, or dangerous practices
- isPorn: true if sexual content is present
- isHateSpeech: true if content targets protected groups with prejudice or incitement
- isGraphicViolent: true if graphic violence without legitimate purpose
- Every flag MUST include a specific reason in flagReasons: (a) what claim was made, (b) what research found, (c) why this triggers the flag
- If no flags → flagReasons is empty array, explain why content is safe in reasoning

STEP 5 — NEEDS MET RATING
Apply standard Needs Met rating rules using the queryType and dominantIntent provided. A YouTube video is judged the same as any web result for relevance to the query.

STEP 6 — OUTPUT
Return valid JSON in the standard Needs Met output format including contentFlags:
{
  "queryType": "<use exact value from query analysis above>",
  "queryAnalysis": "<how you interpreted the query>",
  "rating": "<FullyM|HM+|HM|MM+|MM|SM|FailsM>",
  "points": <5|4.5|4|3.5|3|2|1>,
  "pageQuality": "${pq.rating}",
  "pageQualityReason": "<short reason>",
  "contentFlags": {
    "isHarmful": <bool>,
    "isDeceptive": <bool>,
    "isPorn": <bool>,
    "isHateSpeech": <bool>,
    "isGraphicViolent": <bool>,
    "flagReasons": ["<reason for each flag>"]
  },
  "reasoning": "<detailed explanation citing metadata evidence>",
  "dominantIntent": "<what most users want>",
  "isStale": <bool>,
  "comment": "<30-word summary>"
}`;

    const result = await callGrokWithSearch(NEEDS_MET_SYSTEM_PROMPT, userMessage);
    if (queryAnalysis) {
      if (!result.queryType || result.queryType === 'youtube') {
        result.queryType = queryAnalysis.queryType;
      }
      if (!result.dominantIntent) {
        result.dominantIntent = queryAnalysis.dominantIntent;
      }
    }
    return result;
  }

  // Non-YouTube URL — standard needs met pipeline
  const queryAnalysis = await analyseQueryOnceSafe(query);
  const [pq, { html: pageHTML }] = await Promise.all([
    require('./promptBuilder').getPageQualityForUrl(url),
    fetchPageHTML(url),
  ]);
  const userMessage = buildNeedsMetUserMessage(query, url, pq, queryAnalysis, pageHTML);
  return callOpenAI(NEEDS_MET_SYSTEM_PROMPT, userMessage);
}

/**
 * Evaluate YouTube content
 */
async function fetchYoutubeMetadata(url) {
  try {
    // Extract video ID from various YouTube URL formats
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    ];
    let videoId = null;
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) { videoId = match[1]; break; }
    }

    if (!videoId) return null;

    // Fetch oEmbed data — no API key needed
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const oembedRes = await axios.get(oembedUrl, { timeout: 8000, validateStatus: () => true });

    if (oembedRes.status !== 200) return null;

    const oembed = oembedRes.data;

    // Also fetch the video page to get description and tags
    const pageRes = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      validateStatus: () => true,
    });

    const pageText = String(pageRes.data || '');

    // Extract description from page source
    const descMatch = pageText.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
    const description = descMatch ? descMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').slice(0, 1000) : 'Not available';

    // Extract view count
    const viewMatch = pageText.match(/"viewCount":"(\d+)"/);
    const viewCount = viewMatch ? parseInt(viewMatch[1]).toLocaleString() : 'Not available';

    // Extract like count if available
    const likeMatch = pageText.match(/"label":"([\d,]+) likes"/);
    const likeCount = likeMatch ? likeMatch[1] : 'Not available';

    // Extract subscriber count
    const subMatch = pageText.match(/"subscriberCountText":\{"simpleText":"([^"]+)"/);
    const subscriberCount = subMatch ? subMatch[1] : 'Not available';

    // Extract upload date
    const dateMatch = pageText.match(/"uploadDate":"([^"]+)"/);
    const uploadDate = dateMatch ? dateMatch[1] : 'Not available';

    // Extract category
    const catMatch = pageText.match(/"category":"([^"]+)"/);
    const category = catMatch ? catMatch[1] : 'Not available';

    // Extract tags
    const tagsMatch = pageText.match(/"keywords":\[([^\]]+)\]/);
    const tags = tagsMatch ? tagsMatch[1].replace(/"/g, '').split(',').slice(0, 10).join(', ') : 'Not available';

    // Check if video is available
    const isUnavailable = pageText.includes('"playabilityStatus":{"status":"ERROR"') ||
      pageText.includes('"playabilityStatus":{"status":"LOGIN_REQUIRED"') ||
      pageText.includes('"playabilityStatus":{"status":"UNPLAYABLE"');

    return {
      videoId,
      title: oembed.title || 'Not available',
      channelName: oembed.author_name || 'Not available',
      channelUrl: oembed.author_url || 'Not available',
      description,
      viewCount,
      likeCount,
      subscriberCount,
      uploadDate,
      category,
      tags,
      isUnavailable,
      thumbnailUrl: oembed.thumbnail_url || null,
    };
  } catch (err) {
    logger.warn(`Could not fetch YouTube metadata for ${url}: ${err.message}`);
    return null;
  }
}

async function fetchYoutubeOgTags(url) {
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      validateStatus: () => true,
      maxContentLength: 2000000,
    });
    const raw = String(res.data || '');
    if (!raw) return null;

    const ogTitle = raw.match(/property="og:title"[^>]*content="([^"]+)"/i)?.[1] || null;
    const ogDescription = raw.match(/property="og:description"[^>]*content="([^"]+)"/i)?.[1] || null;
    // YouTube embeds channel identity in ytInitialData / canonical link even on blocked-looking pages
    const canonicalMatch = raw.match(/<link rel="canonical" href="([^"]+)"/i)?.[1] || null;
    const channelUrlMatch = raw.match(/"channelUrlCanonical":"([^"]+)"/i)?.[1]
      || raw.match(/"externalChannelId":"([^"]+)"/i)?.[1]
      || raw.match(/href="(\/(?:channel\/[a-zA-Z0-9_-]+|@[a-zA-Z0-9_.-]+))"/i)?.[1]
      || null;
    const channelNameMatch = raw.match(/"author":"([^"]+)"/i)?.[1]
      || ogTitle?.match(/^(.+?)\s*[-–]\s*Community post/i)?.[1]
      || null;

    return {
      ogTitle,
      ogDescription,
      channelIdentifier: channelUrlMatch,
      channelName: channelNameMatch,
      canonical: canonicalMatch,
      rawLength: raw.length,
    };
  } catch (err) {
    logger.warn(`fetchYoutubeOgTags failed for ${url}: ${err.message}`);
    return null;
  }
}

async function fetchYoutubeCommunityPostMetadata(url) {
  // Try the lightweight, YouTube-specific tag extraction first — this often succeeds
  // even when the generic fetchPageHTML bot-check would call it "blocked"
  const ogData = await fetchYoutubeOgTags(url);

  if (ogData && (ogData.ogTitle || ogData.channelName || ogData.channelIdentifier)) {
    return {
      isCommunityPost: true,
      fetchBlocked: false,
      title: ogData.ogTitle || 'Not available',
      description: ogData.ogDescription || 'Not available',
      channelId: ogData.channelIdentifier || null,
      channelName: ogData.channelName || 'Not available',
      rawContent: null,
    };
  }

  // Fall back to the generic fetcher as a last resort
  try {
    const { html } = await fetchPageHTML(url);
    if (!html || html.length < 200) {
      return { isCommunityPost: true, fetchBlocked: true, url };
    }
    const ogTitle = html.match(/property="og:title"[^>]*content="([^"]+)"/i)?.[1] || null;
    const ogDescription = html.match(/property="og:description"[^>]*content="([^"]+)"/i)?.[1] || null;
    const channelMatch = url.match(/\/channel\/([a-zA-Z0-9_-]+)/);
    return {
      isCommunityPost: true,
      fetchBlocked: false,
      title: ogTitle || 'Not available',
      description: ogDescription || 'Not available',
      channelId: channelMatch ? channelMatch[1] : null,
      channelName: 'Not available',
      rawContent: html.slice(0, 3000),
    };
  } catch {
    return { isCommunityPost: true, fetchBlocked: true, url };
  }
}

async function getYoutubePageQualityForUrl(url, metadata) {
  if (!metadata) return { rating: 'N/A', steps: null };

  const { PAGE_QUALITY_SYSTEM_PROMPT } = require('./promptBuilder');

  const prompt = `You are a YouTube page quality evaluator. Evaluate the quality of this YouTube video and channel using the 7-step framework adapted for YouTube content.

VIDEO METADATA:
- Title: ${metadata.title}
- Channel: ${metadata.channelName} (${metadata.channelUrl})
- Description: ${metadata.description}
- Views: ${metadata.viewCount}
- Likes: ${metadata.likeCount}
- Subscribers: ${metadata.subscriberCount}
- Upload Date: ${metadata.uploadDate}
- Category: ${metadata.category}
- Tags: ${metadata.tags}
- Video Available: ${metadata.isUnavailable ? 'NO — unavailable or restricted' : 'YES'}

Apply the 7-step YouTube page quality framework:

STEP 1 — Channel Reputation: Research the channel. Is it a known reputable channel, an official brand/institution, or unknown? Starting rating: High for reputable known channels, Medium for unknown channels, Low for channels with known credibility issues.

STEP 2 — Wikipedia/Reputation Check: Is the channel owner known and positively covered? Government/official institutional channels → Highest. Well-known reputable channels → High. Known for misinformation → Lowest (final).

STEP 3 — Title vs Content Match and MC Volume: Does the video title accurately describe the content based on the description and tags?
- Title matches AND video is substantive → maintain rating
- Title does NOT match content → reduce by 2, minimum Low
- Video is unavailable → reduce by 2
- Very short or thin content → reduce by 1

STEP 4 — Ads: 5 or more intrusive mid-roll ads → reduce by 1

STEP 5 — YMYL: Health/medical advice from unqualified creator → reduce by 1. Financial/legal advice from unqualified creator → reduce by 1. Qualified expert or institutional source → no reduction.

STEP 6 — Harmful or Deceptive Content: Confirmed harmful or deceptive content → Lowest (final). No credible harmful content → maintain rating.

STEP 7 — Unique Authority: Official brand/government/institutional channel posting about their own content → unique authority. Content creator posting general content they do not own → NOT unique authority. Unique authority + High → Highest; + Medium → High.

SUBSCRIBER CALIBRATION (apply after all steps):
- Unique authority + 500k+ → Highest
- Unique authority + 50k-499k → High
- Title matches + 10k-49k → High
- Title matches + 5k-9k → Medium
- Title matches + 1k-4k → Medium
- Title does NOT match → Low minimum
- Harmful or misleading → Lowest

Return ONLY a valid JSON object:
{
  "steps": {
    "step1": { "finding": "<channel reputation finding>", "startingRating": "<rating>" },
    "step2": { "finding": "<wikipedia/reputation finding>", "updatedRating": "<rating>", "isFinal": <bool> },
    "step3": { "titleMatches": <bool>, "reason": "<why title matches or not>", "mcVolume": "<High|Low>", "updatedRating": "<rating>" },
    "step4": { "adCount": <number>, "updatedRating": "<rating>" },
    "step5": { "isYmyl": <bool>, "eatCheck": "<High|Low>", "eatReason": "<reason>", "updatedRating": "<rating>" },
    "step6": { "finding": "<harmful/deceptive finding>", "updatedRating": "<rating>", "isFinal": <bool> },
    "step7": { "isUnique": <bool>, "reason": "<reason>", "finalRating": "<rating>" }
  },
  "finalRating": "<Lowest|Low|Medium|High|Highest|N/A>",
  "finalComment": "<short reason for final rating>"
}`;

  try {
    const result = await callGrokWithSearch(PAGE_QUALITY_SYSTEM_PROMPT, prompt);
    return {
      rating: result.finalRating || 'N/A',
      steps: result.steps || null,
    };
  } catch (err) {
    logger.warn(`YouTube PQ evaluation failed for ${url}: ${err.message}`);
    return { rating: 'N/A', steps: null };
  }
}

async function evaluateYoutube(query, url) {
  logger.info(`Evaluating youtube: query="${query}" url="${url}"`);

  const isCommunityPost = isYoutubeCommunityPostUrl(url); // from last turn's fix
  const [queryAnalysis, metadata] = await Promise.all([
    analyseQueryOnceSafe(query),
    isCommunityPost ? fetchYoutubeCommunityPostMetadata(url) : fetchYoutubeMetadata(url),
  ]);
const pq = isCommunityPost
  ? await (async () => {
      const creatorMeta = await fetchCreatorMetadata(url);
      const result = await getCreatorPageQuality(url, creatorMeta);
      return { rating: result.finalRating || 'N/A', steps: result.steps || null };
    })()
  : await getYoutubePageQualityForUrl(url, metadata);

  const metadataText = isCommunityPost
    ? (metadata?.fetchBlocked
        ? `
COMMUNITY POST: This URL is a YouTube Community Post (text/image post), not a video, at ${url}.
No channel/creator name or post text could be extracted server-side — this is a technical
limitation, NOT evidence the post is unavailable or removed. Do NOT check "Didn't Load" for
this reason alone.

If any part of the URL, prior conversation context, or an attached image reveals the
channel or creator identity, use your own knowledge of that channel to assess reputation.
Only set creatorReputation to "Not able to assess" as an absolute last resort when no
channel or creator identity is available from any source whatsoever.
`
        : `
COMMUNITY POST CONTENT EXTRACTED:
- Title/Text: ${metadata.title}
- Description: ${metadata.description}
- Channel/Creator Name: ${metadata.channelName || 'Not available'}
- Channel ID/Handle: ${metadata.channelId || 'Not available'}

This is a YouTube Community Post (text/image post), not a video. The account posting this
could be an individual content creator, a brand, a media outlet, an institution, or any other
type of channel — do not assume it is a personal creator by default. Use this content as the
primary source of truth about what this post says. Judge relevance to the query based on
this text.

CRITICAL — creatorReputation: A channel/creator name is available above — search for it,
read its about page if accessible, look through its typical thumbnails/titles, and check for
reviews, news coverage, or expert commentary on that channel, exactly as instructed in the
reputation research step. Only use "Not able to assess" if the channel name itself is
genuinely unresolvable (i.e. "Not available" above) or your research turns up nothing at all
— not merely because this content type is a post.

Treat "Video Available", subscriber-based page-quality calibration, and any other
video-only fields as not applicable to this content type.
`)
    : (metadata ? `
VIDEO METADATA EXTRACTED FROM YOUTUBE:
- Title: ${metadata.title}
- Channel: ${metadata.channelName} (${metadata.channelUrl})
- Description: ${metadata.description}
- Views: ${metadata.viewCount}
- Likes: ${metadata.likeCount}
- Subscribers: ${metadata.subscriberCount}
- Upload Date: ${metadata.uploadDate}
- Category: ${metadata.category}
- Tags: ${metadata.tags}
- Video Available: ${metadata.isUnavailable ? 'NO — video is unavailable or restricted' : 'YES'}

Use this metadata as the primary source of truth about what this video contains. The title, description, tags and channel name tell you exactly what the video is about. Judge relevance to the query based on this metadata.
` : `
VIDEO METADATA: Could not be fetched server-side — this is a technical limitation (bot
protection, JS rendering, rate limiting), NOT evidence the video didn't load or is unavailable.
Do NOT check "Didn't Load" for this reason alone. Use your own knowledge of this specific
YouTube URL, channel, and title (if inferable from the URL) to evaluate. Only mark Didn't Load
if you have specific evidence of removal or breakage.
`);

  const queryContext = queryAnalysis ? `
QUERY ALREADY ANALYSED — USE THESE VALUES EXACTLY. Do not change these.
QueryType: ${queryAnalysis.queryType}
DominantIntent: ${queryAnalysis.dominantIntent}
Conditions: ${queryAnalysis.conditions || 'N/A'}

IMPORTANT: The queryType above is the search query classification (broad_single, broad_multiple, specific, website_search, dual_intent, visit_in_person). It is NOT "youtube". Never return "youtube" as the queryType in your JSON output. Use the queryType value above exactly.
` : `
Analyse the query first: "${query}"
Classify the queryType as one of: specific, website_search, dual_intent, broad_single, broad_multiple, visit_in_person.
Never use "youtube" as a queryType.
`;

  const pqContext = `
PAGE QUALITY — already computed using YouTube-specific 7-step evaluation. DO NOT re-evaluate. DO NOT change.
Step 1 Channel Reputation: ${pq.steps?.step1 ? JSON.stringify(pq.steps.step1) : 'N/A'}
Step 2 Wikipedia/Reputation: ${pq.steps?.step2 ? JSON.stringify(pq.steps.step2) : 'N/A'}
Step 3 Title Match & MC: ${pq.steps?.step3 ? JSON.stringify(pq.steps.step3) : 'N/A'}
Step 4 Ads: ${pq.steps?.step4 ? JSON.stringify(pq.steps.step4) : 'N/A'}
Step 5 YMYL: ${pq.steps?.step5 ? JSON.stringify(pq.steps.step5) : 'N/A'}
Step 6 Harmful/Deceptive: ${pq.steps?.step6 ? JSON.stringify(pq.steps.step6) : 'N/A'}
Step 7 Unique Authority: ${pq.steps?.step7 ? JSON.stringify(pq.steps.step7) : 'N/A'}
FINAL PAGE QUALITY RATING: ${pq.rating}
The pageQualityRating field in your JSON output MUST be exactly "${pq.rating}".`;

  const userMessage = `Evaluate this YouTube video for the given search query.

${queryContext}

Video URL: ${url}
${metadataText}

${pqContext}

EVALUATION INSTRUCTIONS — FOLLOW IN THIS EXACT ORDER:

STEP 1 — RESEARCH THE VIDEO CONTENT INDEPENDENTLY
Before evaluating anything else, research this specific video and channel:
- Search for the video title and channel name to find what this video is actually about
- Find out who the channel owner is, what their reputation is, and what type of content they produce
- Read the full description and tags provided above carefully
- Determine the actual topic and claims being made

STEP 2 — VERIFY ALL CLAIMS
For every claim made in the title or description, verify it against independent credible sources:
- What exactly is being claimed?
- Is this claim supported by credible, independent news sources or expert consensus?
- Is this claim sensational, unverified, or presented as fact without evidence?
- Does the framing suggest this is breaking news when credible sources do not corroborate it?
- Is there a mismatch between what the title/thumbnail promises and what the video actually delivers?

Key signals of deceptive content to check:
- Sensational "BREAKING" or "EXCLUSIVE" claims on important topics with no verified sourcing
- Unsubstantiated fraud, crime, or conspiracy claims presented as established fact
- Claims that contradict what major credible news outlets report on the same topic
- Channel known for producing sensational, misleading, or unverified content
- Title uses alarming language that is not supported by the actual described content
- Content about trafficking, crime, health, elections, or science making unverified claims

STEP 3 — CLASSIFY THE QUERY CORRECTLY
Use the query analysis provided. The queryType must be one of: specific, website_search, dual_intent, broad_single, broad_multiple, visit_in_person. Never return "youtube" as the queryType — that is not a valid classification.

STEP 4 — CHECK RELEVANCE
Does this video match the query intent? Quote specific words from the title or description. If the topic is completely different from the query → FailsM.

STEP 5 — APPLY FLAGS WITH EVIDENCE
Based on your research in Steps 1 and 2:
- isDeceptive: true if your research found the claims are unverified, contradict credible sources, or are sensationally overstated on an important topic without evidence
- isHarmful: true if content promotes harm, dangerous advice, or dangerous practices
- isPorn: true if sexual content is present
- isHateSpeech: true if content targets protected groups with prejudice or incitement
- isGraphicViolent: true if graphic violence is shown without legitimate purpose
- Every flag MUST include a specific reason in flagReasons stating: (a) what claim was made, (b) what your research found, (c) why this triggers the flag
- If no flags apply, flagReasons must be an empty array and explain in the reasoning why the content is safe

STEP 6 — NEEDS MET RATING
Apply YouTube Needs Met rules. Rate based on how well this video satisfies the query intent.

STEP 7 — PAGE QUALITY
Apply full 7-step page quality evaluation. A channel known for producing unverified sensational content has Low E-E-A-T and should be rated accordingly.

STEP 8 — OUTPUT
Return valid JSON. queryType must be a valid classification from Step 3, never "youtube". dominantIntent must describe what users searching this query want.`;

  const result = await callGrokWithSearch(YOUTUBE_SYSTEM_PROMPT, userMessage);
  // Ensure queryType and dominantIntent are always present from query analysis
  if (queryAnalysis) {
    if (!result.queryType || result.queryType === 'youtube') {
      result.queryType = queryAnalysis.queryType;
    }
    if (!result.dominantIntent) {
      result.dominantIntent = queryAnalysis.dominantIntent;
    }
  }
  return result;
}

/**
 * Evaluate image search result
 */
async function evaluateImage(query, imageUrl) {
  logger.info(`Evaluating image: query="${query}" url="${imageUrl}"`);
  const queryAnalysis = query ? await analyseQueryOnceSafe(query) : null;
  const { html: pageHTML } = await fetchPageHTML(imageUrl);

  const queryContext = queryAnalysis ? `
QUERY ALREADY ANALYSED — USE THESE VALUES EXACTLY:
QueryType: ${queryAnalysis.queryType}
DominantIntent: ${queryAnalysis.dominantIntent}
Conditions: ${queryAnalysis.conditions || 'N/A'}
` : query ? `Query: "${query}" — research and classify this query before evaluating.` : `No text query provided — evaluate based on the image and landing page only.`;

  let pageContext = '';
  if (pageHTML) {
    const ogImage = pageHTML.match(/og:image[^>]*content="([^"]+)"/i)?.[1] ||
      pageHTML.match(/content="([^"]+)"[^>]*og:image/i)?.[1] || null;
    const pageTitle = pageHTML.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || null;
    const metaDesc = pageHTML.match(/meta[^>]*name="description"[^>]*content="([^"]+)"/i)?.[1] ||
      pageHTML.match(/meta[^>]*content="([^"]+)"[^>]*name="description"/i)?.[1] || null;
    const imageCount = (pageHTML.match(/<img /gi) || []).length;
    const urlLower = (imageUrl || '').toLowerCase();
    const isProductPage = urlLower.includes('/product') || urlLower.includes('/item') ||
      urlLower.includes('/p/') || urlLower.includes('/dp/') ||
      pageHTML.toLowerCase().includes('add to cart') ||
      pageHTML.toLowerCase().includes('buy now') ||
      pageHTML.toLowerCase().includes('in stock') ||
      pageHTML.toLowerCase().includes('price');
    const isListingPage = urlLower.includes('/search') || urlLower.includes('/category') ||
      urlLower.includes('/collection') || imageCount > 20;
    const isArticlePage = urlLower.includes('/article') || urlLower.includes('/blog') ||
      urlLower.includes('/news') || urlLower.includes('/review') || urlLower.includes('/test');

    pageContext = `LANDING PAGE CONTENT:\n"""\n${pageHTML.slice(0, 5000)}\n"""

PAGE STRUCTURAL SIGNALS:
- Page title: ${pageTitle || 'not found'}
- Meta description: ${metaDesc || 'not found'}
- Open Graph image: ${ogImage || 'none'}
- Image count on page: ${imageCount}
- Product page signals: ${isProductPage ? 'YES' : 'NO'}
- Listing page signals: ${isListingPage ? 'YES' : 'NO'}
- Article/review page signals: ${isArticlePage ? 'YES' : 'NO'}

Use these signals to determine prominence and helpfulness. Product pages → Main Feature or Easy to Find. Article pages → Easy to Find. Listing pages → Hard to Find. No connection → Missing.`;
  } else {
    const urlLower = (imageUrl || '').toLowerCase();
    pageContext = `Landing page could not be fetched for ${imageUrl}.
URL signals — product: ${urlLower.includes('/product') || urlLower.includes('/dp/') || urlLower.includes('/item') ? 'YES' : 'NO'}, article: ${urlLower.includes('/blog') || urlLower.includes('/review') || urlLower.includes('/news') ? 'YES' : 'NO'}, listing: ${urlLower.includes('/search') || urlLower.includes('/category') ? 'YES' : 'NO'}.
Use URL structure and your knowledge of this domain to estimate prominence. Do not assume Missing without evidence.`;
  }

  const userMessage = `Evaluate this image search result.

${queryContext}

Image/Landing Page URL: ${imageUrl}

${pageContext}

EVALUATION STEPS:
1. Understand the user task or journey behind the query
2. Rate the IMAGE SATISFACTION based only on the image itself — not the landing page
3. Rate IMAGE PROMINENCE — how easily the image can be found on the landing page based on the extracted content
4. Rate LANDING PAGE HELPFULNESS — is it helpful for the user task AND for users interested in the image?
5. Rate LANDING PAGE PAGE QUALITY using the 7-step framework
6. Apply Needs Met rating using the query type and dominant intent
7. Apply all content and image flags
8. Return valid JSON in the exact output format specified

AUTOMATIC RULES:
- If imageSatisfaction is FailsS → lpHelpfulness must be UH automatically
- If imageProminence is Missing → lpHelpfulness must be UH automatically
- Image satisfaction is based ONLY on the image, not the landing page`;

  const result = await callOpenAI(IMAGE_SYSTEM_PROMPT, userMessage);
  if (queryAnalysis) {
    if (!result.queryType) result.queryType = queryAnalysis.queryType;
    if (!result.dominantIntent) result.dominantIntent = queryAnalysis.dominantIntent;
  }
  // Map to needs met compatible format for card display
  result.rating = result.needsMetRating || result.rating;
  result.points = result.needsMetPoints || result.points;
  result.pageQuality = result.pageQuality;
  return result;
}

/**
 * Evaluate side-by-side comparison
 */
async function evaluateSxS(query, urlA, urlB) {
  logger.info(`Evaluating SxS: query="${query}"`);
  const userMessage = buildSxSUserMessage(query, urlA, urlB);
  return callOpenAI(SXS_SYSTEM_PROMPT, userMessage);
}

async function evaluateNeedsMetImage(query, url, imageBase64, imageType) {
  logger.info(`Evaluating needs met image SCRB: query="${query}"`);
  const queryAnalysis = await analyseQueryOnce(query);

  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: NEEDS_MET_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Rate this IMAGE SCRB (Special Content Result Block) for the given query.

Query: "${query}"
Landing Page URL (if any): ${url || 'none provided'}

QUERY ALREADY ANALYSED — USE THESE VALUES EXACTLY:
QueryType: ${queryAnalysis.queryType}
DominantIntent: ${queryAnalysis.dominantIntent}
Conditions: ${queryAnalysis.conditions}

The image above is the SCRB shown in the search results. Rate it based on:
1. How well the IMAGE itself satisfies the query intent
2. Whether the image content matches the conditions identified
3. Apply Needs Met rating rules for the query type

Return valid JSON with the standard needs met output format including rating, points, pageQuality, reasoning, dominantIntent, queryType, queryAnalysis, isStale, and comment.`,
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:${imageType};base64,${imageBase64}`,
            },
          },
        ],
      },
    ],
    temperature: 0.2,
    max_tokens: 1500,
    response_format: { type: 'json_object' },
  });

  const content = response.choices[0].message.content;
  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error('AI returned invalid JSON for image SCRB evaluation.');
  }
}

async function evaluateYoutubeImage(query, url, imageBase64, imageType) {
  logger.info(`Evaluating YouTube image SCRB: query="${query}" url="${url}"`);
  const queryAnalysis = query ? await analyseQueryOnceSafe(query) : null;

  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: YOUTUBE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Rate this IMAGE SCRB (Special Content Result Block) captured from a YouTube
result — this could be a thumbnail, a Community Post image, or a video frame.

Query: "${query || 'not provided'}"
Associated URL: ${url || 'none provided'}

${queryAnalysis ? `QUERY ALREADY ANALYSED — USE EXACTLY:\nQueryType: ${queryAnalysis.queryType}\nDominantIntent: ${queryAnalysis.dominantIntent}\nNever return "youtube" as queryType.` : `Analyse the query first, classify queryType, never return "youtube" as queryType.`}

Apply the full YouTube framework (content checklist, reputation, topics, satire, insensitive/
intolerant degree, public interest, deceptive degree, harmful degree, malicious intent,
Needs Met rating, and page quality) to what is visible in this image and any accompanying
URL/text context.

CRITICAL — CONSISTENCY BETWEEN FIELDS: If you identify a speaker, channel, publisher, or
account name anywhere in the image (a name badge, a watermark, a channel handle, a
publisher logo) or you name that entity anywhere in your own reasoning/comment, you have
NOT failed to assess reputation — you MUST research that identified name and channel and
report a real creatorReputation value (Very positive/Positive/Neutral/Mildly negative or
mixed/Negative), not "Not able to assess." "Not able to assess" is reserved ONLY for cases
where no speaker, channel, publisher, or account identity is visible or nameable at all —
never use it after you have already named an entity elsewhere in your output. Before
finalizing your JSON, check: does my comment or reasoning name anyone or any channel? If
yes, creatorReputation must reflect research on that name, not "Not able to assess."`,
          },
          {
            type: 'image_url',
            image_url: { url: `data:${imageType};base64,${imageBase64}` },
          },
        ],
      },
    ],
    temperature: 0.2,
    max_tokens: 2000,
    response_format: { type: 'json_object' },
  });

  const content = response.choices[0].message.content;
  let result;
  try {
    result = JSON.parse(content);
  } catch (e) {
    throw new Error('AI returned invalid JSON for YouTube image SCRB evaluation.');
  }

  if (queryAnalysis) {
    if (!result.queryType || result.queryType === 'youtube') result.queryType = queryAnalysis.queryType;
    if (!result.dominantIntent) result.dominantIntent = queryAnalysis.dominantIntent;
  }
  return result;
}

async function evaluateImageFull(query, url, queryImageBase64, queryImageMimeType, resultImageBase64, resultImageMimeType) {
  logger.info(`Evaluating image full: query="${query}" url="${url}"`);
  const queryAnalysis = query ? await analyseQueryOnceSafe(query) : null;
  const pageResult = url ? await fetchPageHTML(url) : { html: null, statusCode: null };
  const pageHTML = pageResult.html;
  const pageStatusCode = pageResult.statusCode;

  const queryContext = queryAnalysis
    ? `QUERY ALREADY ANALYSED:\nQueryType: ${queryAnalysis.queryType}\nDominantIntent: ${queryAnalysis.dominantIntent}\nConditions: ${queryAnalysis.conditions || 'N/A'}`
    : query
      ? `Text Query: "${query}" — classify and research before evaluating.`
      : `No text query — evaluate based on the query image and result image only.`;

  // Extract structural signals from the landing page to help infer image prominence
  let pageContext = '';
  let pageSignals = '';

  // Note whether the page was reachable — a blocked fetch does not mean the page is bad
  const fetchNote = !pageHTML && url
    ? `NOTE: The landing page could not be fetched server-side. This is common for sites using Cloudflare, JavaScript rendering, or bot protection. The page is likely accessible in a browser. Do NOT treat a failed fetch as evidence the page is low quality, the image is missing, or the landing page is unhelpful. Use the URL structure, domain knowledge, and any signals available to estimate prominence and helpfulness.\n\n`
    : '';

  if (pageHTML) {
    // Extract Open Graph image — this is the image the page itself declares as its main image
    const ogImage = pageHTML.match(/og:image[^>]*content="([^"]+)"/i)?.[1] ||
      pageHTML.match(/content="([^"]+)"[^>]*og:image/i)?.[1] || null;

    // Extract page title
    const pageTitle = pageHTML.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || null;

    // Extract meta description
    const metaDesc = pageHTML.match(/meta[^>]*name="description"[^>]*content="([^"]+)"/i)?.[1] ||
      pageHTML.match(/meta[^>]*content="([^"]+)"[^>]*name="description"/i)?.[1] || null;

    // Count images on the page — many images = gallery/listing, one dominant image = product page
    const imageCount = (pageHTML.match(/<img /gi) || []).length;

    // Detect page type from URL and content signals
    const urlLower = (url || '').toLowerCase();
    const isProductPage = urlLower.includes('/product') || urlLower.includes('/item') ||
      urlLower.includes('/p/') || urlLower.includes('/dp/') ||
      pageHTML.toLowerCase().includes('add to cart') ||
      pageHTML.toLowerCase().includes('add to bag') ||
      pageHTML.toLowerCase().includes('buy now') ||
      pageHTML.toLowerCase().includes('in stock') ||
      pageHTML.toLowerCase().includes('price');

    const isListingPage = urlLower.includes('/search') || urlLower.includes('/category') ||
      urlLower.includes('/collection') || urlLower.includes('/results') ||
      imageCount > 20;

    const isArticlePage = urlLower.includes('/article') || urlLower.includes('/blog') ||
      urlLower.includes('/news') || urlLower.includes('/post') ||
      urlLower.includes('/review') || urlLower.includes('/durability') ||
      urlLower.includes('/test');

    pageSignals = `
PAGE STRUCTURAL SIGNALS (use these to infer image prominence and helpfulness):
- Page title: ${pageTitle || 'not found'}
- Meta description: ${metaDesc || 'not found'}
- Open Graph image declared by page: ${ogImage || 'none declared'}
- Approximate image count on page: ${imageCount} images
- Page type signals:
  * Product/purchase page: ${isProductPage ? 'YES — page has purchase signals (add to cart, price, buy now, in stock)' : 'NO'}
  * Listing/category/search page: ${isListingPage ? 'YES — page has many images or listing URL pattern' : 'NO'}
  * Article/blog/review/test page: ${isArticlePage ? 'YES — page has article or review URL pattern' : 'NO'}

USE THESE SIGNALS TO DETERMINE PROMINENCE:
- Product page with matching Open Graph image or few images → Main Feature or Easy to Find
- Product page with non-matching Open Graph image → Easy to Find or Hard to Find
- Article/review page → Easy to Find (image is in the article content)
- Listing/category page with many images → Hard to Find
- Page with no connection to the result image subject → Missing

USE THESE SIGNALS TO DETERMINE HELPFULNESS:
- Product page: if page title or description matches the result image item → VH or MH (user can buy/learn about it)
- Article/review page: if the article covers the result image item → MH (informational but not a purchase page)
- Listing page: if user would need to search within the page to find the item → SH or UH
- Page with no connection → UH
`;

    pageContext = `${fetchNote}LANDING PAGE CONTENT:\n"""\n${pageHTML.slice(0, 5000)}\n"""\n${pageSignals}`;
  } else if (url) {
    const urlLower = url.toLowerCase();
    const hostname = (() => { try { return new URL(url).hostname.replace('www.', ''); } catch { return url; } })();
    const isLikelyProduct = urlLower.includes('/product') || urlLower.includes('/item') ||
      urlLower.includes('/p/') || urlLower.includes('/dp/') || urlLower.includes('/buy') ||
      urlLower.includes('/shop');
    const isLikelyArticle = urlLower.includes('/article') || urlLower.includes('/blog') ||
      urlLower.includes('/news') || urlLower.includes('/review') || urlLower.includes('/test') ||
      urlLower.includes('/post');
    const isLikelyListing = urlLower.includes('/search') || urlLower.includes('/category') ||
      urlLower.includes('/collection') || urlLower.includes('/results');

    pageContext = `${fetchNote}Landing page could not be fetched server-side for: ${url}

URL AND DOMAIN SIGNALS:
- Domain: ${hostname}
- Likely product page: ${isLikelyProduct ? 'YES' : 'NO'}
- Likely article/review page: ${isLikelyArticle ? 'YES' : 'NO'}
- Likely listing/search page: ${isLikelyListing ? 'YES' : 'NO'}

CRITICAL INSTRUCTIONS WHEN FETCH FAILED:
1. Use your knowledge of the domain "${hostname}" — is it a known retailer, review site, social platform, or news site?
2. Use the URL path to determine what type of page this is
3. If the domain is a known retailer or product site and the URL path suggests a product page → assume the result image is Main Feature or Easy to Find and the page is VH or MH
4. Do NOT assign Missing or UH simply because the page could not be fetched server-side
5. The page quality Lowest rating you may have received was also due to the fetch failure, not the actual page quality — correct for this`;
  } else {
    pageContext = `No landing page URL provided.`;
  }

  // Build content array for multimodal message
  const contentParts = [
    {
      type: 'text',
      text: `Evaluate this image search result following the Image Search Guidelines v2.2 and the AIRhub Needs Met framework.

${queryContext}

Landing Page URL: ${url || 'not provided'}

${pageContext}

${queryImageBase64 ? 'The FIRST image below is the QUERY IMAGE — this is what the user searched with.' : ''}
${resultImageBase64 ? `The ${queryImageBase64 ? 'SECOND' : 'FIRST'} image below is the RESULT IMAGE — this is the image shown in the search results.` : ''}

EVALUATION INSTRUCTIONS:
1. Understand the user task or journey from the text query and/or query image
2. IMAGE SATISFACTION: Rate how satisfying the RESULT IMAGE is for the query — based ONLY on the result image, not the landing page. Compare it to the query image if provided.
3. IMAGE PROMINENCE: Use the structural signals and URL signals provided above. If the page could not be fetched, use domain knowledge and URL structure. NEVER assign Missing just because the page was unreachable server-side.
4. LANDING PAGE HELPFULNESS: Use structural signals. If the page could not be fetched, use domain knowledge. NEVER assign UH just because the page was unreachable server-side unless the URL itself has no connection to the result image.
5. PAGE QUALITY: Rate the landing page. IMPORTANT — if the page could not be fetched server-side, this is a technical limitation not a quality signal. Use your knowledge of the domain to rate it. A well-known site that blocks bots is NOT low quality.
6. NEEDS MET RATING: How well does this result satisfy the query intent overall?
7. Apply all content flags and image flags
8. Return valid JSON in the exact output format specified

AUTOMATIC RULES:
- imageSatisfaction FailsS → lpHelpfulness must be UH
- imageProminence Missing → lpHelpfulness must be UH only if you have confirmed evidence the image is absent, not just because the fetch failed
- Image satisfaction is based ONLY on the result image appearance, not the landing page`,
    },
  ];

  if (queryImageBase64) {
    contentParts.push({
      type: 'image_url',
      image_url: { url: `data:${queryImageMimeType};base64,${queryImageBase64}` },
    });
  }

  if (resultImageBase64) {
    contentParts.push({
      type: 'image_url',
      image_url: { url: `data:${resultImageMimeType};base64,${resultImageBase64}` },
    });
  }

  const result = await callGrokWithSearch(IMAGE_SYSTEM_PROMPT, contentParts);

  if (queryAnalysis) {
    if (!result.queryType) result.queryType = queryAnalysis.queryType;
    if (!result.dominantIntent) result.dominantIntent = queryAnalysis.dominantIntent;
  }
  result.rating = result.needsMetRating || result.rating;
  result.points = result.needsMetPoints || result.points;
  return result;
}

module.exports = {
  evaluatePageQuality,
  evaluateNeedsMet,
  evaluateNeedsMetImage,
  evaluateYoutube,
  evaluateImage,
  evaluateImageFull,
  evaluateSxS,
  callOpenAI,
  fetchYoutubeMetadata,
  evaluateYoutubeImage,
};
