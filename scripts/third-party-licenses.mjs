// 번들(dist/index.cjs)에 실제로 들어간 제3자 패키지의 라이선스를 모아 THIRD-PARTY-LICENSES를 만든다.
// 사용법: node scripts/third-party-licenses.mjs <esbuild metafile 경로>
// 빌드 도구의 침해 범위를 늘리지 않도록 Node 표준 모듈만 쓴다.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_FILE = join(PROJECT_ROOT, 'THIRD-PARTY-LICENSES');
const NODE_MODULES = 'node_modules/';
const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying)/i;
const SEPARATOR = '-'.repeat(80);

// 이중 라이선스 패키지는 택한 라이선스와 그 원문 파일만 적는다(PRD §3).
const LICENSE_CHOICES = {
  '@zone-eu/mailsplit': { license: 'MIT', file: 'LICENSE.MIT' },
};

// metafile 입력 경로(예: node_modules/a/node_modules/@s/b/lib/x.js)에서 가장 안쪽 패키지 폴더를 찾는다.
function packageDirOf(inputPath) {
  const start = inputPath.lastIndexOf(NODE_MODULES);
  if (start < 0) return null;
  const nameStart = start + NODE_MODULES.length;
  const parts = inputPath.slice(nameStart).split('/');
  const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  return inputPath.slice(0, nameStart) + name;
}

function formatPerson(person) {
  if (typeof person === 'string') return person;
  return [person.name, person.email && `<${person.email}>`, person.url && `(${person.url})`]
    .filter(Boolean)
    .join(' ');
}

// 줄바꿈을 맞춰 Windows와 Linux에서 같은 파일이 나오게 한다.
function readText(path) {
  return readFileSync(path, 'utf8').replace(/\r\n?/g, '\n').trimEnd();
}

function collectPackage(packageDir) {
  const absoluteDir = join(PROJECT_ROOT, packageDir);
  const manifest = JSON.parse(readFileSync(join(absoluteDir, 'package.json'), 'utf8'));
  const choice = LICENSE_CHOICES[manifest.name];
  const licenseFiles = choice
    ? [choice.file]
    : readdirSync(absoluteDir).filter((file) => LICENSE_FILE_PATTERN.test(file)).sort();
  const declared = typeof manifest.license === 'string' ? manifest.license : manifest.license?.type;
  if (!declared && licenseFiles.length === 0) {
    throw new Error(`라이선스 정보가 없습니다: ${manifest.name}@${manifest.version} (${packageDir})`);
  }
  return {
    name: manifest.name,
    version: manifest.version,
    declared,
    chosen: choice?.license,
    people: [manifest.author, ...(manifest.contributors ?? [])].filter(Boolean).map(formatPerson),
    texts: licenseFiles.map((file) => readText(join(absoluteDir, file))),
  };
}

function renderPackage(pkg) {
  const lines = [SEPARATOR, `${pkg.name}@${pkg.version}`, `라이선스: ${pkg.declared ?? '(표기 없음)'}`];
  if (pkg.chosen) {
    lines.push(`택한 라이선스: ${pkg.chosen} (이 패키지는 ${pkg.declared} 가운데 하나를 고를 수 있으며, 이 배포판은 이 조건으로 사용합니다)`);
  }
  if (pkg.texts.length > 0) {
    lines.push('', ...pkg.texts.join('\n\n').split('\n'));
    return lines.join('\n');
  }
  lines.push('LICENSE 파일이 없어 패키지 정보에 적힌 내용을 적습니다.');
  if (pkg.people.length > 0) lines.push(`저작권자: ${pkg.people.join(', ')}`);
  return lines.join('\n');
}

function main() {
  const metafilePath = process.argv[2];
  if (!metafilePath) throw new Error('사용법: node scripts/third-party-licenses.mjs <metafile 경로>');
  const metafile = JSON.parse(readFileSync(metafilePath, 'utf8'));

  // metafile.inputs에는 읽기만 하고 트리 셰이킹으로 빠진 파일도 있어, 출력에 실제로 들어간 바이트가 있는 입력만 본다.
  const packageDirs = new Set();
  for (const output of Object.values(metafile.outputs)) {
    for (const [inputPath, { bytesInOutput }] of Object.entries(output.inputs)) {
      const packageDir = packageDirOf(inputPath);
      if (packageDir && bytesInOutput > 0) packageDirs.add(packageDir);
    }
  }

  const packages = new Map();
  for (const packageDir of packageDirs) {
    const pkg = collectPackage(packageDir);
    packages.set(`${pkg.name}@${pkg.version}`, pkg);
  }
  const sorted = [...packages.values()].sort((a, b) =>
    a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1,
  );

  const header = [
    '제3자 라이선스 고지: korean-mail-mcp',
    '',
    `아래 ${sorted.length}개 패키지의 코드가 dist/index.cjs 파일에 들어 있습니다. 빌드할 때 자동으로 만드는 파일입니다.`,
  ].join('\n');
  writeFileSync(OUTPUT_FILE, `${[header, ...sorted.map(renderPackage)].join('\n\n')}\n`);

  const withoutText = sorted.filter((pkg) => pkg.texts.length === 0);
  for (const pkg of withoutText) {
    console.warn(`LICENSE 파일이 없는 패키지: ${pkg.name}@${pkg.version} (${pkg.declared})`);
  }
  console.log(`THIRD-PARTY-LICENSES: 패키지 ${sorted.length}개`);
}

main();
