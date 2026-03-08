export const CONNECTOR_NPM_PACKAGE_SPEC = 'github:TwoTwo-me/codexUI#main'
export const CONNECTOR_BIN_NAME = 'codexui-connector'
const MASKED_TOKEN_PLACEHOLDER = '••••••••••••••••'

type ConnectorCommandInput = {
  command: 'install' | 'connect'
  hubAddress: string
  connectorId: string
  bootstrapToken?: string
  relayE2eeKeyId?: string
  tokenFilePath?: string
  allowInsecureHttp?: boolean
}

function getTokenFilePath(connectorId: string, tokenFilePath?: string): string {
  return tokenFilePath?.trim() || `$HOME/.codexui-connector/${connectorId}.token`
}

function getRunnerScriptPath(connectorId: string): string {
  return `$HOME/.config/codexui-connector/${connectorId}.sh`
}

function getSystemdUnitName(connectorId: string): string {
  return `codexui-connector-${connectorId}.service`
}

function createConnectorExecPrefix(): string[] {
  return [
    'npm',
    'exec',
    '--yes',
    `--package=${JSON.stringify(CONNECTOR_NPM_PACKAGE_SPEC)}`,
    '--',
    CONNECTOR_BIN_NAME,
  ]
}

export function createConnectorInstallCommand(input: Omit<ConnectorCommandInput, 'command'>): string {
  return createConnectorCommand({
    command: 'install',
    ...input,
  })
}

export function createConnectorConnectCommand(input: Omit<ConnectorCommandInput, 'command' | 'bootstrapToken'>): string {
  return createConnectorCommand({
    command: 'connect',
    ...input,
  })
}

export function createConnectorSystemdUserRegistrationCommand(
  input: Omit<ConnectorCommandInput, 'command' | 'bootstrapToken'>,
): string {
  const runnerScriptPath = getRunnerScriptPath(input.connectorId)
  const unitName = getSystemdUnitName(input.connectorId)
  const connectCommand = createConnectorConnectCommand(input)

  return [
    'mkdir -p "$HOME/.config/codexui-connector" "$HOME/.config/systemd/user"',
    `cat > ${JSON.stringify(runnerScriptPath)} <<'EOF'`,
    '#!/usr/bin/env bash',
    `exec ${connectCommand}`,
    'EOF',
    `chmod 700 ${JSON.stringify(runnerScriptPath)}`,
    `cat > "$HOME/.config/systemd/user/${unitName}" <<'EOF'`,
    '[Unit]',
    `Description=CodexUI Connector (${input.connectorId})`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=%h/.config/codexui-connector/${input.connectorId}.sh`,
    'Restart=always',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    'EOF',
    'systemctl --user daemon-reload',
    `systemctl --user enable --now ${unitName}`,
    'loginctl enable-linger "$USER"',
  ].join('\n')
}

export function createConnectorPm2RegistrationCommand(
  input: Omit<ConnectorCommandInput, 'command' | 'bootstrapToken'>,
): string {
  const runnerScriptPath = getRunnerScriptPath(input.connectorId)
  const pm2Name = `codexui-connector-${input.connectorId}`
  const connectCommand = createConnectorConnectCommand(input)

  return [
    'mkdir -p "$HOME/.config/codexui-connector"',
    `cat > ${JSON.stringify(runnerScriptPath)} <<'EOF'`,
    '#!/usr/bin/env bash',
    `exec ${connectCommand}`,
    'EOF',
    `chmod 700 ${JSON.stringify(runnerScriptPath)}`,
    'npm install -g pm2',
    `pm2 start ${JSON.stringify(runnerScriptPath)} --name ${JSON.stringify(pm2Name)}`,
    'pm2 save',
    'pm2 startup',
  ].join('\n')
}

export function createConnectorCommand(input: ConnectorCommandInput): string {
  const parts = [
    ...createConnectorExecPrefix(),
    input.command,
    `--hub ${JSON.stringify(input.hubAddress)}`,
    `--connector ${JSON.stringify(input.connectorId)}`,
  ]

  if (input.command === 'install') {
    const tokenFilePath = getTokenFilePath(input.connectorId, input.tokenFilePath)
    if (typeof input.bootstrapToken === 'string') {
      const inlineToken = input.bootstrapToken.length > 0 ? input.bootstrapToken : MASKED_TOKEN_PLACEHOLDER
      parts.push(`--token ${JSON.stringify(inlineToken)}`)
    }
    parts.push(`--token-file ${JSON.stringify(tokenFilePath)}`)
  } else {
    parts.push(`--token-file ${JSON.stringify(getTokenFilePath(input.connectorId, input.tokenFilePath))}`)
  }

  if (input.relayE2eeKeyId) {
    parts.push(`--key-id ${JSON.stringify(input.relayE2eeKeyId)}`)
    parts.push('--passphrase "<relay-passphrase>"')
  }

  if (input.allowInsecureHttp === true || input.hubAddress.startsWith('http://')) {
    parts.push('--allow-insecure-http')
  }

  return parts.join(' ')
}
