import { stringify } from "yaml";
import type { JobManifest, SecretManifest } from "./job-spec.js";

export function renderManifestYaml(
  secret: SecretManifest,
  job: JobManifest,
): string {
  return [
    stringify(secret, { directives: false }).trimEnd(),
    stringify(job, { directives: false }).trimEnd(),
    "",
  ].join("\n---\n");
}

export function redactSecretToken(secret: SecretManifest): SecretManifest {
  return {
    ...secret,
    stringData: {
      ...secret.stringData,
      RUN_TOKEN: "REDACTED",
    },
  };
}
