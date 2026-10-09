export async function resolve(specifier, context, nextResolve) {
  const map = {
    '@deepseek-ai/schemastery': new URL('./stub.mjs', import.meta.url).href,
    '@earendil-works/pi-ai': new URL('./stub.mjs', import.meta.url).href,
    '@earendil-works/pi-ai/api/openai-completions.lazy': new URL('./stub.mjs', import.meta.url).href,
    '@deepseek-ai/dsh-llm': new URL('./stub.mjs', import.meta.url).href,
    '@deepseek-ai/dsh-llm-pi-ai': new URL('./stub.mjs', import.meta.url).href,
  };
  if (map[specifier]) return { url: map[specifier], shortCircuit: true };
  return nextResolve(specifier, context);
}
