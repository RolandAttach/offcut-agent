/**
 * The surface the tools actually use.
 *
 * `callTool` used to take a `Memory` from @offcut/core, which meant the type
 * and the implementation arrived together: importing the class to name it in a
 * signature also loaded the generated Prisma client (db.ts builds it at module
 * load). That is fine when the store is local and wrong when it is not - a
 * remote server has no business opening a SQLite file on the way past.
 *
 * So the operations are named here, structurally, and both implementations
 * satisfy them: the local `Memory` class and the HTTP client in remote.ts. This
 * file imports nothing, which is the point of it.
 *
 * Parameters are `unknown` rather than the core's input types on purpose. The
 * schemas live in @offcut/core and are applied there (invariant 8: the MCP
 * surface adds no rules of its own), so re-declaring them here would be a
 * second copy of the contract, free to drift. A method declaration is checked
 * bivariantly, so `Memory` - whose methods take the real input types - is
 * assignable to this.
 */

export interface MemorySurface {
  add(input: unknown): Promise<unknown>;
  import(input: unknown): Promise<unknown>;
  merge(input: unknown): Promise<unknown>;
  recall(input: unknown): Promise<unknown>;
  inspect(input: unknown): Promise<unknown>;
  resolve(input: unknown): Promise<unknown>;
  forget(input: unknown): Promise<unknown>;
  export(input: unknown): Promise<unknown>;
  reportUsage(workspaceId: string, reports: unknown[]): Promise<unknown>;
}

/** The eight memory operations, in the order SS4.1 lists them. */
export const MEMORY_OPERATIONS = [
  'add',
  'import',
  'merge',
  'recall',
  'inspect',
  'resolve',
  'forget',
  'export',
] as const;

export type MemoryOperation = (typeof MEMORY_OPERATIONS)[number];
