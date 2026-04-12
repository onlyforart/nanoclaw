import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface ContainerResponse {
  name: string;
  group: string;
  status: string;
  created: string;
  runningFor: string;
}

export function extractGroupFromName(name: string): string {
  // Pattern: nanoclaw-{safeName}-{epochMs}
  const match = /^nanoclaw-(.+)-\d{10,}$/.exec(name);
  return match ? match[1] : name;
}

export function parseContainerLine(line: string): ContainerResponse | null {
  if (!line.trim()) return null;
  try {
    const obj = JSON.parse(line);
    return {
      name: obj.Names,
      group: extractGroupFromName(obj.Names),
      status: obj.Status,
      created: obj.CreatedAt,
      runningFor: obj.RunningFor,
    };
  } catch {
    return null;
  }
}

export async function handleGetContainers(): Promise<ContainerResponse[]> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['ps', '--filter', 'name=nanoclaw-', '--format', '{{json .}}'],
      { timeout: 5000 },
    );
    return stdout
      .split('\n')
      .map(parseContainerLine)
      .filter((c): c is ContainerResponse => c !== null);
  } catch {
    return [];
  }
}
