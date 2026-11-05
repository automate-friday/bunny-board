// Existing service definitions and already-started agents may still use old env names.
// Read them without letting them overwrite an explicit Bunny setting (including "").
export function bunnyEnv(suffix: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`BUNNY_${suffix}`] ?? env[`PASEO_BOARD_${suffix}`];
}

export function migrateLegacyEnv(env: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('PASEO_BOARD_')) env[`BUNNY_${key.slice('PASEO_BOARD_'.length)}`] ??= value;
  }
}
