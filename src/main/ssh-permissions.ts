import { randomUUID } from 'crypto'
import { resolve } from 'path'
import { flushSettings, readSettings, updateSettings } from './settings'
import type {
  SshCommandApprovalDecision,
  SshCommandApprovalRequest,
  SshCommandPermission,
  SshDirectoryPolicy
} from '@shared/types'

type ApprovalHandler = (request: SshCommandApprovalRequest) => Promise<SshCommandApprovalDecision>

let approvalHandler: ApprovalHandler | null = null
let permissionsChanged: (() => void) | null = null
let approvalQueue: Promise<void> = Promise.resolve()

function directoryKey(directory: string): string {
  const absolute = resolve(directory)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

export function setSshCommandApprovalHandler(handler: ApprovalHandler): void {
  approvalHandler = handler
}

export function setSshPermissionsChangedHandler(handler: () => void): void {
  permissionsChanged = handler
}

export function getSshDirectoryPolicy(directory: string): SshDirectoryPolicy {
  const wanted = directoryKey(directory)
  const entry = Object.entries(readSettings().sshDirectoryPermissions || {}).find(
    ([configured]) => directoryKey(configured) === wanted
  )
  return entry?.[1] === 'always_allow' || entry?.[1] === 'deny' ? entry[1] : 'ask'
}

function findSavedCommand(request: SshCommandApprovalRequest): SshCommandPermission | undefined {
  const wantedDirectory = directoryKey(request.sourceDirectory)
  return (readSettings().sshCommandPermissions || []).find(
    (rule) =>
      directoryKey(rule.directory) === wantedDirectory &&
      rule.sshProfileId === request.sshProfileId &&
      rule.sshTarget === request.sshTarget &&
      rule.command === request.command
  )
}

function rememberCommand(request: SshCommandApprovalRequest): void {
  if (findSavedCommand(request)) return
  const rule: SshCommandPermission = {
    id: randomUUID(),
    directory: request.sourceDirectory,
    sshProfileId: request.sshProfileId,
    sshTarget: request.sshTarget,
    sshLabel: request.sshLabel,
    command: request.command,
    createdAt: Date.now()
  }
  updateSettings({
    sshCommandPermissions: [...(readSettings().sshCommandPermissions || []), rule]
  })
  flushSettings()
  permissionsChanged?.()
}

export async function authorizeSshCommand(
  request: SshCommandApprovalRequest
): Promise<'directory' | 'command' | 'once'> {
  const directoryPolicy = getSshDirectoryPolicy(request.sourceDirectory)
  if (directoryPolicy === 'deny') {
    throw new Error(`当前目录已禁止 Agent 操作 SSH：${request.sourceDirectory}`)
  }
  if (directoryPolicy === 'always_allow') return 'directory'
  if (findSavedCommand(request)) return 'command'
  if (!approvalHandler) throw new Error('SSH 命令审批界面尚未就绪')

  const pending = approvalQueue.then(() => approvalHandler!(request))
  approvalQueue = pending.then(
    () => undefined,
    () => undefined
  )
  const decision = await pending
  if (decision === 'deny') throw new Error('用户拒绝了 SSH 命令')
  if (decision === 'always_allow') {
    rememberCommand(request)
    return 'command'
  }
  return 'once'
}
