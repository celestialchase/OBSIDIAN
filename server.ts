import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import {
  classifyGeminiError,
  parseGeminiJson,
  validateDoubtRequest,
  validateGenerateQuizRequest,
  validateSimplifyRequest,
  validateTranscribeRequest,
  validateVisualConceptRequest,
} from './src/utils/serverValidation';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;

interface FirebasePublicConfig {
  projectId?: string;
  apiKey?: string;
}

function loadFirebasePublicConfig(): FirebasePublicConfig {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'firebase-applet-config.json'), 'utf8');
    return JSON.parse(raw) as FirebasePublicConfig;
  } catch {
    return {};
  }
}

const FIREBASE_PUBLIC_CONFIG = loadFirebasePublicConfig();

function resolveFirebaseWebApiKey(): string | undefined {
  return (
    (process.env.VITE_FIREBASE_API_KEY &&
    !process.env.VITE_FIREBASE_API_KEY.startsWith('YOUR_')
      ? process.env.VITE_FIREBASE_API_KEY
      : undefined) || FIREBASE_PUBLIC_CONFIG.apiKey
  );
}

async function requireFirebaseAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({
      error: 'Authentication required. Please sign in to use live AI features.',
    });
    return;
  }

  if (!authHeader.startsWith('Bearer ') || authHeader.length <= 7) {
    res.status(401).json({ error: 'Malformed Authorization header.' });
    return;
  }

  const idToken = authHeader.slice(7).trim();
  if (!idToken || idToken.length > 8192) {
    res.status(401).json({ error: 'Invalid session token format.' });
    return;
  }

  const firebaseApiKey = resolveFirebaseWebApiKey();
  if (!firebaseApiKey) {
    res.status(503).json({
      error: 'Firebase authentication verification is not configured on the server.',
    });
    return;
  }

  try {
    const verifyRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseApiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );
    if (!verifyRes.ok) {
      res.status(401).json({ error: 'Invalid or expired Firebase session token. Please sign in again.' });
      return;
    }
    const payload = (await verifyRes.json()) as {
      users?: Array<{ localId?: string; emailVerified?: boolean }>;
    };
    const userRecord = payload.users?.[0];
    if (!userRecord?.localId) {
      res.status(401).json({ error: 'Unable to verify authenticated user.' });
      return;
    }
    if (userRecord.emailVerified !== true) {
      res.status(403).json({
        error: 'Please verify your email address before calling live AI endpoints.',
      });
      return;
    }
    res.locals.uid = userRecord.localId;
    next();
  } catch {
    res.status(401).json({ error: 'Failed to verify authentication token.' });
  }
}

function createGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function isModelNotFoundError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes('404') || msg.includes('NOT_FOUND') || msg.includes('is not found');
}

async function generateWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('503') || msg.includes('UNAVAILABLE')) {
      await new Promise((r) => setTimeout(r, 900));
      return await fn();
    }
    throw err;
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '12mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    const apiKey = process.env.GEMINI_API_KEY;
    const fbProjectId =
      (process.env.VITE_FIREBASE_PROJECT_ID &&
      !process.env.VITE_FIREBASE_PROJECT_ID.startsWith('YOUR_')
        ? process.env.VITE_FIREBASE_PROJECT_ID
        : undefined) || FIREBASE_PUBLIC_CONFIG.projectId;
    const fbApiKey = resolveFirebaseWebApiKey();
    res.json({
      ok: true,
      geminiConfigured: Boolean(apiKey && apiKey !== 'MY_GEMINI_API_KEY'),
      firebaseConfigured: Boolean(fbProjectId && fbApiKey),
    });
  });

  app.post('/api/ai/doubt', requireFirebaseAuth, async (req: Request, res: Response) => {
    const checked = validateDoubtRequest(req.body);
    if (!checked.ok) {
      res.status(400).json({ error: checked.error });
      return;
    }
    const { question, mode, subject, grade, imageBase64, imageMimeType } = checked.data;

    const ai = createGeminiClient();
    if (!ai) {
      res.status(503).json({
        error: 'Gemini API key is not configured on the server. Add GEMINI_API_KEY in Secrets to enable live AI responses.',
      });
      return;
    }

    const modeGuidance: Record<string, string> = {
      simple:
        'Use short, clear sentences with everyday Indian classroom examples. Avoid dense jargon and keep paragraphs brief for dyslexic and visual learners.',
      detailed:
        'Provide a structured, thorough CBSE-aligned explanation with clear numbered steps, definitions, and a quick recap.',
      visual:
        'Explain using a visual mental model, step-by-step spatial flow, ASCII/structured flow steps, and vivid concrete comparisons.',
    };

    const systemInstruction = [
      'You are IndraSetu AI, an inclusive CBSE educational tutor designed for dyslexic, deaf, hard-of-hearing, and non-speaking students.',
      `Student context: ${grade} (${subject}).`,
      modeGuidance[mode] || modeGuidance.simple,
      'Always respond with valid JSON matching the requested schema.',
    ].join(' ');

    try {
      const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
      if (imageBase64) {
        parts.push({
          inlineData: {
            mimeType: imageMimeType,
            data: imageBase64,
          },
        });
      }
      parts.push({ text: question });

      const response = await generateWithRetry(() =>
        ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: { parts },
          config: {
            systemInstruction,
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                answer: {
                  type: Type.STRING,
                  description: 'Main clear explanation in short accessible paragraphs.',
                },
                keyPoints: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: '3 to 5 concise takeaway bullet points.',
                },
                visualSteps: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: '3 to 4 step-by-step visual or logical progression steps.',
                },
              },
              required: ['answer', 'keyPoints', 'visualSteps'],
            },
          },
        })
      );

      const parsed = parseGeminiJson<{
        answer?: string;
        keyPoints?: string[];
        visualSteps?: string[];
      }>(response.text, {});
      res.json({
        answer: parsed.answer || 'Here is a clear explanation for your question.',
        keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
        visualSteps: Array.isArray(parsed.visualSteps) ? parsed.visualSteps : [],
        source: 'gemini',
      });
    } catch (error: unknown) {
      const classified = classifyGeminiError(error);
      res.status(classified.status).json({ error: classified.error });
    }
  });

  app.post('/api/ai/simplify', requireFirebaseAuth, async (req: Request, res: Response) => {
    const checked = validateSimplifyRequest(req.body);
    if (!checked.ok) {
      res.status(400).json({ error: checked.error });
      return;
    }
    const { text, title } = checked.data;

    const ai = createGeminiClient();
    if (!ai) {
      res.status(503).json({
        error: 'Gemini API key is not configured on the server.',
      });
      return;
    }

    try {
      const response = await generateWithRetry(() =>
        ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: `Title: ${title}\n\nPassage:\n${text.slice(0, 6000)}`,
          config: {
            systemInstruction:
              'Rewrite the educational passage for students with dyslexia and reading difficulties. Use short active-voice sentences (max 15 words each), concrete explanations, and list 4 key vocabulary terms with simple meanings.',
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                summary: { type: Type.STRING },
                simplifiedParagraphs: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
                keyTerms: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      term: { type: Type.STRING },
                      meaning: { type: Type.STRING },
                    },
                    required: ['term', 'meaning'],
                  },
                },
              },
              required: ['summary', 'simplifiedParagraphs', 'keyTerms'],
            },
          },
        })
      );

      const parsed = parseGeminiJson<Record<string, unknown>>(response.text, {});
      res.json({ ...parsed, source: 'gemini' });
    } catch (error: unknown) {
      const classified = classifyGeminiError(error);
      res.status(classified.status).json({ error: classified.error });
    }
  });

  app.post('/api/ai/visual-concept', requireFirebaseAuth, async (req: Request, res: Response) => {
    const checked = validateVisualConceptRequest(req.body);
    if (!checked.ok) {
      res.status(400).json({ error: checked.error });
      return;
    }
    const { topic, subject, grade } = checked.data;

    const ai = createGeminiClient();
    if (!ai) {
      res.status(503).json({
        error: 'Gemini API key is not configured on the server.',
      });
      return;
    }

    try {
      const response = await generateWithRetry(() =>
        ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: `Create a visual step-by-step concept breakdown for "${topic}" in ${grade} ${subject}.`,
          config: {
            systemInstruction:
              'Build an accessible visual learning module for deaf, visual, and dyslexic CBSE students. Each stage should describe a clear visual cue and a bite-sized takeaway.',
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                summary: { type: Type.STRING },
                stages: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      step: { type: Type.INTEGER },
                      title: { type: Type.STRING },
                      description: { type: Type.STRING },
                      visualCue: { type: Type.STRING },
                      formulaOrFact: { type: Type.STRING },
                    },
                    required: ['step', 'title', 'description', 'visualCue', 'formulaOrFact'],
                  },
                },
                keyTerms: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      term: { type: Type.STRING },
                      definition: { type: Type.STRING },
                    },
                    required: ['term', 'definition'],
                  },
                },
              },
              required: ['title', 'summary', 'stages', 'keyTerms'],
            },
          },
        })
      );

      const parsed = parseGeminiJson<Record<string, unknown>>(response.text, {});
      res.json({ ...parsed, source: 'gemini' });
    } catch (error: unknown) {
      const classified = classifyGeminiError(error);
      res.status(classified.status).json({ error: classified.error });
    }
  });

  app.post('/api/ai/generate-quiz', requireFirebaseAuth, async (req: Request, res: Response) => {
    const checked = validateGenerateQuizRequest(req.body);
    if (!checked.ok) {
      res.status(400).json({ error: checked.error });
      return;
    }
    const { topic, subject, grade, count } = checked.data;

    const ai = createGeminiClient();
    if (!ai) {
      res.status(503).json({ error: 'Gemini API key is not configured on the server.' });
      return;
    }

    try {
      const response = await generateWithRetry(() =>
        ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: `Generate ${count} accessible ${grade} ${subject} questions on "${topic}". Mix multiple-choice (mcq) and fill-in-the-blank (fill-blank) questions. Do not rely on audio.`,
          config: {
            systemInstruction:
              'Create clear, dyslexia-friendly CBSE questions with unambiguous wording and helpful explanations.',
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  type: { type: Type.STRING },
                  prompt: { type: Type.STRING },
                  options: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  correctAnswer: { type: Type.STRING },
                  explanation: { type: Type.STRING },
                },
                required: ['id', 'type', 'prompt', 'options', 'correctAnswer', 'explanation'],
              },
            },
          },
        })
      );

      const questions = parseGeminiJson<unknown[]>(response.text, []);
      res.json({ questions, source: 'gemini' });
    } catch (error: unknown) {
      const classified = classifyGeminiError(error);
      res.status(classified.status).json({ error: classified.error });
    }
  });

  app.post('/api/speech/transcribe', requireFirebaseAuth, async (req: Request, res: Response) => {
    const checked = validateTranscribeRequest(req.body);
    if (!checked.ok) {
      res.status(400).json({ error: checked.error });
      return;
    }
    const { audioBase64, mimeType, lessonTitle } = checked.data;

    const ai = createGeminiClient();
    if (!ai) {
      res.status(503).json({ error: 'Gemini API key is not configured on the server.' });
      return;
    }

    const requestParts = {
      parts: [
        {
          inlineData: {
            mimeType,
            data: audioBase64,
          },
        },
        {
          text: `Transcribe this educational audio for "${lessonTitle}" accurately with clear punctuation for deaf and hard-of-hearing students. Output only the clean transcript.`,
        },
      ],
    };

    try {
      let response;
      let modelUsed = 'gemini-3.5-transcribe';
      try {
        response = await generateWithRetry(() =>
          ai.models.generateContent({
            model: 'gemini-3.5-transcribe',
            contents: requestParts,
          })
        );
      } catch (primaryErr: unknown) {
        if (!isModelNotFoundError(primaryErr)) {
          throw primaryErr;
        }
        modelUsed = 'gemini-4-hydrogen';
        response = await generateWithRetry(() =>
          ai.models.generateContent({
            model: 'gemini-4-hydrogen',
            contents: requestParts,
          })
        );
      }

      res.json({
        transcript: (response.text || '').trim(),
        source: 'gemini',
        model: modelUsed,
      });
    } catch (error: unknown) {
      const classified = classifyGeminiError(error);
      res.status(classified.status).json({ error: classified.error });
    }
  });

  // Ensure JSON parse errors, 12 MB payload errors, and unexpected /api/* failures return structured JSON
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    const bodyErr = err as { type?: string; status?: number; statusCode?: number };
    if (bodyErr?.type === 'entity.too.large' || bodyErr?.status === 413 || bodyErr?.statusCode === 413) {
      res.status(413).json({
        error: 'Request payload exceeds the 12 MB limit. Please upload a smaller file (under 8 MB).',
      });
      return;
    }
    if (bodyErr?.type === 'entity.parse.failed' || (err instanceof SyntaxError && req.path.startsWith('/api/'))) {
      res.status(400).json({ error: 'Invalid JSON request payload.' });
      return;
    }
    if (req.path.startsWith('/api/')) {
      res.status(500).json({ error: 'Unexpected server error while processing your request.' });
      return;
    }
    next(err);
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`IndraSetu AI server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
