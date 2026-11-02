'use client'

import { type ClipboardEvent, type ReactNode, useState } from 'react'

import { textToAdf } from '@/lib/jira/adf'

import { type AdfNode, splitMarkdownDod } from '@/lib/jira/markdown'

/**
 * An ADF document as Jira shows it: headings, marks, nested lists, code,
 * tables, quotes. Used for an issue's description on the board and for the
 * preview while composing one, so what is previewed is what Jira gets.
 * Unknown nodes fall back to their children, or their text.
 */
export function AdfView({ doc, className = '' }: { doc: unknown; className?: string }) {
  const root = doc as AdfNode | null
  const nodes = root && typeof root === 'object' && Array.isArray(root.content) ? root.content : []
  return <div className={'text-[12.5px] leading-relaxed ' + className}>{nodes.map(block)}</div>
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

function block(n: AdfNode, key: number): ReactNode {
  const kids = () => (n.content ?? []).map(block)
  switch (n.type) {
    case 'paragraph':
      return (
        <p key={key} className="mb-2 last:mb-0">
          {inline(n.content)}
        </p>
      )
    case 'heading': {
      const level = Number(n.attrs?.level) || 3
      const size = level <= 1 ? 'text-[15px]' : level === 2 ? 'text-[14px]' : 'text-[13px]'
      return (
        <div key={key} role="heading" aria-level={level} className={`mb-1.5 mt-3 font-semibold first:mt-0 ${size}`}>
          {inline(n.content)}
        </div>
      )
    }
    case 'bulletList':
      return (
        <ul key={key} className="mb-2 flex list-disc flex-col gap-1 pl-5 last:mb-0 [&_ul]:mb-0 [&_ul]:mt-1 [&_ol]:mb-0 [&_ol]:mt-1">
          {kids()}
        </ul>
      )
    case 'orderedList':
      return (
        <ol key={key} start={Number(n.attrs?.order) || 1} className="mb-2 flex list-decimal flex-col gap-1 pl-5 last:mb-0 [&_ul]:mb-0 [&_ul]:mt-1 [&_ol]:mb-0 [&_ol]:mt-1">
          {kids()}
        </ol>
      )
    case 'listItem':
      return <li key={key} className="[&>p]:mb-0">{kids()}</li>
    case 'taskList':
      return (
        <ul key={key} className="mb-2 flex flex-col gap-1 last:mb-0">
          {(n.content ?? []).map((t, i) => (
            <li key={i}>
              {t.attrs?.state === 'DONE' ? '☑' : '☐'} {inline(t.content)}
            </li>
          ))}
        </ul>
      )
    case 'codeBlock':
      return (
        <pre key={key} className="mb-2 overflow-x-auto rounded-md bg-surface-2 px-2.5 py-2 font-mono text-[11.5px] leading-[1.55] last:mb-0">
          <code>{(n.content ?? []).map((t) => t.text ?? '').join('')}</code>
        </pre>
      )
    case 'blockquote':
    case 'panel':
      return (
        <blockquote key={key} className="mb-2 border-l-[3px] border-line-strong pl-3 text-ink-2 last:mb-0">
          {kids()}
        </blockquote>
      )
    case 'rule':
      return <hr key={key} className="my-3 border-line" />
    case 'table':
      return (
        <div key={key} className="mb-2 overflow-x-auto last:mb-0">
          <table className="border-collapse text-[12px]">
            <tbody>{kids()}</tbody>
          </table>
        </div>
      )
    case 'tableRow':
      return <tr key={key}>{kids()}</tr>
    case 'tableHeader':
      return (
        <th key={key} className="border border-line bg-surface-2 px-2 py-1 text-left font-semibold [&>p]:mb-0">
          {kids()}
        </th>
      )
    case 'tableCell':
      return (
        <td key={key} className="border border-line px-2 py-1 align-top [&>p]:mb-0">
          {kids()}
        </td>
      )
    default:
      return n.content ? <div key={key}>{kids()}</div> : <span key={key}>{n.text ?? ''}</span>
  }
}

function inline(nodes: AdfNode[] | undefined): ReactNode[] {
  return (nodes ?? []).map((n, i) => {
    switch (n.type) {
      case 'text': {
        let out: ReactNode = n.text ?? ''
        let href = ''
        for (const m of n.marks ?? []) {
          if (m.type === 'code') out = <code className="rounded bg-surface-2 px-1 font-mono text-[11.5px]">{out}</code>
          else if (m.type === 'strong') out = <strong className="font-semibold">{out}</strong>
          else if (m.type === 'em') out = <em>{out}</em>
          else if (m.type === 'strike') out = <s>{out}</s>
          else if (m.type === 'underline') out = <u>{out}</u>
          else if (m.type === 'link') href = str(m.attrs?.href)
        }
        return href && /^https?:\/\//.test(href) ? (
          <a key={i} href={href} target="_blank" rel="noreferrer" className="text-accent-ink underline underline-offset-2">
            {out}
          </a>
        ) : (
          <span key={i}>{out}</span>
        )
      }
      case 'hardBreak':
        return <br key={i} />
      case 'mention':
        return <span key={i} className="text-accent-ink">{str(n.attrs?.text) || '@người dùng'}</span>
      case 'emoji':
        return <span key={i}>{str(n.attrs?.text) || str(n.attrs?.shortName)}</span>
      case 'inlineCard': {
        const url = str(n.attrs?.url)
        return (
          <a key={i} href={url} target="_blank" rel="noreferrer" className="text-accent-ink underline underline-offset-2">
            {url}
          </a>
        )
      }
      default:
        return <span key={i}>{n.text ?? inline(n.content)}</span>
    }
  })
}

/**
 * Paste handler for a Description box: a whole task pasted in — description,
 * then a "Definition of Done" / "DoD" heading, then the DoD — is split across
 * the two boxes. The description part replaces the selection as a normal
 * paste would; the DoD part fills the DoD box, or goes under what is there.
 * Anything without such a heading pastes as usual.
 */
export function pasteSplitsDod(
  e: ClipboardEvent<HTMLTextAreaElement>,
  setDescription: (v: string) => void,
  dod: string,
  setDod: (v: string) => void,
) {
  const parts = splitMarkdownDod(e.clipboardData.getData('text/plain'))
  if (!parts) return
  e.preventDefault()
  const el = e.currentTarget
  setDescription(el.value.slice(0, el.selectionStart) + parts.description + el.value.slice(el.selectionEnd))
  if (parts.dod) setDod(dod.trim() ? `${dod.trimEnd()}\n${parts.dod}` : parts.dod)
}

/** Under a Markdown box: what it understands, in one line. */
export const MARKDOWN_HINT = 'Markdown: # tiêu đề, **đậm**, _nghiêng_, `code`, ```khối code```, - / 1. danh sách (thụt lề để lồng), | bảng |, [link](url), > trích dẫn'

/**
 * "Xem trước": the two boxes rendered as Jira will show them — the same
 * conversion the create / save calls run, so nothing differs on Jira.
 */
export function MarkdownPreview({ description, dod }: { description: string; dod: string }) {
  const [open, setOpen] = useState(false)
  if (!description.trim() && !dod.trim()) return null
  return (
    <div className="mt-2">
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-[11.5px] text-accent-ink underline underline-offset-2" title={MARKDOWN_HINT}>
        {open ? 'Ẩn xem trước' : 'Xem trước như trên Jira'}
      </button>
      {open && (
        <div className="mt-1.5 rounded-md border border-dashed border-line-strong bg-surface px-3 py-2.5">
          <AdfView doc={textToAdf(description, dod)} />
        </div>
      )}
    </div>
  )
}
