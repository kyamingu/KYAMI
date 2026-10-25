'use strict';
const express = require('express');
const cors = require('cors');
const { rateLimit } = require('express-rate-limit');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const allowedOrigins = (process.env.FRONTEND_ORIGINS || 'https://kyamingu.github.io,http://localhost:5500,http://127.0.0.1:5500')
  .split(',').map(s => s.trim()).filter(Boolean);

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('This website origin is not allowed.'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  maxAge: 600
}));
app.use(express.json({ limit: '32kb' }));
app.use('/api/', rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many messages from this connection. Please wait a few minutes and try again.' }
}));

app.get('/health', (_req, res) => res.json({ status: 'ok', configured: Boolean(API_KEY), model: MODEL }));

app.post('/api/chat', async (req, res) => {
  if (!API_KEY) return res.status(503).json({ error: 'AI is not configured yet. Add GEMINI_API_KEY in your backend service environment variables.' });
  const messages = req.body && req.body.messages;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 20) {
    return res.status(400).json({ error: 'Send between 1 and 20 messages.' });
  }
  const contents = [];
  for (const message of messages) {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.text !== 'string') {
      return res.status(400).json({ error: 'Each message must have a valid role and text.' });
    }
    const text = message.text.trim();
    if (!text || text.length > 8000) return res.status(400).json({ error: 'Each message must be between 1 and 8,000 characters.' });
    contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text }] });
  }
  if (contents[contents.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'The last message must be from the user.' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'You are KYAMI, a helpful, thoughtful AI assistant. Answer clearly and accurately. Match the language used by the user. If the user writes in Darija or Arabic, respond naturally in that language. If you are unsure, be honest. Do not claim to have performed actions you cannot perform.' }] },
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
      })
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error('Gemini API error status:', upstream.status, 'message:', data && data.error && data.error.message ? data.error.message : 'No detail');
      if (upstream.status === 429) return res.status(429).json({ error: 'KYAMI has reached the AI provider rate limit. Please wait and try again.' });
      if (upstream.status === 401 || upstream.status === 403) return res.status(502).json({ error: 'The AI provider rejected the API key. Check GEMINI_API_KEY in your backend settings.' });
      return res.status(502).json({ error: 'The AI provider could not complete this request. Please try again shortly.' });
    }
    const reply = (data.candidates || []).flatMap(c => c.content && Array.isArray(c.content.parts) ? c.content.parts : []).map(p => p.text || '').join('').trim();
    if (!reply) return res.status(502).json({ error: 'The AI provider returned no text. Please try asking in a different way.' });
    return res.json({ reply, model: MODEL });
  } catch (error) {
    if (error.name === 'AbortError') return res.status(504).json({ error: 'The AI took too long to respond. Please try again.' });
    console.error('Chat request failed:', error.message);
    return res.status(502).json({ error: 'Could not reach the AI provider. Please try again shortly.' });
  } finally {
    clearTimeout(timeout);
  }
});

app.use((error, _req, res, _next) => {
  if (error && error.message === 'This website origin is not allowed.') return res.status(403).json({ error: 'This website is not allowed to use the KYAMI API.' });
  if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'Request body must be valid JSON.' });
  console.error('Server error:', error.message);
  return res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(PORT, '0.0.0.0', () => console.log(`KYAMI API listening on port ${PORT}`));
