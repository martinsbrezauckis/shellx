import assert from "node:assert/strict";
import {
  RELEASE_SBOM_CYCLONEDX_FORMAT,
  RELEASE_SBOM_SYFT_VERSION,
  normalizeReleaseSbom,
  validateSyftVersion,
} from "./generate-release-sbom";

assert.equal(
  RELEASE_SBOM_CYCLONEDX_FORMAT,
  "cyclonedx-json@1.6",
  "Syft output must pin CycloneDX 1.6 instead of following its moving default",
);

const sourceCommit = "a".repeat(40);
const artifactSha256 = "b".repeat(64);
const raw = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  serialNumber: "urn:uuid:11111111-1111-4111-8111-111111111111",
  metadata: {
    timestamp: "2026-08-10T00:00:00Z",
    tools: { components: [{ type: "application", name: "syft", version: "1.50.0" }] },
    component: { type: "file", name: "/fixture-private-root/worktree" },
  },
  components: [
    {
      "bom-ref": "pkg:cargo/shellx@0.3.5?package-id=root",
      type: "library",
      name: "shellx",
      version: "0.3.5",
      purl: "pkg:cargo/shellx@0.3.5",
      properties: [
        { name: "syft:location:0:path", value: "/src-tauri/Cargo.lock" },
        { name: "syft:package:language", value: "rust" },
      ],
    },
    {
      "bom-ref": "pkg:cargo/serde@1.0.0?package-id=serde",
      type: "library",
      name: "serde",
      version: "1.0.0",
      purl: "pkg:cargo/serde@1.0.0",
    },
    {
      "bom-ref": "pkg:npm/react@18.3.1",
      type: "library",
      name: "react",
      version: "18.3.1",
      purl: "pkg:npm/react@18.3.1",
    },
    {
      "bom-ref": "private-file",
      type: "file",
      name: "/fixture-private-root/shellx/pnpm-lock.yaml",
    },
  ],
  dependencies: [
    {
      ref: "pkg:cargo/shellx@0.3.5?package-id=root",
      dependsOn: ["pkg:cargo/serde@1.0.0?package-id=serde", "private-file"],
    },
  ],
};

const options = {
  artifactName: "windows/shellX_0.3.5_x64-setup.exe",
  artifactSha256,
  directNpmDependencies: ["react"],
  repositoryRoot: "/fixture-private-root/shellx",
  sourceCommit,
  version: "0.3.5",
};
const first = normalizeReleaseSbom(raw, options);
const second = normalizeReleaseSbom(raw, options);
assert.deepEqual(first, second, "normalized SBOM must be deterministic for the same artifact and source");
assert.equal(first.bomFormat, "CycloneDX");
assert.equal(first.specVersion, "1.6");
assert.match(String(first.serialNumber), /^urn:uuid:[0-9a-f-]{36}$/);

const serialized = JSON.stringify(first);
assert(!serialized.includes("/fixture-private-root"), "host-private paths must not survive normalization");
assert(!serialized.includes("private-file"), "file components and dependency references must be removed");
assert(!serialized.includes("2026-08-10T00:00:00Z"), "source timestamps must not survive normalization");

const metadata = first.metadata as { component: Record<string, unknown> };
assert.equal(metadata.component.type, "application");
assert.deepEqual(metadata.component.hashes, [{ alg: "SHA-256", content: artifactSha256 }]);
const rootProperties = metadata.component.properties as Array<{ name: string; value: string }>;
assert(rootProperties.some((property) => property.name === "shellx:source:commit" && property.value === sourceCommit));
assert(rootProperties.some((property) => property.name === "shellx:release:artifact" && property.value === options.artifactName));
assert(!rootProperties.some((property) => property.name.startsWith("syft:location:")));

const components = first.components as Array<Record<string, unknown>>;
assert.equal(components.length, 2);
assert(!components.some((component) => component.name === "shellx"), "root belongs in metadata.component only");
const dependencies = first.dependencies as Array<{ ref: string; dependsOn: string[] }>;
const root = dependencies.find((dependency) => dependency.ref.includes("pkg:cargo/shellx@"));
assert.deepEqual(root?.dependsOn, [
  "pkg:cargo/serde@1.0.0?package-id=serde",
  "pkg:npm/react@18.3.1",
]);

assert.throws(() => normalizeReleaseSbom(raw, { ...options, sourceCommit: "short" }), /full lowercase Git SHA-1/);
assert.throws(() => normalizeReleaseSbom(raw, { ...options, artifactName: "C:\\secret\\setup.exe" }), /safe release-root-relative/);
assert.throws(() => normalizeReleaseSbom(raw, { ...options, artifactName: "../private/setup.exe" }), /safe release-root-relative/);

const syftDirectoryRoot = structuredClone(raw);
const syftRoot = (syftDirectoryRoot.components as Array<Record<string, unknown>>)
  .find((component) => component.name === "shellx")!;
syftRoot["bom-ref"] = "d7dd284cf1693513";
delete syftRoot.purl;
syftRoot.properties = [
  { name: "syft:package:foundBy", value: "rust-cargo-lock-cataloger" },
  { name: "syft:package:language", value: "rust" },
  { name: "syft:package:type", value: "rust-crate" },
  { name: "syft:location:0:path", value: "/src-tauri/Cargo.lock" },
];
const syftRootDependency = (syftDirectoryRoot.dependencies as Array<Record<string, unknown>>)[0]!;
syftRootDependency.ref = "d7dd284cf1693513";
const normalizedDirectoryRoot = normalizeReleaseSbom(syftDirectoryRoot, options);
const normalizedMetadata = normalizedDirectoryRoot.metadata as { component: Record<string, unknown> };
assert.equal(normalizedMetadata.component.purl, "pkg:cargo/shellx@0.3.5");
assert(!JSON.stringify(normalizedDirectoryRoot).includes("syft:location:"));

validateSyftVersion({ application: "syft", version: RELEASE_SBOM_SYFT_VERSION });
assert.throws(() => validateSyftVersion({ application: "syft", version: "unversioned" }), /requires Syft 1\.50\.0/);

console.log("PASS release CycloneDX SBOM normalization tests");
