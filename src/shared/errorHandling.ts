/**
 * Safe error handling: generic user-facing messages, full details only in server logs.
 * Avoids leaking stack traces, paths, or internal details to users (security + UX).
 */

const GENERIC_MESSAGE = 'Something went wrong. Please try again later.';

/**
 * Returns a safe, generic message for displaying to end users.
 * Never returns stack traces, file paths, or internal error details.
 */
export function getSafeUserMessage(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message;
    // Allow known, safe user-facing messages through (e.g. "Failed to login to golf club")
    if (
      msg &&
      msg.length < 120 &&
      !msg.includes('/') &&
      !msg.includes('\\') &&
      !msg.includes('at ')
    ) {
      return msg;
    }
  }
  return GENERIC_MESSAGE;
}

/**
 * Log error server-side with context. Use this instead of console.error(error) so
 * we have a consistent format and can avoid logging PII in the message.
 */
export function logError(context: string, error: unknown): void {
  if (error instanceof Error) {
    console.error(`[${context}]`, error.message);
    if (process.env.NODE_ENV === 'development' && error.stack) {
      console.error(error.stack);
    }
  } else {
    console.error(`[${context}]`, error);
  }
}
