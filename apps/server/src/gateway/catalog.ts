/**
 * The cloud models the gateway carries (llm.ts), and how an agent's file is
 * seen to use each of them (http/agent-setup.ts): one entry per provider, so
 * that adding one is adding a row here.
 *
 * Every entry is reached at `<server>/llm/<provider>/` followed by the
 * provider's own path: the provider's address in a file, `https://api.groq.com`
 * say, becomes `<server>/llm/groq`, and whatever came after it still does.
 *
 * Not here, because a key alone does not reach them and the gateway holds
 * nothing else: Azure OpenAI (an address per customer), AWS Bedrock and Google
 * Vertex (signed with the cloud account's own credentials). Nor Hugging Face,
 * whose token is the same one that downloads the agent's models.
 */

export const PROVIDERS = [
  "openai",
  "anthropic",
  "gemini",
  "mistral",
  "groq",
  "openrouter",
  "deepseek",
  "xai",
  "together",
  "fireworks",
  "perplexity",
  "cohere",
  "cerebras",
  "moonshot",
  "qwen",
  "zai",
  "nvidia",
  "sambanova",
] as const;
export type Provider = (typeof PROVIDERS)[number];

export function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

export interface ProviderEntry {
  /** As the console names it. */
  label: string;
  /** The provider's address; the first one is where the gateway calls it. */
  addresses: string[];
  /** The paths the gateway passes on, after `/llm/<provider>/`. */
  path: RegExp;
  /** A GET that a wrong key is refused, for the console to try a key on before saving it. */
  check: string;
  /** How the key is sent: as a bearer token, unless said otherwise. */
  auth?: "x-api-key" | "gemini";

  // How a file is seen to use it, all as regular-expression sources.
  /** The Python packages that call it (`import x`, `from x import`). */
  libraries?: string;
  /** The Rust crates that call it, as the code names them (`use x`, `x::`) or Cargo.toml depends on them, with `-` read as `_`. */
  crates?: string;
  /** Packages that call it in a way the gateway cannot carry (gRPC): a file importing one is left as it is. */
  unreachable?: string;
  /** What its keys look like, where that tells them apart. */
  key?: string;
  /** With `key`: the key alone does not say the file uses this provider (a Google key may be for Maps). */
  keyNeedsMore?: true;
  /** Its keys are `sk-…` as OpenAI's: they are its own only in a file that names it and not OpenAI. */
  openaiShaped?: true;
  /** The word a key's own name holds when it has no telling shape: `MISTRAL_API_KEY = "…"`. */
  named?: string;
  /** Its model names, as a framework is told them (`"gpt-4o"`, `"openai:gpt-4o"`). */
  models?: string;

  /** The variables its clients read their key from: set to the sigillo key, the first ones also a sign of use. */
  keyVariables: string[];
  /** Of `keyVariables`, those that say nothing on their own (GOOGLE_API_KEY also serves Google's other APIs). */
  sharedVariables?: string[];
  /** The variables its clients read their address from, each with the path to add after `/llm/<provider>`. */
  addressVariables: Record<string, string>;
  /** Further such variables that only Rust clients read (openai-api-rs's `OPENAI_API_BASE`). */
  crateAddressVariables?: Record<string, string>;
}

/** Any provider path: URL-safe characters, Gemini's colon included. `..` is refused apart. */
const ANY_PATH = /^[A-Za-z0-9._~-][A-Za-z0-9._~\/:-]*$/;
const V1 = /^v1\/[A-Za-z0-9._~\/-]+$/;

export const CATALOG: Record<Provider, ProviderEntry> = {
  openai: {
    label: "OpenAI",
    addresses: ["https://api.openai.com"],
    path: V1,
    check: "v1/models",
    libraries: "openai|langchain_openai",
    crates: "async_openai|openai_api_rs|openai_dive|rig::providers::openai",
    crateAddressVariables: { OPENAI_API_BASE: "/v1" },
    key: "\\bsk-(?!ant-|or-)[A-Za-z0-9_-]{20,}",
    models: "(?:openai[/:])?(?:gpt-(?!oss)[\\w.-]+|o[134]-[\\w.-]+|chatgpt-[\\w.-]+)",
    keyVariables: ["OPENAI_API_KEY"],
    addressVariables: { OPENAI_BASE_URL: "/v1" },
  },
  anthropic: {
    label: "Anthropic",
    addresses: ["https://api.anthropic.com"],
    path: V1,
    check: "v1/models",
    auth: "x-api-key",
    libraries: "anthropic|langchain_anthropic",
    crates: "anthropic|anthropic_sdk|anthropic_rs|misanthropic|clust|rig::providers::anthropic",
    key: "\\bsk-ant-[A-Za-z0-9_-]{20,}",
    models: "(?:anthropic[/:])?claude-[\\w.-]+",
    keyVariables: ["ANTHROPIC_API_KEY"],
    addressVariables: { ANTHROPIC_BASE_URL: "" },
  },
  gemini: {
    label: "Gemini",
    addresses: ["https://generativelanguage.googleapis.com"],
    // Its versions are v1 and v1beta, and its methods follow a colon:
    // `v1beta/models/gemini-2.5-flash:generateContent`.
    path: /^v1(beta)?\/[A-Za-z0-9._~\/:-]+$/,
    check: "v1beta/models",
    auth: "gemini",
    // google-genai, as `from google import genai` or `import google.genai`.
    libraries: "google\\.genai|langchain_google_genai|google\\s+import\\s+(?:[\\w\\s,]*,\\s*)?genai\\b",
    // The older google-generativeai talks gRPC, which no address variable redirects.
    unreachable: "google\\.generativeai|google\\s+import\\s+(?:[\\w\\s,]*,\\s*)?generativeai\\b",
    crates: "gemini_rust|google_ai_rs|rig::providers::gemini",
    key: "\\bAIza[A-Za-z0-9_-]{35}\\b",
    keyNeedsMore: true,
    models: "(?:gemini/|google-gla:|google-genai:|google_genai:)?gemini-[\\w.-]+",
    keyVariables: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    sharedVariables: ["GOOGLE_API_KEY"],
    addressVariables: { GOOGLE_GEMINI_BASE_URL: "", GEMINI_API_BASE: "/v1beta" },
  },
  mistral: {
    label: "Mistral",
    addresses: ["https://api.mistral.ai"],
    path: V1,
    check: "v1/models",
    libraries: "mistralai|langchain_mistralai",
    crates: "mistralai_client|rig::providers::mistral",
    named: "mistral",
    models:
      "(?:mistral(?:ai)?[/:])?(?:mistral-(?:large|medium|small|tiny|saba)[\\w.-]*|open-mi[sx]tral[\\w.-]*|(?:codestral|magistral|ministral|pixtral|devstral)-[\\w.-]+)",
    keyVariables: ["MISTRAL_API_KEY"],
    // MISTRAL_BASE_URL for LangChain and, through the sigillo package, for mistralai's own client.
    addressVariables: { MISTRAL_BASE_URL: "/v1", MISTRAL_API_BASE: "/v1" },
  },
  groq: {
    label: "Groq",
    addresses: ["https://api.groq.com"],
    path: /^openai\/v1\/[A-Za-z0-9._~\/-]+$/,
    check: "openai/v1/models",
    libraries: "groq|langchain_groq",
    crates: "groq_api_rs|rig::providers::groq",
    key: "\\bgsk_[A-Za-z0-9]{20,}",
    named: "groq",
    keyVariables: ["GROQ_API_KEY"],
    addressVariables: { GROQ_BASE_URL: "", GROQ_API_BASE: "" },
  },
  openrouter: {
    label: "OpenRouter",
    addresses: ["https://openrouter.ai"],
    path: /^api\/v1\/[A-Za-z0-9._~\/:-]+$/,
    // Its model list answers anyone: the key's own page does not.
    check: "api/v1/key",
    crates: "openrouter_rs|openrouter_api|rig::providers::openrouter",
    key: "\\bsk-or-[A-Za-z0-9_-]{20,}",
    named: "openrouter",
    keyVariables: ["OPENROUTER_API_KEY"],
    addressVariables: { OPENROUTER_API_BASE: "/api/v1", OPENROUTER_BASE_URL: "/api/v1" },
  },
  deepseek: {
    label: "DeepSeek",
    addresses: ["https://api.deepseek.com"],
    path: ANY_PATH,
    check: "models",
    libraries: "langchain_deepseek",
    crates: "deepseek_api|rig::providers::deepseek",
    openaiShaped: true,
    named: "deepseek",
    models: "(?:deepseek[/:])?deepseek-(?:chat|reasoner)",
    keyVariables: ["DEEPSEEK_API_KEY"],
    addressVariables: { DEEPSEEK_API_BASE: "", DEEPSEEK_BASE_URL: "" },
  },
  xai: {
    label: "xAI (Grok)",
    addresses: ["https://api.x.ai"],
    path: V1,
    check: "v1/models",
    libraries: "langchain_xai",
    crates: "rig::providers::xai",
    unreachable: "xai_sdk",
    key: "\\bxai-[A-Za-z0-9]{20,}",
    named: "xai|grok",
    models: "(?:xai[/:])?grok-[\\w.-]+",
    keyVariables: ["XAI_API_KEY"],
    addressVariables: { XAI_API_BASE: "/v1", XAI_BASE_URL: "/v1" },
  },
  together: {
    label: "Together",
    addresses: ["https://api.together.xyz", "https://api.together.ai"],
    path: V1,
    check: "v1/models",
    libraries: "together|langchain_together",
    crates: "rig::providers::together",
    key: "\\btgp_v1_[A-Za-z0-9_-]{20,}",
    named: "together",
    keyVariables: ["TOGETHER_API_KEY", "TOGETHERAI_API_KEY"],
    addressVariables: { TOGETHER_BASE_URL: "/v1", TOGETHERAI_API_BASE: "/v1" },
  },
  fireworks: {
    label: "Fireworks",
    addresses: ["https://api.fireworks.ai"],
    path: /^inference\/v1\/[A-Za-z0-9._~\/-]+$/,
    check: "inference/v1/models",
    libraries: "fireworks|langchain_fireworks",
    key: "\\bfw_[A-Za-z0-9]{20,}",
    named: "fireworks",
    keyVariables: ["FIREWORKS_API_KEY", "FIREWORKS_AI_API_KEY"],
    addressVariables: { FIREWORKS_API_BASE: "/inference/v1", FIREWORKS_AI_API_BASE: "/inference/v1" },
  },
  perplexity: {
    label: "Perplexity",
    addresses: ["https://api.perplexity.ai"],
    path: ANY_PATH,
    check: "v1/models",
    libraries: "perplexity|langchain_perplexity",
    crates: "rig::providers::perplexity",
    key: "\\bpplx-[A-Za-z0-9]{20,}",
    named: "perplexity|pplx",
    keyVariables: ["PERPLEXITY_API_KEY", "PERPLEXITYAI_API_KEY", "PPLX_API_KEY"],
    addressVariables: { PERPLEXITY_API_BASE: "", PERPLEXITY_BASE_URL: "" },
  },
  cohere: {
    label: "Cohere",
    addresses: ["https://api.cohere.com", "https://api.cohere.ai"],
    path: /^(v1|v2|compatibility\/v1)\/[A-Za-z0-9._~\/-]+$/,
    check: "v1/models",
    libraries: "cohere|langchain_cohere",
    crates: "cohere_rust|rig::providers::cohere",
    named: "cohere",
    keyVariables: ["CO_API_KEY", "COHERE_API_KEY"],
    addressVariables: { CO_API_URL: "", COHERE_API_BASE: "" },
  },
  cerebras: {
    label: "Cerebras",
    addresses: ["https://api.cerebras.ai"],
    path: V1,
    check: "v1/models",
    libraries: "cerebras|langchain_cerebras",
    key: "\\bcsk-[A-Za-z0-9]{20,}",
    named: "cerebras",
    keyVariables: ["CEREBRAS_API_KEY"],
    addressVariables: { CEREBRAS_BASE_URL: "", CEREBRAS_API_BASE: "/v1" },
  },
  moonshot: {
    label: "Moonshot (Kimi)",
    addresses: ["https://api.moonshot.ai"],
    path: V1,
    check: "v1/models",
    openaiShaped: true,
    named: "moonshot|kimi",
    keyVariables: ["MOONSHOT_API_KEY"],
    addressVariables: { MOONSHOT_API_BASE: "/v1" },
  },
  qwen: {
    label: "Qwen (Alibaba)",
    addresses: ["https://dashscope-intl.aliyuncs.com"],
    path: /^(compatible-mode\/v1|api\/v1)\/[A-Za-z0-9._~\/-]+$/,
    check: "compatible-mode/v1/models",
    libraries: "dashscope",
    openaiShaped: true,
    named: "dashscope|qwen",
    keyVariables: ["DASHSCOPE_API_KEY"],
    addressVariables: { DASHSCOPE_API_BASE: "/compatible-mode/v1", DASHSCOPE_HTTP_BASE_URL: "/api/v1" },
  },
  zai: {
    label: "Z.ai (GLM)",
    addresses: ["https://api.z.ai"],
    path: /^api\/(paas|coding\/paas)\/v4\/[A-Za-z0-9._~\/-]+$/,
    check: "api/paas/v4/models",
    libraries: "zai|zhipuai",
    named: "zai|zhipu",
    keyVariables: ["ZAI_API_KEY", "ZHIPUAI_API_KEY"],
    addressVariables: { ZAI_API_BASE: "/api/paas/v4", ZAI_BASE_URL: "/api/paas/v4" },
  },
  nvidia: {
    label: "NVIDIA",
    addresses: ["https://integrate.api.nvidia.com"],
    path: V1,
    check: "v1/models",
    libraries: "langchain_nvidia_ai_endpoints",
    key: "\\bnvapi-[A-Za-z0-9_-]{20,}",
    named: "nvidia",
    keyVariables: ["NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"],
    addressVariables: { NVIDIA_BASE_URL: "/v1", NVIDIA_NIM_API_BASE: "/v1" },
  },
  sambanova: {
    label: "SambaNova",
    addresses: ["https://api.sambanova.ai"],
    path: V1,
    check: "v1/models",
    libraries: "sambanova|langchain_sambanova",
    named: "sambanova",
    keyVariables: ["SAMBANOVA_API_KEY"],
    addressVariables: { SAMBANOVA_API_BASE: "/v1", SAMBANOVA_BASE_URL: "/v1" },
  },
};

/**
 * What a file's analysis needs of the catalog, as plain data the browser's
 * script carries (agent-setup.ts): regular expressions as their sources.
 */
export function fileCatalog(): Array<Record<string, unknown>> {
  return PROVIDERS.map((name) => {
    const { path: _path, check: _check, auth: _auth, ...rest } = CATALOG[name];
    return { name, ...rest };
  });
}
