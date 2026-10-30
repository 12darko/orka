/**
 * Files that commonly hold credentials or keys. Once a task has read one, nothing goes to the
 * internet without the user seeing it (the secrets guard in the orchestrator and the ACP session).
 */
export const SECRET_FILE =
  /(^|[\\/])(\.env(\.[\w.-]+)?|[\w.-]*\.(pem|key|p12|pfx|jks|keystore|tfstate|tfvars)(\.backup)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json)?|secrets?\.(json|ya?ml|toml|env)|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.htpasswd|service-account[\w.-]*\.json|firebase-adminsdk[\w.-]*\.json|google-services\.json|GoogleService-Info\.plist|appsettings(\.[\w-]+)?\.json|local\.settings\.json|wp-config\.php|kubeconfig)$/i;

export function isSecretFile(filePath: string): boolean {
  return SECRET_FILE.test(filePath);
}

/** The secret-looking file a command line names (`cat .env`, `Get-Content secrets.json`), if any. */
export function secretInCommand(command: string): string | undefined {
  return command.split(/[\s"'|;&<>]+/).find((token) => SECRET_FILE.test(token));
}
