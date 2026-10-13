import { Evidence } from '../types';

export interface ParsedManifest {
  type: string;
  packages: { name: string; version: string; evidence: Evidence }[];
  scripts?: Record<string, string>;
  services?: string[];
  ports?: number[];
  environmentVars?: string[];
}

export function parsePackageJson(content: string, filePath = 'package.json'): ParsedManifest {
  const packages: { name: string; version: string; evidence: Evidence }[] = [];
  try {
    const json = JSON.parse(content);
    const allDeps = {
      ...(json.dependencies || {}),
      ...(json.devDependencies || {}),
    };

    for (const [name, version] of Object.entries(allDeps)) {
      packages.push({
        name,
        version: String(version).replace(/^[\^~>=<]+/, ''),
        evidence: {
          file: filePath,
          snippet: `"${name}": "${version}"`,
          type: 'manifest',
          description: `Declared dependency in ${filePath}`,
        },
      });
    }

    return {
      type: 'npm',
      packages,
      scripts: json.scripts,
    };
  } catch (err) {
    return { type: 'npm', packages: [] };
  }
}

export function parseRequirementsTxt(content: string, filePath = 'requirements.txt'): ParsedManifest {
  const packages: { name: string; version: string; evidence: Evidence }[] = [];
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const match = trimmed.match(/^([a-zA-Z0-9_\-\.]+)(?:[=><~]+([a-zA-Z0-9_\-\.]+))?/);
    if (match) {
      const name = match[1].toLowerCase();
      const version = match[2] || 'latest';
      packages.push({
        name,
        version,
        evidence: {
          file: filePath,
          line: idx + 1,
          snippet: trimmed,
          type: 'manifest',
          description: `Declared Python requirement in ${filePath}`,
        },
      });
    }
  });

  return { type: 'pip', packages };
}

export function parseDockerCompose(content: string, filePath = 'docker-compose.yml'): ParsedManifest {
  const services: string[] = [];
  const ports: number[] = [];
  const packages: { name: string; version: string; evidence: Evidence }[] = [];

  const lines = content.split('\n');
  let currentService = '';

  lines.forEach((line, idx) => {
    const matchService = line.match(/^ {2}([a-zA-Z0-9_\-]+):/);
    if (matchService && !line.includes('version:') && !line.includes('services:')) {
      currentService = matchService[1];
      services.push(currentService);
    }

    const matchImage = line.match(/image:\s*([a-zA-Z0-9_\-\.\/]+)(?::([a-zA-Z0-9_\-\.]+))?/);
    if (matchImage) {
      const img = matchImage[1];
      const ver = matchImage[2] || 'latest';
      packages.push({
        name: img,
        version: ver,
        evidence: {
          file: filePath,
          line: idx + 1,
          snippet: line.trim(),
          type: 'config',
          description: `Container image for service '${currentService || img}'`,
        },
      });
    }

    const matchPort = line.match(/["']?(\d+):(\d+)["']?/);
    if (matchPort) {
      ports.push(parseInt(matchPort[1], 10));
    }
  });

  return {
    type: 'docker-compose',
    packages,
    services,
    ports,
  };
}

export function parseGoMod(content: string, filePath = 'go.mod'): ParsedManifest {
  const packages: { name: string; version: string; evidence: Evidence }[] = [];
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    const match = line.trim().match(/^([a-zA-Z0-9_\-\.\/]+)\s+v([a-zA-Z0-9_\-\.]+)/);
    if (match) {
      packages.push({
        name: match[1],
        version: match[2],
        evidence: {
          file: filePath,
          line: idx + 1,
          snippet: line.trim(),
          type: 'manifest',
          description: `Go module dependency`,
        },
      });
    }
  });

  return { type: 'go', packages };
}
