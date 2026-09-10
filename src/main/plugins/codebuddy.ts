import os from 'node:os'
import path from 'node:path'
import { createBuddyPlugin } from './_lib/tencent-buddy'

export const codebuddyPlugin = createBuddyPlugin({
  appType: 'codebuddy',
  name: 'CodeBuddy',
  envKey: 'CODEBUDDY_DIR',
  defaultRoot: path.join(os.homedir(), '.codebuddy', 'projects'),
  tildeRoot: '~/.codebuddy/projects'
})
