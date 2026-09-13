/**
 * @offcut/core - the OFFCUT AGENT memory core.
 *
 * SS4 lists six components; all six live in this package:
 *
 *   Memory Store    store.ts    sources, versions, relationships, transactions
 *   Access Layer    access.ts   workspace permissions and caller identity
 *   Merge Engine    merge.ts    duplicates, related records, conflicts, freshness
 *   Context Builder context.ts  retrieval and bounded assembly with references
 *   Memory SDK      memory.ts   the eight operations (wrapped by @offcut/sdk)
 *   MCP Server      -           apps/mcp-server, which calls memory.ts and adds
 *                               no business logic of its own
 *
 * Anything that connects to a workspace goes through Memory. There is no second
 * path to the data, which is what makes invariant 8 structural.
 */

import './env';

export { Memory, memoryFor } from './memory';
export type { AuditEventView, EventCursor, EventPage } from './memory';

export {
  authenticateAgent,
  authenticateUser,
  authorize,
  canCorrectRecordOf,
  canDecideTruth,
  looksLikeInjection,
  visibilityWhere,
  type AccessContext,
} from './access';

export {
  createAgent,
  createUser,
  createWorkspace,
  deleteWorkspace,
  getLinkedWallet,
  getWorkspaceStats,
  hashPassword,
  linkWallet,
  listAgents,
  listWorkspaces,
  revokeAgent,
  rotateAgentKey,
  unlinkWallet,
  updateAgentPermissions,
  updateWorkspace,
  verifyPassword,
  verifyUserCredentials,
  type WalletLink,
} from './admin';

// The wallet door, beside the email one and never in front of it (§5, line 151).
export { findOrCreateUserByWallet, type WalletUser } from './admin';

// What makes that door single-use. The surface checks the signature; the spend
// is a row here, because a cookie cannot be spent by anyone who ignores it.
export { spendSiweNonce } from './siwe-nonces';

export {
  disconnectPrisma,
  getPrisma,
  insensitiveContains,
  isPostgres,
  resolveDatabaseUrl,
  setPrisma,
  type Db,
} from './db';

export {
  BACKUP_FORMAT,
  createBackup,
  ledgerStats,
  listBackups,
  pruneBackups,
  restoreBackup,
  type BackupSummary,
  type RestoreReport,
} from './backup';

export { appendDeletions, deletionsSince, ledgerPath, readLedger, type LedgerEntry } from './ledger';

// The other ledger: what the publisher decided each address was owed, read back
// for the console. Written by @offcut/rewards, which sits on top of this package.
export { accrualsFor, type AccrualHistory, type AccrualPeriod } from './accruals';

export {
  creditRetrieval,
  creditsInWindow,
  earnedEver,
  earnedInWindow,
  type CreditsByWorkspace,
  type CreditWindow,
  type EarnedByWorkspace,
} from './credits';

export {
  SUPPORTED_USAGE_PROVIDERS,
  agentActivity,
  reportUsage,
  spendByWorkspace,
  spendEver,
  spendInWindow,
  unconfirmedUsage,
  verifyPendingUsage,
  type AgentActivity,
  type ReportUsageResult,
  type SpendByWorkspace,
  type UnconfirmedUsage,
  type UsageProvider,
  type UsageReport,
  type UsageStatus,
  type UsageVerifier,
  type UsageVerifierSource,
  type VerificationRun,
  type VerifiedUsage,
} from './usage';

export {
  clearUsageCredential,
  getUsageCredential,
  setUsageCredential,
  type UsageCredentialStatus,
} from './usage-credentials';

// The supported integration the brief requires: spend is confirmed by asking
// OpenRouter what a generation cost, never by believing what an agent reported.
export {
  openRouterUsageSource,
  openRouterVerifier,
  probeOpenRouterKey,
  usdToMicros,
  type KeyProbe,
  type OpenRouterVerifierOptions,
} from './providers/openrouter';

// Exported for the surfaces that have to report whether this server can store a
// credential at all. The key itself is never returned by anything.
export { secretsConfigured } from './secrets';

export { backupRetentionDays, resolveBackupDir, resolveDataDir } from './paths';

export {
  getModelSummarySettings,
  setModelSummaries,
  summarize,
  type ProposedConflict,
  type ProposedRelationship,
  type SummaryResult,
} from './summaries';

export {
  OffcutError,
  asZodError,
  errors,
  isOffcutError,
  parseInput,
  validationErrorFrom,
  type OffcutErrorCode,
} from './errors';

export {
  AGENT_KINDS,
  CONFLICT_STATUSES,
  DEFAULT_LEAD_PERMISSIONS,
  DEFAULT_SUBAGENT_PERMISSIONS,
  LIMITS,
  LINK_KINDS,
  OPERATIONS,
  RECORD_TYPES,
  SCOPES,
  addInputSchema,
  exportInputSchema,
  forgetInputSchema,
  importInputSchema,
  importRecordSchema,
  inspectInputSchema,
  mergeInputSchema,
  principalId,
  principalLabel,
  recallInputSchema,
  resolveInputSchema,
} from './types';

export type {
  AddInput,
  AddResult,
  AgentKind,
  ConflictSideView,
  ConflictStatus,
  ConflictView,
  ContextItem,
  ContextResult,
  ExportInput,
  ExportResult,
  ForgetInput,
  ForgetResult,
  ImportInput,
  ImportRecord,
  ImportResult,
  InspectInput,
  InspectResult,
  LinkKind,
  MergeInput,
  MergeResult,
  MergedBlockView,
  Operation,
  Permissions,
  Principal,
  RecallInput,
  RecordType,
  RecordView,
  ResolveInput,
  ResolveResult,
  Scope,
  SourceRef,
} from './types';

export { bm25, generateApiKey, hashApiKey, normalizeTopic, slugify, tokenize } from './util';
