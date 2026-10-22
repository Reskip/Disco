import { Typography } from 'antd';
import type { ComponentProps } from 'react';
import { type Components, type ExtraProps, Streamdown } from 'streamdown';
import { safeSourceUrl } from './knowledgePresentation';

function NoteLink({ href, children }: ComponentProps<'a'> & ExtraProps) {
  const safe = safeSourceUrl(href);
  return safe ? (
    <Typography.Link href={safe} target="_blank" rel="noreferrer">
      {children}
    </Typography.Link>
  ) : (
    <span>{children}</span>
  );
}

function NoteImage({ src, alt }: ComponentProps<'img'> & ExtraProps) {
  const href = typeof src === 'string' ? safeSourceUrl(src) : undefined;
  return href ? (
    <Typography.Link href={href} target="_blank" rel="noreferrer">
      查看图片：{alt || '图片'}
    </Typography.Link>
  ) : (
    <Typography.Text type="secondary">[图片：{alt || '请从关联附件查看'}]</Typography.Text>
  );
}

const NOTE_COMPONENTS: Components = { a: NoteLink, img: NoteImage };
const NOTE_ELEMENTS = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'strong',
  'em',
  'del',
  'a',
  'img',
  'pre',
  'code',
  'br',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
];

/** Imported/generated notes are untrusted. Media always requires a click. */
export function KnowledgeNoteContent({ markdown }: { markdown: string }) {
  return (
    <Typography style={{ overflowWrap: 'anywhere' }}>
      <Streamdown
        mode="static"
        parseIncompleteMarkdown={false}
        skipHtml
        allowedElements={NOTE_ELEMENTS}
        components={NOTE_COMPONENTS}
        controls={false}
        linkSafety={{ enabled: false }}
      >
        {markdown || '（正文为空）'}
      </Streamdown>
    </Typography>
  );
}
