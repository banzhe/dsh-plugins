import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { GitPanel, GitTitle } from './GitPanel.tsx'
import { en, NS, zh } from './locales.ts'

/** Tab kind this package owns. A page type: opened by kind, no resource address. */
const GIT_KIND = 'git'

/** This implementation's identity in the tab system, and the key its body registers under. */
const GIT_ID = '@banzhe/dsh-git'

export const inject = ['slots', 'locale', 'sidebarRightTabs']

interface TabDefinition {
  readonly id: string
  readonly kind: string
  readonly priority: 'builtin'
  readonly title: () => string
  readonly guide: readonly {
    readonly id: string
    readonly order: number
    readonly title: () => string
    readonly description: () => string
    readonly icon: typeof IconBranchOutlineRegular
  }[]
}

interface SidebarRightTabs {
  register(definition: TabDefinition): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sidebarRightTabs: SidebarRightTabs
  }
}

/** The git type's registry definition. Labels are read fresh on every call. */
function gitDefinition(t: (key: 'type.label' | 'guide.title' | 'guide.description') => string): TabDefinition {
  return {
    id: GIT_ID,
    kind: GIT_KIND,
    priority: 'builtin',
    title: () => t('type.label'),
    guide: [{
      id: 'workspace',
      order: 40,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
      icon: IconBranchOutlineRegular,
    }],
  }
}

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register(gitDefinition(t)), 'git: tab type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'git: dictionaries')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: GIT_ID,
    locale: NS,
  }, GitPanel)), 'git: tab body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: GIT_ID,
  }, GitTitle)), 'git: tab title')
}
