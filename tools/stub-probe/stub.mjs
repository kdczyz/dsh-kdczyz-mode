const chain = new Proxy(function () {}, {
  get(_t, k) { if (k === 'then') return undefined; if (k === Symbol.toPrimitive) return () => ''; if (k === 'toString') return () => '[stub]'; return chain; },
  apply() { return chain; },
  construct() { return chain; },
});
export default chain;
export const createProvider = chain;
export const openAICompletionsApi = chain;
export const resolveImageAttachmentAccess = chain;
export const resolveRetryPolicy = chain;
export const PiAiAdapter = chain;
export const withFileLock = async (_p, fn) => fn();
export const writeFileAtomic = async () => {};
export const resolveDshHome = () => process.env.HOME + '/.dsh';
