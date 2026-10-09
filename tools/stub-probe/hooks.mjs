const S = new URL('../stub/stub.mjs', import.meta.url).href;
const map = {
  '@deepseek-ai/schemastery': S,
  '@earendil-works/pi-ai': S,
  '@earendil-works/pi-ai/api/openai-completions.lazy': S,
  '@deepseek-ai/dsh-llm': S,
  '@deepseek-ai/dsh-llm-pi-ai': S,
  '@deepseek-ai/dsh-atomic-write': new URL('./stub-atomic.mjs', import.meta.url).href,
  '@deepseek-ai/dsh-attachment': S,
  '@deepseek-ai/dsh-home-paths': new URL('./stub-home.mjs', import.meta.url).href,
  '@deepseek-ai/dsh-host-webserver': S,
  '@deepseek-ai/dsh-settings': S,
  '@deepseek-ai/dsh-client-ui-primitives': S,
};
export async function resolve(spec, ctx, next) {
  if (map[spec]) return { url: map[spec], shortCircuit: true };
  return next(spec, ctx);
}
