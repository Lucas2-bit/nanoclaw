/**
 * Voice transcription via Groq Whisper API (cloud) or local whisper.cpp.
 *
 * Cloud transcription is used for GCP-hosted containers (Parago).
 * Local whisper.cpp is used for NanoClaw on Mac (already wired in transcription.ts).
 *
 * This module provides the cloud path using Groq's OpenAI-compatible endpoint.
 */

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const MAX_DURATION_SECONDS = 120; // Reject audio longer than 2 minutes

interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
}

/**
 * Transcribe an audio buffer using Groq's Whisper API.
 * Falls back to null on failure (caller handles fallback text).
 */
export async function transcribeWithGroq(
  audioBuffer: Buffer,
  durationSeconds?: number,
): Promise<TranscriptionResult | null> {
  // Duration gate
  if (durationSeconds && durationSeconds > MAX_DURATION_SECONDS) {
    logger.warn(
      { duration: durationSeconds, max: MAX_DURATION_SECONDS },
      'Voice message too long, rejecting',
    );
    return null;
  }

  const secrets = readEnvFile(['GROQ_API_KEY']);
  const apiKey = secrets.GROQ_API_KEY;
  if (!apiKey) {
    logger.error('GROQ_API_KEY not set - cannot transcribe voice');
    return null;
  }

  try {
    // Build multipart form data manually (no SDK dependency)
    const boundary = `----NanoClawVoice${Date.now()}`;
    const parts: Buffer[] = [];

    // File part
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.ogg"\r\nContent-Type: audio/ogg\r\n\r\n`,
      ),
    );
    parts.push(audioBuffer);
    parts.push(Buffer.from('\r\n'));

    // Model part
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3-turbo\r\n`,
      ),
    );

    // Response format
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n`,
      ),
    );

    // Language hint (English - improves accuracy and latency)
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n`,
      ),
    );

    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const response = await fetch(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      },
    );

    if (!response.ok) {
      const errText = await response.text();
      logger.error(
        { status: response.status, body: errText },
        'Groq transcription API error',
      );
      return null;
    }

    const data = (await response.json()) as {
      text: string;
      language?: string;
      duration?: number;
    };

    const text = data.text?.trim();
    if (!text) {
      logger.warn('Groq returned empty transcript');
      return null;
    }

    // Hallucination detection: repeated phrases are a strong Whisper signal
    const words = text.split(/\s+/);
    if (words.length > 10) {
      const uniqueWords = new Set(words.map((w) => w.toLowerCase()));
      if (uniqueWords.size < words.length * 0.3) {
        logger.warn(
          { text, uniqueRatio: uniqueWords.size / words.length },
          'Possible Whisper hallucination detected (high repetition)',
        );
        return null;
      }
    }

    logger.info(
      { chars: text.length, language: data.language, duration: data.duration },
      'Groq transcription complete',
    );

    return {
      text,
      language: data.language,
      duration: data.duration,
    };
  } catch (err) {
    logger.error({ err }, 'Groq transcription failed');
    return null;
  }
}
