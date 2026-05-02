/**
 * Text-to-Speech via OpenAI gpt-4o-mini-tts.
 * Direct API calls - no SDK dependency.
 *
 * Returns an OGG/Opus buffer suitable for sending as a Telegram/WhatsApp voice note.
 */

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

/** Maximum text length to synthesize (roughly 90 seconds of speech) */
const MAX_TTS_CHARS = 1500;

/** Default voice: calm, androgynous, leaning female */
const DEFAULT_VOICE = 'shimmer';

/** Tone instruction for the voice */
const DEFAULT_INSTRUCTIONS =
  'Speak in a calm, warm, and thoughtful tone. Be natural and conversational.';

export interface TtsOptions {
  voice?: string;
  instructions?: string;
}

/**
 * Generate speech audio from text using OpenAI gpt-4o-mini-tts.
 * Returns an OGG/Opus buffer ready to send as a voice note, or null on failure.
 */
export async function generateSpeech(
  text: string,
  options?: TtsOptions,
): Promise<Buffer | null> {
  const secrets = readEnvFile(['OPENAI_API_KEY']);
  const apiKey = secrets.OPENAI_API_KEY;
  if (!apiKey) {
    logger.error('OPENAI_API_KEY not set - cannot generate speech');
    return null;
  }

  // Truncate if too long (Lutke: don't send 10-minute voice notes)
  let inputText = text;
  if (inputText.length > MAX_TTS_CHARS) {
    inputText = inputText.slice(0, MAX_TTS_CHARS) + '...';
    logger.info(
      { original: text.length, truncated: inputText.length },
      'TTS text truncated to stay under voice note limit',
    );
  }

  const voice = options?.voice || DEFAULT_VOICE;
  const instructions = options?.instructions || DEFAULT_INSTRUCTIONS;

  try {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        input: inputText,
        voice,
        instructions,
        response_format: 'opus',
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.error(
        { status: response.status, body: errText },
        'OpenAI TTS API error',
      );
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    logger.info(
      { voice, inputChars: inputText.length, audioBytes: buffer.length },
      'TTS generation complete',
    );

    return buffer;
  } catch (err) {
    logger.error({ err }, 'TTS generation failed');
    return null;
  }
}
