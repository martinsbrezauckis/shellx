import { buildVerifiedUpdaterManifestFromArgv } from "./generate-updater-manifest";

const { result } = buildVerifiedUpdaterManifestFromArgv(process.argv.slice(2));
for (const line of result.included) console.log(`verified ${line}`);
console.log(`verified ${Object.keys(result.manifest.platforms).length} updater platform signature(s)`);
