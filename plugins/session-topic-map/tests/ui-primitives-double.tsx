import { createElement, type JSX } from 'react'

export function IconWorkspaceTreeOutlineRegular(props: { size?: number; className?: string }): JSX.Element {
  return createElement('svg', {
    'data-icon': 'workspace-tree-outline',
    className: props.className,
    width: props.size ?? 16,
    height: props.size ?? 16,
  })
}
