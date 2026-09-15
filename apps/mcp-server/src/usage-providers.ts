/**
 * The providers whose spend can be confirmed, named here rather than imported.
 *
 * This is the only value the tool schemas ever took from @offcut/core, and a
 * value import is a runtime import: naming the list from the core would load
 * the generated Prisma client on the way past, which is exactly the database
 * the remote mode exists to never open. Type-only imports cost nothing at
 * runtime; this one did.
 *
 * Copying a constant is a drift risk, so it is not left to trust:
 * packages/acceptance asserts this list is identical to the core's
 * SUPPORTED_USAGE_PROVIDERS, and fails the moment a provider is added there
 * and not here.
 */

export const USAGE_PROVIDERS = ['openrouter'] as const;
