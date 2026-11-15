// The Muse child environment's strip list, with no imports: a consumer that also runs the Muse CLI directly
// (`muse usage`, `muse --version`) takes it from `@inixiative/agent-session/muse-env` without compiling the transports.
/**
 * Inherited variables that would bill, route or loosen Muse away from its saved subscription login
 * and the gates, by the names the 1.4.20 binary reads: metered keys and endpoints (META_, LLM_,
 * MODEL_, LLAMA_, OPENROUTER_, ANTHROPIC_, OPENAI_), Meta's auth and key-mint endpoints, and MUSE_
 * switches for the model, experiments, contributor mode, the approval judge, a fail-open profile,
 * request routing and custom headers, the computer-use dev policy and identity skip, the launcher's
 * channel and install switches, the credential backend, and the eval and test hooks (prompt injection,
 * policy and grant overrides). The CA and TLS roots stay: a machine behind a proxy needs them. Muse's own tool runs inherit this environment, so they do not see these either.
 */
export const MUSE_COMPETING_ENV =
  /^(META_|LLM_|MODEL_|LLAMA_|OPENROUTER_|ANTHROPIC_|OPENAI_|TBH_(AUTH|MINT)_BASE_URL$|MUSE_EXPERIMENTAL_|TBH_(CREDENTIAL_BACKEND$|EVAL_|TEST_)|MUSE_CUA_DEV_|MUSE_(MODEL|CHANNEL|LAUNCHER_INSTALL|CONTRIBUTOR_MODE|DISABLE_APPROVAL_JUDGE|PERMISSION_PROFILE_FAIL_OPEN|WWW_ROUTING|CUSTOM_HEADERS)$)/;
