import os from 'node:os'
import path from 'node:path'
import { createBuddyPlugin } from './_lib/tencent-buddy'

export const workbuddyPlugin = createBuddyPlugin({
  appType: 'workbuddy',
  name: 'WorkBuddy',
  envKey: 'WORKBUDDY_DIR',
  defaultRoot: path.join(os.homedir(), '.workbuddy', 'projects'),
  tildeRoot: '~/.workbuddy/projects'
})
