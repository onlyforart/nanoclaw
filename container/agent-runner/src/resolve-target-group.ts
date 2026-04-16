export interface AvailableGroup {
  jid: string;
  name: string;
  isRegistered: boolean;
}

export interface ResolveResult {
  match?: AvailableGroup;
  error?: string;
}

export function resolveTargetGroup(
  target: string,
  groups: AvailableGroup[],
): ResolveResult {
  const needle = target.toLowerCase();
  const match = groups.find(
    (g) => g.jid.toLowerCase() === needle || g.name.toLowerCase() === needle,
  );

  if (!match) {
    const registered = groups.filter((g) => g.isRegistered).map((g) => g.name);
    return {
      error: `group "${target}" not found. Registered groups: ${registered.join(', ')}`,
    };
  }

  if (!match.isRegistered) {
    return {
      error: `group "${match.name}" exists but is not registered (bot is not active in it). Only registered groups can receive messages.`,
    };
  }

  return { match };
}
