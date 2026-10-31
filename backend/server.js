
'use strict';

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.OLLAMA_API_KEY;
const OLLAMA_URL = (process.env.OLLAMA_BASE_URL || 'https://ollama.com')
  .replace(/\/+$/, '');

const ORIGINS = (
  process.env.FRONTEND_ORIGINS ||
  'https://kyami-ai.aimraneoubram.workers.dev,https://kyamingu.github.io'
)
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.disable('x-powered-by');
app.use(cors({
  origin(origin, callback) {
    if (!origin || ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origin not allowed'));
  }
}));

app.use(express.json({ limit: '40kb' }));

const chatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: Number(process.env.IP_REQUEST_LIMIT || 8),
  standardHeaders: 'draft-8',
  legacyHeaders: false
});

const globalLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.GLOBAL_HOURLY_LIMIT || 100),
  standardHeaders: 'draft-8',
  legacyHeaders: false
});

let modelCache = [];
let modelCacheTime = 0;

async function getGemmaModels() {
  if (!API_KEY) {
    throw new Error('OLLAMA_API_KEY is not configured');
  }

  if (Date.now() - modelCacheTime < 60_000 && modelCache.length) {
    return modelCache;
  }

  const response = await fetch(`${OLLAMA_URL}/api/tags`, {
    headers: {
      Authorization: `Bearer ${API_KEY}`
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`Ollama models request failed: ${response.status}`);
  }

  const data = await response.json();

  const models = (Array.isArray(data.models) ? data.models : [])
    .map(item => item.name || item.model)
    .filter(name => typeof name === 'string' && /^gemma/i.test(name));

  modelCache = [...new Set(models)];
  modelCacheTime = Date.now();

  return modelCache;
}

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    provider: 'Ollama Cloud',
    configured: Boolean(API_KEY)
  });
});

app.get('/api/models', async (_req, res) => {
  try {
    const models = await getGemmaModels();
    res.set('Cache-Control', 'no-store');
    res.json({ models });
  } catch (error) {
    console.error('Models error:', error.message);
    res.status(503).json({
      error: 'Could not load Gemma models from Ollama Cloud.'
    });
  }
});

app.post('/api/chat', chatLimiter, globalLimiter, async (req, res) => {
  if (!API_KEY) {
    return res.status(503).json({
      error: 'Ollama API key is not configured.'
    });
  }

  const input = req.body?.messages;

  if (!Array.isArray(input) || input.length < 1 || input.length > 20) {
    return res.status(400).json({
      error: 'Send between 1 and 20 messages.'
    });
  }

  const messages = [];
  let totalLength = 0;

  for (const item of input) {
    if (
      !item ||
      !['user', 'assistant'].includes(item.role) ||
      typeof item.text !== 'string'
    ) {
      return res.status(400).json({ error: 'Invalid message format.' });
    }

    const content = item.text.trim();

    if (!content || content.length > 8000) {
      return res.status(400).json({
        error: 'Each message must contain 1 to 8000 characters.'
      });
    }

    totalLength += content.length;

    if (totalLength > 20000) {
      return res.status(400).json({ error: 'Conversation is too long.' });
    }

    messages.push({
      role: item.role,
      content
    });
  }

  if (messages[messages.length - 1].role !== 'user') {
    return res.status(400).json({
      error: 'The last message must be from the user.'
    });
  }

  try {
    const availableModels = await getGemmaModels();
    const requestedModel = req.body?.model;

    const model = availableModels.includes(requestedModel)
      ? requestedModel
      : availableModels[0];

    if (!model) {
      return res.status(503).json({
        error: 'No Gemma Cloud model is available for this account.'
      });
    }

    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'You are KYAMI, a helpful and thoughtful AI assistant. Match the language of the user. When the user writes in Moroccan Darija, answer naturally in Moroccan Darija. Be clear, accurate, friendly, and honest.'
          },
          ...messages
        ],
        stream: false
      }),
      signal: AbortSignal.timeout(60000)
    });

    if (!response.ok) {
      console.error('Ollama chat status:', response.status);
      return res.status(response.status === 429 ? 429 : 502).json({
        error: response.status === 429
          ? 'Ollama Cloud usage limit reached. Try again later.'
          : 'Ollama Cloud could not complete the request.'
      });
    }

    const data = await response.json();
    const reply = data.message?.content?.trim();

    if (!reply) {
      return res.status(502).json({
        error: 'Ollama returned an empty response.'
      });
    }

    res.json({ reply, model });
  } catch (error) {
    console.error('Chat error:', error.message);

    res.status(error.name === 'TimeoutError' ? 504 : 502).json({
      error: 'Could not connect to Ollama Cloud. Please try again.'
    });
  }
});

app.use((error, _req, res, _next) => {
  if (error.message === 'Origin not allowed') {
    return res.status(403).json({ error: 'Website origin not allowed.' });
  }

  console.error('Server error:', error.message);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`KYAMI API listening on port ${PORT}`);
});
