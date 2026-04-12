import { logger } from './logger.js';

export async function sendWithRetry(
  sendFn: (jid: string, text: string) => Promise<void>,
  jid: string,
  text: string,
  maxRetries: number = 3,
): Promise<{ success: boolean; error?: string }> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await sendFn(jid, text);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === maxRetries) {
        logger.error(
          { jid, attempt, maxRetries, err },
          'Send failed after all retries',
        );
        return { success: false, error: message };
      }
      const delayMs = Math.pow(2, attempt - 1) * 1000;
      logger.warn(
        { jid, attempt, maxRetries, delayMs, err },
        'Send failed, retrying',
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return { success: false, error: 'Unexpected: no attempts made' };
}
