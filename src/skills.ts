import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

/**
 * Skills follow the SKILL.md format used by Claude Code / Agent Skills: a folder with a SKILL.md whose
 * YAML frontmatter has `name` and `description`, plus optional references/, scripts/ and assets.
 */
export interface Skill {
  name: string;
  description: string;
  category: string;
  dir: string;
  source: 'proyecto' | 'usuario' | 'claude' | 'incluida';
}

export const USER_SKILLS_DIR = path.join(os.homedir(), '.puertoline', 'skills');

function parseFrontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    // Folded / literal block scalars: collect the indented lines that follow.
    if (/^[>|][-+]?$/.test(value)) {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      value = parts.join(' ');
    }
    out[kv[1]] = value.replace(/^["']|["']$/g, '');
  }
  return out;
}

async function findSkillFiles(root: string, depth = 3): Promise<string[]> {
  const found: string[] = [];
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) return [path.join(root, 'SKILL.md')];
  if (depth === 0) return found;
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
      found.push(...(await findSkillFiles(path.join(root, e.name), depth - 1)));
    }
  }
  return found;
}

export class SkillRegistry {
  private skills = new Map<string, Skill>();
  private loaded?: Promise<void>;

  constructor(private readonly bundledDir: string) {}

  invalidate(): void {
    this.loaded = undefined;
  }

  async all(): Promise<Skill[]> {
    this.loaded ??= this.load();
    await this.loaded;
    const disabled = new Set(vscode.workspace.getConfiguration('puertoline').get<string[]>('disabledSkills') ?? []);
    return [...this.skills.values()].filter((s) => !disabled.has(s.name)).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }

  async get(name: string): Promise<Skill | undefined> {
    return (await this.all()).find((s) => s.name === name);
  }

  private async load(): Promise<void> {
    const skills = new Map<string, Skill>();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // Lowest precedence first; later sources override skills with the same name.
    const sources: [string, Skill['source']][] = [[this.bundledDir, 'incluida']];
    // Claude Code's personal skills often rely on Claude-only connectors, so they're opt-in.
    if (vscode.workspace.getConfiguration('puertoline').get<boolean>('includeClaudeSkills')) {
      sources.push([path.join(os.homedir(), '.claude', 'skills'), 'claude']);
    }
    sources.push([USER_SKILLS_DIR, 'usuario']);
    if (root) {
      sources.push([path.join(root, '.claude', 'skills'), 'proyecto'], [path.join(root, '.puertoline', 'skills'), 'proyecto']);
    }
    for (const [dir, source] of sources) {
      for (const file of await findSkillFiles(dir)) {
        try {
          const fm = parseFrontmatter(await fs.readFile(file, 'utf8'));
          const skillDir = path.dirname(file);
          const name = fm.name || path.basename(skillDir);
          const rel = path.relative(dir, skillDir).split(path.sep);
          skills.set(name, {
            name,
            description: fm.description ?? '',
            category: source === 'incluida' && rel.length > 1 ? rel[0] : source,
            dir: skillDir,
            source,
          });
        } catch {
          /* unreadable skill: skip */
        }
      }
    }
    this.skills = skills;
  }

  /** Short catalogue for the system prompt. */
  async catalogue(): Promise<string> {
    const list = await this.all();
    if (!list.length) return '';
    const byCat = new Map<string, Skill[]>();
    for (const s of list) byCat.set(s.category, [...(byCat.get(s.category) ?? []), s]);
    let out = '';
    for (const [cat, items] of byCat) {
      out += `\n[${cat}]\n` + items.map((s) => `- ${s.name}: ${s.description.slice(0, 220)}`).join('\n');
    }
    return out;
  }

  /** Content for the use_skill tool: SKILL.md (or one of its files) plus the list of supporting files. */
  async read(name: string, file?: string): Promise<string> {
    const skill = await this.get(name);
    if (!skill) {
      const names = (await this.all()).map((s) => s.name).join(', ');
      throw new Error(`No existe la skill "${name}". Disponibles: ${names}`);
    }
    if (file) {
      const abs = path.resolve(skill.dir, file);
      if (path.relative(skill.dir, abs).startsWith('..')) throw new Error('Ruta fuera de la skill');
      return fs.readFile(abs, 'utf8');
    }
    const body = await fs.readFile(path.join(skill.dir, 'SKILL.md'), 'utf8');
    const files = (await listFiles(skill.dir)).filter((f) => f !== 'SKILL.md' && !/^LICENSE/i.test(f));
    return (
      `# Skill: ${skill.name}\nCarpeta de la skill (para ejecutar sus scripts con run_command): ${skill.dir}\n\n${body}` +
      (files.length
        ? `\n\n---\nArchivos de apoyo (léelos con use_skill y el parámetro "file" solo si los necesitas):\n${files.slice(0, 80).join('\n')}`
        : '')
    );
  }
}

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(path.join(dir, e.name), rel)));
    else out.push(rel);
  }
  return out;
}

/**
 * Installs every skill found in a GitHub repo (or a subfolder of it) into ~/.puertoline/skills.
 * Accepts "owner/repo", "owner/repo/path/inside" or a github.com URL.
 */
export async function installFromGitHub(spec: string, log: (m: string) => void): Promise<string[]> {
  const m = spec
    .trim()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/tree\/[^/]+/, '')
    .match(/^([\w.-]+)\/([\w.-]+)(?:\/(.+))?$/);
  if (!m) throw new Error('Formato esperado: usuario/repositorio o usuario/repositorio/carpeta');
  const [, owner, repo, sub] = m;

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'puertoline-skills-'));
  try {
    await run('git', ['clone', '--depth', '1', `https://github.com/${owner}/${repo}.git`, tmp], log);
    const base = sub ? path.join(tmp, sub) : tmp;
    const files = await findSkillFiles(base, 4);
    if (!files.length) throw new Error('No se encontró ningún SKILL.md en ese repositorio.');

    let license = '';
    for (const l of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
      try {
        license = await fs.readFile(path.join(tmp, l), 'utf8');
        break;
      } catch {
        /* try next */
      }
    }

    const installed: string[] = [];
    const dest = path.join(USER_SKILLS_DIR, `${owner}-${repo}`);
    for (const f of files) {
      const src = path.dirname(f);
      const target = path.join(dest, path.basename(src));
      await fs.rm(target, { recursive: true, force: true });
      await fs.cp(src, target, { recursive: true });
      if (license) await fs.writeFile(path.join(target, 'LICENSE.txt'), license, { flag: 'wx' }).catch(() => undefined);
      installed.push(path.basename(src));
    }
    return installed;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

function run(cmd: string, args: string[], log: (m: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { shell: false });
    p.stderr.on('data', (d) => log(d.toString().trimEnd()));
    p.on('error', (e) => reject(new Error(`No se pudo ejecutar ${cmd}: ${e.message}. ¿Está Git instalado?`)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} terminó con código ${code}`))));
  });
}
