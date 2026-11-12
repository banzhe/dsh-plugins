import { expect, it } from 'vitest'
import { buildChangeTree } from '../src/client/tree.ts'

it('nests a changed file under its path segments', () => {
  expect(buildChangeTree([{ path: 'src/panel/GitPanel.tsx', status: 'modified' }])).toEqual([
    {
      name: 'src',
      children: [
        {
          name: 'panel',
          children: [{ name: 'GitPanel.tsx', children: [], status: 'modified' }],
        },
      ],
    },
  ])
})

it('drops empty path segments', () => {
  const trimmed = buildChangeTree([{ path: 'a/b.txt', status: 'added' }])
  expect(buildChangeTree([{ path: '/a//b.txt', status: 'added' }])).toEqual(trimmed)
  expect(buildChangeTree([{ path: 'a//b.txt', status: 'added' }])).toEqual(trimmed)
})

it('keeps the first status when one path appears twice', () => {
  const tree = buildChangeTree([
    { path: 'notes.md', status: 'modified' },
    { path: 'notes.md', status: 'deleted' },
  ])
  expect(tree).toEqual([{ name: 'notes.md', children: [], status: 'modified' }])
})

it('orders every level by name', () => {
  const tree = buildChangeTree([
    { path: 'b.ts', status: 'modified' },
    { path: 'z-dir/x.ts', status: 'added' },
    { path: 'a.ts', status: 'deleted' },
    { path: 'a-dir/y.ts', status: 'untracked' },
    { path: 'a-dir/a-inner.ts', status: 'modified' },
  ])
  expect(tree.map(node => node.name)).toEqual(['a-dir', 'a.ts', 'b.ts', 'z-dir'])
  const directory = tree[0]
  expect(directory?.children.map(node => node.name)).toEqual(['a-inner.ts', 'y.ts'])
})

it('answers an empty tree when nothing changed', () => {
  expect(buildChangeTree([])).toEqual([])
})
