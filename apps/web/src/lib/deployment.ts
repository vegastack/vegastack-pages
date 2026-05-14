export type DeploymentMode = "self_hosted" | "managed";

export function deploymentMode(): DeploymentMode {
  return process.env.VPG_DEPLOYMENT_MODE === "managed"
    ? "managed"
    : "self_hosted";
}

export function publicSignupEnabled() {
  return (
    deploymentMode() === "managed" || process.env.VPG_PUBLIC_SIGNUP === "true"
  );
}
