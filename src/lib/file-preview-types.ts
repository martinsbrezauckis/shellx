export type PreviewKind = "markdown" | "html" | "code" | "image" | "video" | "pdf" | "text" | "unknown";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v", "mkv"]);
const TEXT_EXTS = new Set(["txt", "log", "csv", "tsv"]);

const CODE_EXTS = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
  "rs", "py", "go", "java", "kt", "swift",
  "json", "jsonc", "json5", "toml", "yaml", "yml", "xml",
  "css", "scss", "vue", "svelte", "astro", "mdx",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "sql", "graphql", "gql", "proto", "lua", "rb",
  "c", "cc", "cpp", "cxx", "h", "hpp", "hh", "cs", "php",
  "dockerfile", "makefile", "mk", "env", "envfile", "nix",
  "ini", "conf", "cfg", "editorconfig", "npmrc", "yarnrc",
  "tf", "tfvars", "hcl",
  "diff", "patch",
  "dart", "ex", "exs", "erl", "hrl", "fs", "fsx",
  "r", "jl", "zig", "nim",
  "rst", "adoc",
  "lock",
]);

const CODE_BASENAMES = new Set([
  "dockerfile",
  "makefile",
  "rakefile",
  "gemfile",
  "podfile",
  "justfile",
  "taskfile",
  "codeowners",
  ".gitignore",
  ".gitattributes",
  ".dockerignore",
  ".npmrc",
  ".yarnrc",
  ".editorconfig",
]);

const SHIKI_BY_EXT: Record<string, string> = {
  rs: "rust",
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  fish: "fish",
  ps1: "powershell",
  bat: "batch",
  cmd: "batch",
  json: "json",
  jsonc: "jsonc",
  json5: "json5",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sql: "sql",
  xml: "xml",
  dockerfile: "dockerfile",
  makefile: "makefile",
  mk: "makefile",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  envfile: "dotenv",
  env: "dotenv",
  ini: "ini",
  conf: "ini",
  cfg: "ini",
  editorconfig: "ini",
  npmrc: "ini",
  yarnrc: "ini",
  tf: "terraform",
  tfvars: "terraform",
  hcl: "terraform",
  nix: "nix",
  diff: "diff",
  patch: "diff",
  graphql: "graphql",
  gql: "graphql",
  proto: "proto",
  dart: "dart",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hrl: "erlang",
  fs: "fsharp",
  fsx: "fsharp",
  r: "r",
  jl: "julia",
  zig: "zig",
  nim: "nim",
  lua: "lua",
  rst: "rst",
  adoc: "asciidoc",
};

function stripDecorations(path: string): string {
  return (path.split(/[?#]/, 1)[0] ?? "")
    .replace(/:\d+(?::\d+)?$/, "");
}

function basename(path: string): string {
  const clean = stripDecorations(path);
  return clean.split(/[\\/]/).pop() ?? clean;
}

function extensionOf(path: string): string {
  const name = basename(path).toLowerCase();
  if (name.endsWith(".d.ts")) return "d.ts";
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0) return name;
  return name.slice(lastDot + 1);
}

function codeNameKind(name: string): boolean {
  if (CODE_BASENAMES.has(name)) return true;
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (name.startsWith("dockerfile.")) return true;
  if (name.startsWith("makefile.")) return true;
  if (name.endsWith(".lock")) return true;
  return false;
}

export function previewKindForPath(path: string): PreviewKind {
  const name = basename(path).toLowerCase();
  const ext = extensionOf(path);

  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (ext === "pdf") return "pdf";
  if (ext === "d.ts" || CODE_EXTS.has(ext) || codeNameKind(name)) return "code";
  if (TEXT_EXTS.has(ext)) return "text";
  return "unknown";
}

export function shouldReadTextForPreviewKind(kind: PreviewKind): boolean {
  return kind === "markdown" || kind === "html" || kind === "code" || kind === "text";
}

export function shikiLangForPath(path: string): string | null {
  const name = basename(path).toLowerCase();
  if (name === ".env" || name.startsWith(".env.")) return "dotenv";
  if (name === "codeowners") return "codeowners";
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if (name === "makefile" || name.startsWith("makefile.")) return "makefile";
  if (name === ".npmrc" || name === ".yarnrc" || name === ".editorconfig") return "ini";
  if (name === "compose.yaml" || name === "compose.yml" || name.startsWith("docker-compose.")) return "yaml";
  if (name === "package-lock.json") return "json";
  if (name === "pnpm-lock.yaml") return "yaml";
  if (name === "nginx.conf") return "nginx";
  if (name.endsWith(".d.ts")) return "typescript";

  const ext = extensionOf(path);
  return SHIKI_BY_EXT[ext] ?? null;
}
