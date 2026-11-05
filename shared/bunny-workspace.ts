// Document metadata, unlike the Paseo API's own fields, belongs to Bunny.
export function migrateWorkspaceMeta<T extends Record<string, unknown>>(meta: T): T {
  if (!Object.hasOwn(meta, 'paseoBoardWorkspaceId')) return meta;
  const { paseoBoardWorkspaceId, ...rest } = meta;
  return { ...rest, bunnyWorkspaceId: meta.bunnyWorkspaceId ?? paseoBoardWorkspaceId } as unknown as T;
}
