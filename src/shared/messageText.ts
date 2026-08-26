const AMBIENT_BROWSER_CONTEXT_BLOCK = /\\?<in-app-browser-context\b[^>]*\bsource=(?:"ambient-ui-state"|'ambient-ui-state')[^>]*>[\s\S]*?\\?<\/in-app-browser-context>\s*/gi;
const ATTACHMENT_CONTEXT_TO_REQUEST = /^\s*(?:#{1,6}\s*)?Files mentioned by the user:\s*[\s\S]*?(?:#{1,6}\s*)?My request[:：]\s*/i;
const AMBIENT_REQUEST_PREFIX = /^(?:\s*(?:#{1,6}\s*)?(?:My request[:：]|我的请求：?)\s*)+/i;

/**
 * Removes browser ambient state that can be attached to a user prompt by the
 * host UI. The state is transport metadata, not part of the user's message.
 */
export function stripAmbientBrowserContext(text: string): string {
  return text
    .replace(AMBIENT_BROWSER_CONTEXT_BLOCK, "")
    .replace(ATTACHMENT_CONTEXT_TO_REQUEST, "")
    .replace(AMBIENT_REQUEST_PREFIX, "")
    .trim();
}
