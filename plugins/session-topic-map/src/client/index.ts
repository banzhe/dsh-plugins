import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { IconWorkspaceTreeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { en, NS, zh } from './locales.ts'
import { SessionTopicMapBody, SessionTopicMapTitle } from './TopicMapPanel.tsx'

/** A page type: opened by kind, no resource address. */
const TOPIC_MAP_KIND = 'session-topic-map'

/** This implementation's identity in the tab system, and the key its body registers under. */
const TOPIC_MAP_ID = '@banzhe/dsh-session-topic-map'

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
    readonly icon: typeof IconWorkspaceTreeOutlineRegular
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

/** Labels are read fresh on every call. */
function topicMapDefinition(t: (key: 'type.label' | 'guide.title' | 'guide.description') => string): TabDefinition {
  return {
    id: TOPIC_MAP_ID,
    kind: TOPIC_MAP_KIND,
    priority: 'builtin',
    title: () => t('type.label'),
    guide: [{
      id: 'session',
      order: 50,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
      icon: IconWorkspaceTreeOutlineRegular,
    }],
  }
}

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register(topicMapDefinition(t)), 'session-topic-map: tab type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-topic-map: dictionaries')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: TOPIC_MAP_ID,
    locale: NS,
  }, SessionTopicMapBody)), 'session-topic-map: tab body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: TOPIC_MAP_ID,
  }, SessionTopicMapTitle)), 'session-topic-map: tab title')
}
