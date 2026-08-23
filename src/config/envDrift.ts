/**
 * Finds config keys that .env.example declares but the running process's
 * environment doesn't have at all - i.e. a .env file created before those
 * keys existed. Those keys still work (schema defaults cover them), but a
 * user editing a value that silently isn't there is a confusing dead end,
 * so this is surfaced as a loud startup warning instead.
 */
export function findMissingEnvKeys(
  exampleFileContent: string,
  actualEnv: NodeJS.ProcessEnv,
): string[] {
  const declaredKeys = [...exampleFileContent.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(
    (m) => m[1]!,
  );
  return declaredKeys.filter((key) => actualEnv[key] === undefined);
}
